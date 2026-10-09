// Create / edit a campaign: queue, form, caller ID and every dialer setting.
// Mode-specific knobs are hidden (not cleared) like the classic screen, so
// their saved values survive switching modes back and forth.
import { memo, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox, Select } from '@/components/ui/form-controls';
import { DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Field, FormError } from '@/components/common';
import { useQueues } from '@/features/queues/api';
import { useFormOptions, useSaveCampaign, type Campaign, type DialMode } from './api';
import {
  DIAL_MODES,
  campaignBody,
  campaignForm,
  checkCampaign,
  modeFields,
  timeZoneNames,
  type CampaignForm,
} from './settings';

function NumberField({
  id,
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
  step?: number;
  placeholder?: string;
}) {
  return (
    <Field id={id} label={label} hint={hint}>
      <Input
        id={id}
        type="number"
        inputMode={step ? 'decimal' : 'numeric'}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

// ~400 zone names: built once and memoised so typing elsewhere stays fast.
const ZONES = timeZoneNames();
const TimeZoneList = memo(function TimeZoneList() {
  if (ZONES.length === 0) return null;
  return (
    <datalist id="c-tz-list">
      {ZONES.map((z) => (
        <option key={z} value={z} />
      ))}
    </datalist>
  );
});

function CheckField({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2 self-end pb-2">
      <Checkbox id={id} checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
      <div>
        <label htmlFor={id} className="cursor-pointer text-sm font-semibold">
          {label}
        </label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

export function CampaignSettingsForm({ campaign, onDone }: { campaign: Campaign | null; onDone: () => void }) {
  const queues = useQueues();
  const forms = useFormOptions();
  const save = useSaveCampaign();
  const [form, setForm] = useState<CampaignForm>(() => campaignForm(campaign));
  const [localError, setLocalError] = useState<string | null>(null);
  const set = <K extends keyof CampaignForm>(key: K, value: CampaignForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const show = modeFields(form.dialMode);

  // Only active forms can be attached, but keep the current one visible
  // (marked) so an edit doesn't silently drop it.
  const formChoices = (forms.data ?? []).filter((f) => f.status === 'active' || String(f.id) === form.formId);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = campaignBody(form);
    const error = checkCampaign(body);
    setLocalError(error);
    if (error) return;
    save.mutate(
      { id: campaign?.id, body },
      {
        onSuccess: () => {
          toast.success(campaign ? 'Campaign saved' : `Created campaign: ${body.name}`);
          onDone();
        },
      },
    );
  }

  return (
    <form onSubmit={onSubmit} className="contents">
      <DialogBody className="grid gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="c-name" label="Campaign name">
            <Input id="c-name" value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus={!campaign} />
          </Field>
          <Field id="c-queue" label="Queue" hint="Whose agents take this campaign's calls.">
            <Select id="c-queue" value={form.queueId} onChange={(e) => set('queueId', e.target.value)}>
              <option value="">No queue</option>
              {/* keep the saved queue selectable while the list loads */}
              {!queues.data && campaign?.queue_id && <option value={campaign.queue_id}>{campaign.queue_name}</option>}
              {queues.data?.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="c-form" label="Form" hint="Shown to the agent on each call. Only active forms can be attached.">
            <Select id="c-form" value={form.formId} onChange={(e) => set('formId', e.target.value)}>
              <option value="">None</option>
              {!forms.data && campaign?.form_id && <option value={campaign.form_id}>{campaign.form_name}</option>}
              {formChoices.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {f.status !== 'active' ? ' (inactive)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="c-cli" label="Outbound Caller ID (DID)">
            <Input
              id="c-cli"
              inputMode="tel"
              value={form.outboundCallerId}
              onChange={(e) => set('outboundCallerId', e.target.value)}
            />
          </Field>
          {/* POST ignores status (new campaigns start active), so it's only offered on edit. */}
          {campaign && (
            <Field id="c-status" label="Status">
              <Select id="c-status" value={form.status} onChange={(e) => set('status', e.target.value)}>
                <option value="active">Active</option>
                <option value="paused">Paused</option>
                {!['active', 'paused'].includes(form.status) && <option value={form.status}>{form.status}</option>}
              </Select>
            </Field>
          )}
          <CheckField
            id="c-autoanswer"
            label="Auto Answer"
            checked={form.autoAnswer}
            onChange={(v) => set('autoAnswer', v)}
          />
        </div>

        <fieldset className="grid gap-4 rounded-lg border p-4">
          <legend className="px-1 text-sm font-bold">Dialer settings</legend>
          <p className="-mt-2 text-xs text-muted-foreground">
            Mode, ratio, limits and calling hours. Only the settings that matter for the chosen mode are shown.
          </p>
          <Field
            id="c-mode"
            label="Dial mode"
            hint={form.dialMode === 'manual' ? 'Saving in Manual mode stops the dialer for this campaign.' : undefined}
          >
            <Select id="c-mode" value={form.dialMode} onChange={(e) => set('dialMode', e.target.value as DialMode)}>
              {DIAL_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {show.auto && (
              <NumberField
                id="c-ratio"
                // Predictive learns its own ratio; this is only the safe start.
                label={show.predictive ? 'Starting ratio (until learned)' : 'Dial ratio'}
                hint={
                  show.predictive
                    ? 'Used until there are enough calls to measure the answer rate.'
                    : 'Lines dialed per free agent, 1-5.'
                }
                value={form.dialRatio}
                onChange={(v) => set('dialRatio', v)}
                min={1}
                max={5}
                step={0.1}
              />
            )}
            {show.predictive && (
              <>
                <NumberField
                  id="c-maxratio"
                  label="Max dial ratio"
                  hint="Upper limit for the learned ratio, up to 5."
                  value={form.maxDialRatio}
                  onChange={(v) => set('maxDialRatio', v)}
                  min={1}
                  max={5}
                  step={0.1}
                />
                <NumberField
                  id="c-abandon"
                  label="Target abandon %"
                  hint="0-10. Predictive slows down to keep abandoned calls under this."
                  value={form.targetAbandonPct}
                  onChange={(v) => set('targetAbandonPct', v)}
                  min={0}
                  max={10}
                  step={0.1}
                />
              </>
            )}
            {show.auto && (
              <NumberField
                id="c-abandonwait"
                label="Max wait for agent (sec)"
                hint="An answered customer waits this long for a free agent, then hears a message and the call counts as abandoned."
                value={form.abandonWaitSec}
                onChange={(v) => set('abandonWaitSec', v)}
                min={2}
                max={30}
              />
            )}
            {show.preview && (
              <NumberField
                id="c-previewdial"
                label="Preview auto-dial (sec)"
                hint="Dial the shown lead automatically after this many seconds. Blank or 0 = off."
                placeholder="Off"
                value={form.previewAutodialSec}
                onChange={(v) => set('previewAutodialSec', v)}
                min={0}
                max={120}
              />
            )}
            <NumberField
              id="c-ring"
              label="Ring timeout (sec)"
              hint="10-60"
              value={form.ringTimeoutSec}
              onChange={(v) => set('ringTimeoutSec', v)}
              min={10}
              max={60}
            />
            <NumberField
              id="c-attempts"
              label="Max attempts / lead"
              hint="1-20"
              value={form.maxAttempts}
              onChange={(v) => set('maxAttempts', v)}
              min={1}
              max={20}
            />
            <NumberField
              id="c-channels"
              label="Max channels"
              hint="1-200 calls at once"
              value={form.maxChannels}
              onChange={(v) => set('maxChannels', v)}
              min={1}
              max={200}
            />
            <NumberField
              id="c-wrapup"
              label="Wrap-up (sec)"
              hint="0-600"
              value={form.wrapupSec}
              onChange={(v) => set('wrapupSec', v)}
              min={0}
              max={600}
            />
            <Field id="c-from" label="Calling from">
              <Input
                id="c-from"
                type="time"
                value={form.callWindowStart}
                onChange={(e) => set('callWindowStart', e.target.value)}
              />
            </Field>
            <Field id="c-until" label="Calling until">
              <Input
                id="c-until"
                type="time"
                value={form.callWindowEnd}
                onChange={(e) => set('callWindowEnd', e.target.value)}
              />
            </Field>
            <Field id="c-tz" label="Timezone" hint="Calling hours are in this zone, e.g. Asia/Kolkata.">
              <Input
                id="c-tz"
                list={ZONES.length ? 'c-tz-list' : undefined}
                value={form.timezone}
                onChange={(e) => set('timezone', e.target.value)}
              />
            </Field>
            <TimeZoneList />
            {show.auto && (
              <CheckField
                id="c-amd"
                label="Answering-machine detection"
                checked={form.amdEnabled}
                onChange={(v) => set('amdEnabled', v)}
              />
            )}
          </div>
        </fieldset>
        <FormError message={localError ?? save.error?.message} />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {campaign ? 'Save changes' : 'Create campaign'}
        </Button>
      </DialogFooter>
    </form>
  );
}
