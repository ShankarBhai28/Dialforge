// Customer history: everything that happened with one lead, newest first -
// calls (who talked, how long, how it ended, the outcome and note,
// recorded?), form answers, callbacks, edits - plus a summary and the
// latest form answers. Shown on the agent screen (live call, preview, a
// clicked lead) and on the admin side (Leads -> History).
//
// A call belongs to the lead by calls.lead_id; calls made before a number
// was linked (dialpad, old inbound) are found by the lead's numbers.
const { diffCustom } = require('./leadData');
/** A value as the history shows it (lists joined). */
const shown = (v) => (v == null ? null : Array.isArray(v) ? v.join(', ') : String(v));
const pool = require('../../db');
const { normalizePhone } = require('../../dialer-common');
const { RESULT_LABELS, outcomeLabel } = require('./reports/common');

/**
 * The lead behind a phone number: in this campaign first, else the newest
 * lead with that number anywhere. Null when none.
 */
async function findLeadByPhone(phone, campaignId, deps = { pool }) {
  const p = normalizePhone(phone);
  if (!p) return null;
  const [rows] = await deps.pool.query(
    `SELECT id FROM leads
     WHERE (phone = ? OR alt_phone = ?) AND deleted_at IS NULL
     ORDER BY campaign_id <=> ? DESC, id DESC LIMIT 1`,
    [p, p, campaignId || null],
  );
  return rows[0] ? rows[0].id : null;
}

const MAX_ITEMS = 200;

function callResult(c) {
  if (c.agent_connect_time) return 'Answered';
  if (c.disposition) return RESULT_LABELS[c.disposition] || c.disposition;
  return c.end_time ? 'Not answered' : 'In progress';
}

/** Readable form answers: [{ label, value }] in the form's field order. */
function formAnswers(data, fields) {
  const values = typeof data === 'string' ? JSON.parse(data) : data || {};
  const known = fields.map((f) => ({ label: f.label, value: values[f.field_key] }));
  const extra = Object.keys(values)
    .filter((k) => !fields.some((f) => f.field_key === k))
    .map((k) => ({ label: k, value: values[k] }));
  return [...known, ...extra]
    .filter((a) => a.value !== undefined && a.value !== null && a.value !== '')
    .map((a) => ({ label: a.label, value: Array.isArray(a.value) ? a.value.join(', ') : String(a.value) }));
}

const json = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

/** Lead fields worth showing when an admin edited them. */
const EDIT_FIELDS = { name: 'Name', phone: 'Phone', alt_phone: 'Alt phone', priority: 'Priority', status: 'Status' };

/**
 * The full history of one customer: this lead plus every other lead with
 * the same number (active or deleted) the viewer may see. `recordingUrl(callId)`:
 * where the player fetches a call's recording (admin or agent route); omitted
 * = no player. `canSee(campaignId)`: which other leads the viewer may see
 * (default all). `ownCallsBy`: an agent's id - their own calls with this
 * customer show even from a lead they can't see.
 */
async function leadHistory(
  leadId,
  { recordingUrl = null, canSee = () => true, ownCallsBy = null } = {},
  deps = { pool },
) {
  const db = deps.pool;
  const [[lead]] = await db.query(
    `SELECT l.id, l.name, l.phone, l.alt_phone, l.status, l.attempts, l.is_final, l.next_call_at, l.created_at, l.deleted_at,
            l.custom_data, l.campaign_id, c.name AS campaign, li.name AS list
     FROM leads l LEFT JOIN campaigns c ON c.id = l.campaign_id LEFT JOIN lists li ON li.id = l.list_id
     WHERE l.id = ?`,
    [leadId],
  );
  if (!lead) return null;
  // Calls keep the number as dialed / received (919..., 0..., +91...).
  const numbers = [lead.phone, lead.alt_phone]
    .map(normalizePhone)
    .filter(Boolean)
    .flatMap((n) => [n, `91${n}`, `0${n}`, `+91${n}`]);

  // Other leads with the same number - deleted ones (its list was deleted,
  // the number came back) and active ones (e.g. in another campaign): their
  // calls, outcomes, forms and callbacks are this customer's story too, as
  // far as the viewer may see them.
  const plain = [lead.phone, lead.alt_phone].map(normalizePhone).filter(Boolean);
  const [others] = plain.length
    ? await db.query(
        `SELECT l.id, l.name, l.created_at, l.deleted_at, l.campaign_id, c.name AS campaign
         FROM leads l LEFT JOIN campaigns c ON c.id = l.campaign_id
         WHERE l.id <> ? AND (l.phone IN (?) OR l.alt_phone IN (?))
         ORDER BY l.id DESC LIMIT 20`,
        [leadId, plain, plain],
      )
    : [[]];
  const earlier = others.filter((o) => canSee(o.campaign_id));
  const hidden = others.filter((o) => !canSee(o.campaign_id)).map((o) => o.id);
  const leadIds = [leadId, ...earlier.map((e) => e.id)];
  const earlierById = new Map(
    earlier.map((e) => [e.id, { id: e.id, name: e.name, campaign: e.campaign || null, deleted: !!e.deleted_at }]),
  );
  // An agent's own call from a lead they can't see: shown, without that lead's details.
  for (const id of hidden) earlierById.set(id, { id, name: null, campaign: null, deleted: false });
  const earlierOf = (id) => earlierById.get(Number(id)) || null;
  const ownHidden = ownCallsBy && hidden.length ? hidden : null;

  const [calls] = await db.query(
    `SELECT ca.id, ca.lead_id, ca.direction, ca.start_time, ca.end_time, ca.agent_connect_time, ca.disposition, ca.outcome,
            ca.campaign_id, ca.from_extension, ca.did, ca.recording_path IS NOT NULL AS recorded,
            u.username AS agent, cd.label AS outcome_label,
            IF(ca.agent_connect_time IS NULL, NULL,
               GREATEST(TIMESTAMPDIFF(SECOND, ca.agent_connect_time, COALESCE(ca.end_time, ca.agent_connect_time)), 0)) AS talk_seconds,
            EXISTS (SELECT 1 FROM call_events e WHERE e.call_id = ca.id
                    AND e.event_type IN ('transferred', 'transferred_to_queue')) AS transferred
     FROM calls ca
     LEFT JOIN users u ON u.id = ca.agent_user_id
     LEFT JOIN campaign_dispositions cd ON cd.campaign_id = ca.campaign_id AND cd.code = ca.outcome
     WHERE ca.lead_id IN (?) OR (ca.lead_id IS NULL AND ca.to_number IN (?))
        ${ownHidden ? 'OR (ca.lead_id IN (?) AND ca.agent_user_id = ?)' : ''}
     ORDER BY ca.id DESC LIMIT ?`,
    [leadIds, numbers.length ? numbers : [''], ...(ownHidden ? [ownHidden, ownCallsBy] : []), MAX_ITEMS],
  );

  // The agent's outcomes (audit log): note / callback time, and outcomes
  // given without a call. "<code> (call <id>)" ties one to its call.
  const [outcomes] = await db.query(
    `SELECT a.at, a.username, a.summary, a.request_json, a.entity_id FROM audit_log a
     WHERE a.action = 'leads.outcome' AND a.entity = 'leads' AND a.entity_id IN (?) AND (a.status IS NULL OR a.status = 200)
     ORDER BY a.id DESC LIMIT ?`,
    [leadIds, MAX_ITEMS],
  );
  const [edits] = await db.query(
    `SELECT a.at, a.username, a.action, a.summary, a.before_json, a.after_json FROM audit_log a
     WHERE a.entity = 'leads' AND a.entity_id = ? AND a.action IN ('leads.edit', 'leads.update') AND a.status = 200
     ORDER BY a.id DESC LIMIT 50`,
    [leadId],
  );
  const [forms] = await db.query(
    `SELECT r.id, r.lead_id, r.form_id, r.call_id, r.created_at, r.data, r.changes, f.name AS form, u.username AS agent
     FROM form_responses r JOIN forms f ON f.id = r.form_id LEFT JOIN users u ON u.id = r.user_id
     WHERE r.lead_id IN (?) ORDER BY r.id DESC LIMIT 50`,
    [leadIds],
  );
  const formIds = [...new Set(forms.map((f) => f.form_id))];
  const [fields] = formIds.length
    ? await db.query('SELECT form_id, field_key, label FROM form_fields WHERE form_id IN (?) ORDER BY sort_order, id', [
        formIds,
      ])
    : [[]];
  // Labels of the lead's campaign form, for "what changed" in the history.
  const [labelRows] = lead.campaign_id
    ? await db.query(
        'SELECT ff.field_key, ff.label FROM campaigns c JOIN form_fields ff ON ff.form_id = c.form_id WHERE c.id = ?',
        [lead.campaign_id],
      )
    : [[]];
  const labelOf = new Map(labelRows.map((r) => [r.field_key, r.label]));
  const changeList = (list, labels = labelOf) =>
    list.map((c) => ({ field: labels.get(c.key) || c.key, from: shown(c.from), to: shown(c.to) }));
  const [callbacks] = await db.query(
    `SELECT cb.id, cb.lead_id, cb.callback_at, cb.status, cb.note, cb.created_at, cu.username AS created_by, ou.username AS owner
     FROM callbacks cb LEFT JOIN users cu ON cu.id = cb.created_by LEFT JOIN users ou ON ou.id = cb.user_id
     WHERE cb.lead_id IN (?) ORDER BY cb.id DESC LIMIT 50`,
    [leadIds],
  );

  // Calls from before the agent was recorded on the call show the extension.
  for (const c of calls) if (!c.agent && c.from_extension) c.agent = `ext ${c.from_extension}`;

  // --- the timeline ---
  const callIds = new Set(calls.map((c) => c.id));
  const outcomeByCall = new Map();
  const timeline = [];
  for (const o of outcomes) {
    const m = / \(call (\d+)\)$/.exec(o.summary || '');
    const req = json(o.request_json) || {};
    const code = (o.summary || '').split(' ')[0];
    const detail = { by: o.username, note: req.note || null, callbackAt: req.callbackAt || null };
    if (m && callIds.has(Number(m[1]))) {
      if (!outcomeByCall.has(Number(m[1]))) outcomeByCall.set(Number(m[1]), detail);
    } else {
      timeline.push({
        type: 'outcome',
        at: o.at,
        agent: o.username,
        outcome: outcomeLabel(code, null),
        ...detail,
        earlierLead: earlierOf(o.entity_id),
      });
    }
  }
  for (const c of calls) {
    const o = outcomeByCall.get(c.id);
    timeline.push({
      type: 'call',
      at: c.start_time,
      callId: c.id,
      direction: c.direction,
      agent: c.agent || null,
      extension: c.from_extension,
      result: callResult(c),
      talkSeconds: c.talk_seconds == null ? null : Number(c.talk_seconds),
      outcome: c.outcome ? outcomeLabel(c.outcome, c.outcome_label) : null,
      note: o ? o.note : null,
      callbackAt: o ? o.callbackAt : null,
      transferred: !!Number(c.transferred),
      recorded: !!Number(c.recorded),
      earlierLead: earlierOf(c.lead_id),
      ...(recordingUrl && Number(c.recorded) ? { recordingUrl: recordingUrl(c.id) } : {}),
    });
  }
  const fieldsByForm = {};
  for (const f of fields) (fieldsByForm[f.form_id] = fieldsByForm[f.form_id] || []).push(f);
  const answered = forms.map((f) => ({
    type: 'form',
    at: f.created_at,
    agent: f.agent,
    form: f.form,
    callId: f.call_id,
    answers: formAnswers(f.data, fieldsByForm[f.form_id] || []),
    // What this save changed (saves from before 0012 have only the answers).
    changes: f.changes
      ? changeList(json(f.changes) || [], new Map((fieldsByForm[f.form_id] || []).map((x) => [x.field_key, x.label])))
      : null,
    earlierLead: earlierOf(f.lead_id),
  }));
  timeline.push(...answered);
  for (const cb of callbacks) {
    timeline.push({
      type: 'callback',
      at: cb.created_at,
      agent: cb.created_by,
      due: cb.callback_at,
      status: cb.status,
      owner: cb.owner || null,
      note: cb.note,
      earlierLead: earlierOf(cb.lead_id),
    });
  }
  for (const e of edits) {
    const before = json(e.before_json) || {};
    const after = json(e.after_json) || {};
    const changes = Object.entries(EDIT_FIELDS)
      .filter(([k]) => k in after && String(before[k] ?? '') !== String(after[k] ?? ''))
      .map(([k, label]) => ({ field: label, from: before[k] ?? null, to: after[k] ?? null }));
    // The form fields too (the lead's current values).
    if ('custom_data' in after)
      changes.push(
        ...changeList(
          diffCustom(before.custom_data, after.custom_data).filter((c) => !(c.key === 'name' && 'name' in after)),
        ),
      );
    // An upload that updated the lead says which file.
    const source = e.action === 'leads.update' && /^upload /.test(e.summary || '') ? e.summary : null;
    if (changes.length) timeline.push({ type: 'edit', at: e.at, agent: e.username, changes, source });
  }
  timeline.push({ type: 'created', at: lead.created_at, campaign: lead.campaign, list: lead.list });
  for (const e of earlier) {
    timeline.push({
      type: 'created',
      at: e.created_at,
      campaign: e.campaign || null,
      list: null,
      earlierLead: earlierOf(e.id),
    });
    if (e.deleted_at) timeline.push({ type: 'deleted', at: e.deleted_at, earlierLead: earlierOf(e.id) });
  }
  timeline.sort((a, b) => new Date(b.at) - new Date(a.at));

  // --- summary ---
  const talked = calls.filter((c) => c.agent_connect_time);
  const lastTalk = talked[0] || null;
  return {
    lead: {
      id: lead.id,
      name: lead.name,
      phone: lead.phone,
      altPhone: lead.alt_phone,
      status: lead.status,
      attempts: lead.attempts,
      final: !!lead.is_final,
      nextCallAt: lead.next_call_at,
      campaign: lead.campaign,
      list: lead.list,
      createdAt: lead.created_at,
      /** Deleted (e.g. with its list): history only, no more calls. */
      deletedAt: lead.deleted_at || null,
      customData: json(lead.custom_data),
    },
    summary: {
      calls: calls.length,
      answered: talked.length,
      talkSeconds: talked.reduce((s, c) => s + Number(c.talk_seconds || 0), 0),
      lastCallAt: calls[0] ? calls[0].start_time : null,
      lastSpokeWith: lastTalk ? lastTalk.agent : null,
      lastSpokeAt: lastTalk ? lastTalk.start_time : null,
      lastOutcome: calls.find((c) => c.outcome)
        ? outcomeLabel(calls.find((c) => c.outcome).outcome, calls.find((c) => c.outcome).outcome_label)
        : null,
      agents: [...new Set(talked.map((c) => c.agent).filter(Boolean))],
      pendingCallback: callbacks.find((c) => c.status === 'pending')
        ? { due: callbacks.find((c) => c.status === 'pending').callback_at }
        : null,
    },
    latestForm: answered[0]
      ? { form: answered[0].form, at: answered[0].at, agent: answered[0].agent, answers: answered[0].answers }
      : null,
    // The last answers saved with each form (raw, by field key): the agent
    // screen fills the form with them instead of starting empty.
    formData: Object.fromEntries(
      [...forms].reverse().map((f) => [f.form_id, { data: json(f.data) || {}, at: f.created_at, agent: f.agent }]),
    ),
    timeline: timeline.slice(0, MAX_ITEMS),
  };
}

/**
 * May this agent open this lead (details, history, recordings)? A lead of
 * the campaign they're working (or of no campaign), or one they have
 * talked to before. Admin logins on the agent screen may.
 */
async function agentCanSeeLead(user, lead, findCurrentCampaign, deps = { pool }) {
  if (user.role !== 'agent') return true;
  // Given to an agent: theirs; another agent sees it only if they talked to the customer (below).
  if (lead.assigned_user_id && lead.assigned_user_id === user.id) return true;
  const campaign = await findCurrentCampaign(user.id);
  if (!lead.assigned_user_id && (!lead.campaign_id || (campaign && campaign.id === lead.campaign_id))) return true;
  const ext = user.extensionName || '';
  const [mine] = await deps.pool.query(
    'SELECT 1 FROM calls WHERE lead_id = ? AND (agent_user_id = ? OR from_extension = ? OR transfer_ext = ?) LIMIT 1',
    [lead.id, user.id, ext, ext],
  );
  return mine.length > 0;
}

/**
 * The most recent deleted lead with this number (phone or alt phone):
 * who it was, when and by whom it was deleted, whether its list went with
 * it, its last outcome. Null when none.
 */
async function deletedLeadFor(phone, deps = { pool }) {
  const p = normalizePhone(phone);
  if (!p) return null;
  const [rows] = await deps.pool.query(
    `SELECT l.id, l.name, l.campaign_id, l.status, l.alt_phone, l.custom_data, l.priority, l.deleted_at,
            u.username AS deleted_by, ls.name AS list, ls.deleted_at AS list_deleted_at, c.name AS campaign
     FROM leads l
     LEFT JOIN users u ON u.id = l.deleted_by
     LEFT JOIN lists ls ON ls.id = l.list_id
     LEFT JOIN campaigns c ON c.id = l.campaign_id
     WHERE l.deleted_at IS NOT NULL AND (l.phone = ? OR l.alt_phone = ?)
     ORDER BY l.deleted_at DESC, l.id DESC LIMIT 1`,
    [p, p],
  );
  return rows[0] || null;
}

/**
 * Before an agent calls a typed number: is it on the DNC list, has it an
 * active lead, or did it only belong to a deleted lead (then the screen
 * asks "call anyway?"). Details of the deleted lead only if the agent may
 * see it (agentCanSeeLead); the warning itself always.
 */
async function numberCheck(phone, user, { isDnc, findCurrentCampaign }, deps = { pool }) {
  const p = normalizePhone(phone);
  if (!p) return { phone: p, dnc: false, activeLead: null, deletedLead: null };
  if (await isDnc(p)) return { phone: p, dnc: true, activeLead: null, deletedLead: null };
  const [active] = await deps.pool.query(
    'SELECT id, name FROM leads WHERE deleted_at IS NULL AND (phone = ? OR alt_phone = ?) ORDER BY id DESC LIMIT 1',
    [p, p],
  );
  if (active[0]) return { phone: p, dnc: false, activeLead: active[0], deletedLead: null };
  const d = await deletedLeadFor(p, deps);
  if (!d) return { phone: p, dnc: false, activeLead: null, deletedLead: null };
  const visible = await agentCanSeeLead(user, d, findCurrentCampaign, deps);
  return {
    phone: p,
    dnc: false,
    activeLead: null,
    deletedLead: visible
      ? {
          id: d.id,
          name: d.name,
          deletedAt: d.deleted_at,
          deletedBy: d.deleted_by || null,
          // The list was deleted at the same moment = deleted with its list.
          withList: !!d.list_deleted_at && +new Date(d.list_deleted_at) === +new Date(d.deleted_at) ? d.list : null,
          campaign: d.campaign,
          lastOutcome: d.status && d.status !== 'new' ? outcomeLabel(d.status, null) : null,
        }
      : {
          id: null,
          name: null,
          deletedAt: d.deleted_at,
          deletedBy: null,
          withList: null,
          campaign: null,
          lastOutcome: null,
        },
  };
}

module.exports = { findLeadByPhone, leadHistory, formAnswers, agentCanSeeLead, deletedLeadFor, numberCheck };
