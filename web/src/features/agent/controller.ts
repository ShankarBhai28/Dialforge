// The agent's call workflow, in one place and free of React so it can be
// tested with a fake phone. Ported from the classic agent page:
//
// - Click-to-call: the server rings the agent's own line first; that ring is
//   answered automatically (the agent just asked for it), then the customer
//   rings - "Ringing customer…" until the server says they answered.
// - Queue / dialer calls: auto-answer or an Accept/Reject popup (per
//   campaign); once answered, ask the server which lead it is (screen pop).
// - A colleague consulting us: shown as an offer until they complete the
//   transfer, then it becomes our call.
// - When a lead call ends: the outcome dialog. After saving it, auto-dial
//   campaigns put the agent back to Available after the wrap-up time.
// - Preview campaigns: claim the next lead whenever the agent is free.
import { ApiError, get, post } from '@/lib/api';
import type { QueryClient } from '@tanstack/react-query';
import { agentKeys, type ActiveCall, type AgentStats, type CampaignInfo, type Lead, type PreviewState } from './api';
import type { Softphone, SoftphoneEvent } from './softphone/softphone';

export type CallInfo = {
  number: string;
  name: string;
  kind: string;
  callId: number | null;
  /** Click-to-call: our leg is up but the customer hasn't answered yet. */
  ringingCustomer: boolean;
  /** When talk time starts (customer answered) - may be later than the SIP answer. */
  talkStartedAt: number | null;
};

export type Workspace = {
  /** Lead whose details + form are open (null = form without a lead). */
  lead: Lead | null;
  callId: number | null;
  /** "Saving against: …" */
  contextText: string;
  /** The empty workspace was opened on purpose ("Open form without a lead"). */
  blankOpen: boolean;
  /** Bumped when the form should be reset / pre-filled again. */
  formVersion: number;
};

export type ControllerState = {
  queue: { id: number; name: string } | null;
  queuePickerOpen: boolean;
  /** Ringing call waiting for Accept / Reject. */
  incoming: { number: string; name: string } | null;
  call: CallInfo | null;
  workspace: Workspace;
  /** Lead whose call just ended - the outcome dialog is open for it. */
  outcomeFor: Lead | null;
  message: { text: string; error: boolean } | null;
  preview: PreviewState;
  previewBusy: boolean;
  /** Seconds until the automatic return to Available (auto-dial campaigns). */
  autoAvailableAt: number | null;
};

type Deps = {
  phone: Softphone;
  queryClient: QueryClient;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
};

const QUEUE_KEY = 'dialforge.agent.queue';
const emptyWorkspace = (v = 0): Workspace => ({
  lead: null,
  callId: null,
  contextText: '',
  blankOpen: false,
  formVersion: v,
});
const describe = (lead: { name?: string | null }, phone: string) =>
  lead.name ? `${lead.name} (${phone})` : `Lead ${phone}`;

export class AgentController {
  private state: ControllerState;
  private listeners = new Set<() => void>();
  private readonly phone: Softphone;
  private readonly qc: QueryClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly storage: Deps['storage'];

  // Workflow flags (not shown on screen).
  private expectingOwnLeg = false;
  /** Lead that gets the outcome dialog when the current call ends. */
  private outcomeLead: Lead | null = null;
  private pendingCall: CallInfo | null = null;
  private watchingCallId: number | null = null;
  private wrapupTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatus: AgentStats['currentStatus'] = null;
  private unsubscribe: () => void;

  constructor({ phone, queryClient, sleep, storage }: Deps) {
    this.phone = phone;
    this.qc = queryClient;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.storage = storage === undefined ? safeSessionStorage() : storage;
    this.state = {
      queue: this.loadQueue(),
      queuePickerOpen: false,
      incoming: null,
      call: null,
      workspace: emptyWorkspace(),
      outcomeFor: null,
      message: null,
      preview: { enabled: false },
      previewBusy: false,
      autoAvailableAt: null,
    };
    this.unsubscribe = phone.onEvent((e) => void this.onPhoneEvent(e));
  }

  dispose() {
    this.unsubscribe();
    this.clearWrapup();
  }

  // --- React bindings ---
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  private set(patch: Partial<ControllerState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private setCall(patch: Partial<CallInfo>) {
    if (this.state.call) this.set({ call: { ...this.state.call, ...patch } });
  }
  say(text: string, error = false) {
    this.set({ message: { text, error } });
  }
  private refresh(...keys: (keyof typeof agentKeys)[]) {
    for (const k of keys) void this.qc.invalidateQueries({ queryKey: agentKeys[k] });
  }

  // --- Phone events ---
  private async onPhoneEvent(e: SoftphoneEvent) {
    if (e.type === 'incoming') {
      if (this.expectingOwnLeg) {
        // Our own click-to-call leg ringing back: the agent asked for it.
        this.expectingOwnLeg = false;
        this.set({ call: this.pendingCall ?? { ...this.callFromRemote(e.call.remote), kind: 'Outbound call' } });
        this.pendingCall = null;
        this.phone.answer();
        return;
      }
      this.outcomeLead = null;
      this.set({ call: { ...this.callFromRemote(e.call.remote), kind: 'Incoming call' } });
      let autoAnswer = false;
      try {
        autoAnswer = (await get<{ autoAnswer: boolean }>('/agent/call-policy')).autoAnswer;
      } catch {
        // Unknown policy: let the agent decide.
      }
      if (this.phone.getSnapshot().call?.id !== e.call.id) return; // caller gave up meanwhile
      if (autoAnswer) this.phone.answer();
      else this.set({ incoming: e.call.remote });
      return;
    }
    if (e.type === 'answered') {
      this.set({ incoming: null });
      const call = this.state.call;
      if (call && !call.callId && call.kind === 'Incoming call') {
        this.setCall({ talkStartedAt: Date.now() });
        void this.screenPop();
      } else if (call?.callId) {
        void this.watchCustomerAnswer(call.callId);
      }
      this.refresh('control');
      return;
    }
    // ended
    this.watchingCallId = null;
    this.set({ incoming: null, call: null });
    if (this.outcomeLead) {
      this.set({ outcomeFor: this.outcomeLead });
      this.outcomeLead = null;
      this.refresh('dispositions');
    }
    this.refresh('calls', 'stats');
  }

  private callFromRemote(remote: { number: string; name: string }): CallInfo {
    return { ...remote, kind: '', callId: null, ringingCustomer: false, talkStartedAt: null };
  }

  /** Incoming popup buttons. */
  accept() {
    this.set({ incoming: null });
    this.phone.answer();
  }
  reject() {
    this.set({ incoming: null });
    this.phone.reject();
  }
  hangup() {
    this.phone.hangup();
  }

  // --- Click-to-call ---
  async callLead(lead: Lead | null, phone: string) {
    if (this.phone.getSnapshot().call) return this.say('Finish the current call first.', true);
    this.say(`Calling ${phone}...`);
    this.expectingOwnLeg = true;
    this.outcomeLead = lead;
    this.openWorkspace(lead, null, describe(lead ?? {}, phone));
    this.pendingCall = {
      number: phone,
      name: lead?.name ?? '',
      kind: 'Outbound call',
      callId: null,
      ringingCustomer: true,
      talkStartedAt: null,
    };
    try {
      const { callId } = await post<{ callId: number }>('/calls/click2call', {
        toNumber: phone,
        leadId: lead?.id ?? null,
      });
      this.set({ workspace: { ...this.state.workspace, callId } });
      if (this.pendingCall) this.pendingCall = { ...this.pendingCall, callId };
      else if (this.state.call) {
        this.setCall({ callId });
        if (this.phone.getSnapshot().call?.phase === 'live') void this.watchCustomerAnswer(callId);
      }
      this.say(`Call started (id ${callId}) — your line rings first, then the customer.`);
      void this.watchOwnLeg(callId);
    } catch (err) {
      this.say(`Call failed: ${(err as Error).message}`, true);
      this.pendingCall = null;
      this.outcomeLead = null;
      this.expectingOwnLeg = false;
    }
    setTimeout(() => this.refresh('calls', 'stats'), 2000);
  }

  /**
   * Until our own line rings: if the server gives up on it first (line not
   * registered, answer too slow), say so and reset instead of waiting forever.
   */
  private async watchOwnLeg(callId: number) {
    // Still waiting for *this* call's leg (pendingCall is cleared when it rings).
    const waiting = () => this.expectingOwnLeg && this.pendingCall?.callId === callId;
    // Asterisk gives up on an unanswered line after 30 s; stop looking after ~45.
    for (let i = 0; i < 30; i++) {
      await this.sleep(1500);
      if (!waiting()) return;
      let st: CallState | null = null;
      try {
        st = await get<CallState>('/agent/call-state/' + callId);
      } catch {
        continue;
      }
      if (st.ended && waiting()) break;
    }
    if (!waiting()) return;
    this.expectingOwnLeg = false;
    this.pendingCall = null;
    this.outcomeLead = null;
    this.say(endedMessage('agent_unanswered'), true);
    this.refresh('calls');
  }

  /** "Ringing customer…" until the server sees the customer answer (or the call fails). */
  private async watchCustomerAnswer(callId: number) {
    if (this.watchingCallId === callId) return;
    this.watchingCallId = callId;
    this.setCall({ ringingCustomer: true });
    while (this.state.call && this.watchingCallId === callId) {
      let st: CallState | null = null;
      try {
        st = await get<CallState>('/agent/call-state/' + callId);
      } catch {
        st = null;
      }
      if (this.watchingCallId !== callId) return;
      if (!st || st.answered || st.ended) {
        this.setCall({ ringingCustomer: false, talkStartedAt: st?.answered ? Date.now() : null });
        if (st?.ended && !st.answered) this.say(endedMessage(st.disposition), true);
        return;
      }
      await this.sleep(1000);
    }
  }

  // --- Screen pop for queue / dialer / transferred calls ---
  private async screenPop() {
    for (let i = 0; i < 8; i++) {
      let call: ActiveCall | null = null;
      try {
        call = await get<ActiveCall | null>('/agent/active-call');
      } catch {
        call = null;
      }
      if (!this.state.call) return;
      if (call) {
        const lead: Lead = { ...call, id: call.lead_id };
        this.openWorkspace(lead, call.call_id, describe(call, call.phone));
        const name = call.name ?? '';
        if (!call.owner) {
          // A colleague is consulting us / adding us before handing it over.
          this.setCall({ number: call.phone, name, kind: 'Transfer offered by a colleague', callId: call.call_id });
          this.say(`Transfer offered: ${name} ${call.phone}`.trim());
          void this.waitForOwnership(call.call_id, lead);
          return;
        }
        this.outcomeLead = lead;
        this.setCall({
          number: call.phone,
          name,
          kind: call.from_dialer ? 'Dialer call' : 'Transferred call',
          callId: call.call_id,
        });
        this.say(
          `${call.from_dialer ? 'Dialer call' : 'Call'}: ${name} ${call.phone} · attempts ${call.attempts}${call.list_name ? ' · list ' + call.list_name : ''}`,
        );
        return;
      }
      await this.sleep(500);
    }
  }

  /** Once the colleague completes the transfer the call is ours (and gets our outcome). */
  private async waitForOwnership(callId: number, lead: Lead) {
    while (this.state.call) {
      await this.sleep(2000);
      if (!this.state.call) return;
      let call: ActiveCall | null = null;
      try {
        call = await get<ActiveCall | null>('/agent/active-call');
      } catch {
        continue;
      }
      if (!call || call.call_id !== callId) return;
      if (call.owner) {
        this.outcomeLead = lead;
        this.setCall({ kind: 'Transferred call' });
        this.say(`Transfer completed - ${call.name || call.phone} is now your call`);
        return;
      }
    }
  }

  // --- Workspace (lead details + form) ---
  private openWorkspace(lead: Lead | null, callId: number | null, contextText: string) {
    this.set({
      workspace: {
        lead,
        callId,
        contextText,
        blankOpen: false,
        formVersion: this.state.workspace.formVersion + 1,
      },
    });
  }
  selectLead(lead: Lead) {
    const ws = this.state.workspace;
    if (this.state.call && ws.lead && ws.lead.id !== lead.id) {
      return this.say('Finish the current call before opening another lead.', true);
    }
    if (ws.lead?.id === lead.id) return;
    this.openWorkspace(lead, ws.lead ? ws.callId : null, describe(lead, lead.phone));
  }
  openBlankForm() {
    this.set({ workspace: { ...emptyWorkspace(this.state.workspace.formVersion + 1), blankOpen: true } });
  }
  closeWorkspace() {
    if (this.state.call) return this.say('The call is still live.', true);
    this.set({ workspace: emptyWorkspace(this.state.workspace.formVersion + 1) });
  }
  /** After the form is saved: the classic page closed the lead too. */
  formSaved() {
    this.set({ workspace: emptyWorkspace(this.state.workspace.formVersion + 1) });
    this.say('Form saved.');
  }

  // --- Status + queue ---
  async setStatus(status: 'available' | 'break', reason?: string) {
    this.clearWrapup();
    if (status === 'available' && !this.state.queue) {
      // The first Available of the session needs a queue; it's remembered after.
      this.set({ queuePickerOpen: true });
      return;
    }
    await this.postStatus(status, reason ?? null);
  }

  private async postStatus(status: 'available' | 'break', reason: string | null) {
    try {
      await post('/agent/status', { status, reason, queueId: this.state.queue?.id ?? null });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && status === 'available') {
        // The queue's campaign was unmapped from the agent's team mid-session.
        this.say(err.message || 'This queue is no longer available to you.', true);
        this.saveQueue(null);
        this.set({ queuePickerOpen: true });
        return;
      }
      this.say((err as Error).message, true);
      return;
    }
    this.refresh('stats');
  }

  closeQueuePicker() {
    this.set({ queuePickerOpen: false });
  }

  async selectQueue(queue: { id: number; name: string }) {
    this.saveQueue(queue);
    this.set({ queuePickerOpen: false });
    await this.postStatus('available', null);
    // A different queue can mean a different campaign: leads, form and outcomes change.
    this.refresh('dispositions', 'leads', 'form', 'callbacks');
  }

  private loadQueue(): ControllerState['queue'] {
    try {
      const v = this.storage?.getItem(QUEUE_KEY);
      return v ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  }
  private saveQueue(queue: ControllerState['queue']) {
    try {
      if (queue) this.storage?.setItem(QUEUE_KEY, JSON.stringify(queue));
      else this.storage?.removeItem(QUEUE_KEY);
    } catch {
      /* private mode */
    }
    this.set({ queue });
  }

  // --- Outcome (disposition) ---
  async saveOutcome(
    leadId: number,
    status: string,
    extra?: { callbackAt: string; callbackMine: boolean; note: string },
  ) {
    await post(`/leads/${leadId}/disposition`, { status, ...(extra ?? {}) });
    this.set({ outcomeFor: null });
    this.refresh('leads', 'callbacks');
    await this.scheduleAutoAvailable();
  }

  /** Auto-dial campaigns need agents back promptly: Available again after wrap-up. */
  private async scheduleAutoAvailable() {
    this.clearWrapup();
    let info: CampaignInfo = null;
    try {
      info = await get<CampaignInfo>('/agent/campaign-info');
    } catch {
      return;
    }
    if (!info || !['progressive', 'predictive'].includes(info.dialMode)) return;
    this.say(`Back to Available in ${info.wrapupSec}s…`);
    this.set({ autoAvailableAt: Date.now() + info.wrapupSec * 1000 });
    this.wrapupTimer = setTimeout(async () => {
      this.wrapupTimer = null;
      this.set({ autoAvailableAt: null });
      let stats: AgentStats | null = null;
      try {
        stats = await get<AgentStats>('/agent/stats');
      } catch {
        return;
      }
      // Only if nothing else changed the status meanwhile.
      if (stats.currentStatus === 'acw' && this.state.queue) await this.postStatus('available', null);
    }, info.wrapupSec * 1000);
  }
  private clearWrapup() {
    if (this.wrapupTimer) clearTimeout(this.wrapupTimer);
    this.wrapupTimer = null;
    if (this.state.autoAvailableAt) this.set({ autoAvailableAt: null });
  }

  // --- Preview mode ---
  private agentIsFree(status: AgentStats['currentStatus']) {
    return (
      status === 'available' &&
      !this.phone.getSnapshot().call &&
      !this.outcomeLead &&
      !this.state.outcomeFor &&
      !this.expectingOwnLeg
    );
  }

  /** Called with each fresh stats poll. Claims the next preview lead when the agent is free. */
  async onStats(stats: AgentStats) {
    this.lastStatus = stats.currentStatus;
    await this.refreshPreview();
  }

  async refreshPreview() {
    if (this.state.previewBusy) return;
    let preview: PreviewState;
    try {
      preview = await get<PreviewState>('/agent/preview');
    } catch {
      return;
    }
    if (preview.enabled && !preview.lead && !preview.blocker && this.agentIsFree(this.lastStatus)) {
      this.set({ previewBusy: true });
      try {
        const next = await post<{ lead: PreviewState['lead']; blocker?: string }>('/agent/preview/next');
        preview = { ...preview, lead: next.lead ?? null, blocker: next.blocker ?? null };
      } catch (err) {
        preview = { ...preview, lead: null, blocker: (err as Error).message };
      } finally {
        this.set({ previewBusy: false });
      }
    }
    this.set({ preview });
  }

  async previewDial() {
    const lead = this.state.preview.lead;
    if (!lead || this.state.previewBusy) return;
    this.set({ preview: { ...this.state.preview, lead: null }, previewBusy: true });
    try {
      await this.callLead(lead, lead.phone);
    } finally {
      this.set({ previewBusy: false });
    }
  }

  async previewSkip() {
    if (this.state.previewBusy) return;
    this.set({ previewBusy: true });
    try {
      await post('/agent/preview/skip');
      this.set({ preview: { ...this.state.preview, lead: null } });
    } catch (err) {
      this.say((err as Error).message, true);
    } finally {
      this.set({ previewBusy: false });
    }
    this.lastStatus = 'available';
    await this.refreshPreview();
  }

  /** Logout: drop the call and the line, forget the queue. */
  shutdown() {
    this.phone.hangup();
    this.phone.disconnect();
    this.saveQueue(null);
    this.clearWrapup();
  }
}

type CallState = { answered: boolean; ended: boolean; disposition: string | null };

/** Why a click-to-call ended before anyone talked (calls.disposition). */
export function endedMessage(disposition: string | null) {
  switch (disposition) {
    case 'agent_unanswered':
      return "Your line didn't answer, so the call was not placed. Check the line is connected (refresh the page to reconnect) and try again.";
    case 'busy':
      return 'The customer is busy.';
    case 'no_answer':
      return "The customer didn't answer.";
    case 'rejected':
      return 'The customer rejected the call.';
    case 'invalid_number':
      return 'That number is not reachable - check it.';
    case 'congestion':
      return 'The network is busy - try again in a moment.';
    default:
      return 'The call could not be connected.';
  }
}

function safeSessionStorage() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
