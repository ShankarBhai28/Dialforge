// Edit one lead (Leads table and the lead's own page).
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FormError } from '@/components/common';
import { useCampaigns } from '@/features/campaigns/api';
import { useForms } from '@/features/forms/api';
import { FieldInput, fieldValues, type FieldValues } from '@/features/forms/FieldInput';
import { useDispositions, useLeadAgents, useLists, useSaveLead, type Lead } from './api';
import { DEFAULT_DISPOSITIONS, statusLabel } from './statuses';

export function LeadDialog({ lead, onOpenChange }: { lead: Lead; onOpenChange: (open: boolean) => void }) {
  const campaigns = useCampaigns();
  const lists = useLists();
  const save = useSaveLead();
  const [name, setName] = useState(lead.name ?? '');
  const [phone, setPhone] = useState(lead.phone);
  const [altPhone, setAltPhone] = useState(lead.alt_phone ?? '');
  const [priority, setPriority] = useState(String(lead.priority ?? 0));
  const [campaignId, setCampaignId] = useState(lead.campaign_id ? String(lead.campaign_id) : '');
  const [listId, setListId] = useState(lead.list_id ? String(lead.list_id) : '');
  const [status, setStatus] = useState(lead.status);
  const agents = useLeadAgents();
  const [assignedTo, setAssignedTo] = useState(lead.assigned_user_id ? String(lead.assigned_user_id) : '');
  const [customEdits, setCustomEdits] = useState<FieldValues>({});

  // The form fields of the campaign the lead is (being moved) in. Saved
  // values for other keys are kept by the server and listed read-only.
  const forms = useForms();
  const formId = campaigns.data?.find((c) => String(c.id) === campaignId)?.form_id;
  const form = formId ? forms.data?.find((f) => f.id === formId) : undefined;
  const fields = form?.fields ?? [];
  const saved = fieldValues(fields, lead.custom_data);
  const customValue = (key: string) => customEdits[key] ?? saved[key];
  const otherSaved = Object.entries(lead.custom_data ?? {}).filter(([k]) => !fields.some((f) => f.field_key === k));

  // The server checks status against the chosen campaign's dispositions
  // (or the defaults when unassigned), so offer exactly those.
  const dispositions = useDispositions(campaignId ? Number(campaignId) : null);
  const choices = campaignId ? (dispositions.data ?? []) : DEFAULT_DISPOSITIONS;
  const statusOptions = [{ code: 'new', label: 'New' }, ...choices];
  if (!statusOptions.some((o) => o.code === status)) statusOptions.push({ code: status, label: statusLabel(status) });

  // Picking a list moves the lead to that list's campaign too.
  function onListChange(value: string) {
    setListId(value);
    const l = lists.data?.find((x) => String(x.id) === value);
    if (l) setCampaignId(String(l.campaign_id));
  }

  // A list belongs to one campaign, so a different campaign drops the list.
  function onCampaignChange(value: string) {
    setCampaignId(value);
    const l = lists.data?.find((x) => String(x.id) === listId);
    if (l && String(l.campaign_id) !== value) setListId('');
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate(
      {
        id: lead.id,
        name: name.trim(),
        phone: phone.trim(),
        altPhone: altPhone.trim(),
        priority: Number(priority),
        // Only when the form is on screen; otherwise the saved values stay as they are.
        customData: fields.length
          ? Object.fromEntries(fields.map((f) => [f.field_key, customValue(f.field_key)]))
          : undefined,
        campaignId: campaignId ? Number(campaignId) : null,
        listId: listId ? Number(listId) : null,
        status,
        assignedUserId: assignedTo ? Number(assignedTo) : null,
      },
      {
        onSuccess: () => {
          toast.success('Lead saved');
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>Edit lead {lead.phone}</DialogTitle>
            <DialogDescription>Changing the list also moves the lead to that list's campaign.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <Field id="lead-name" label="Name">
              <Input id="lead-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field id="lead-phone" label="Phone" hint="7-15 digits, optional leading +.">
              <Input
                id="lead-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                inputMode="tel"
                required
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <Field id="lead-alt-phone" label="Alt phone" hint="Optional second number.">
                <Input
                  id="lead-alt-phone"
                  value={altPhone}
                  onChange={(e) => setAltPhone(e.target.value)}
                  inputMode="tel"
                />
              </Field>
              <Field id="lead-priority" label="Priority" hint="-100 to 100, higher first.">
                <Input
                  id="lead-priority"
                  type="number"
                  min={-100}
                  max={100}
                  step={1}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  required
                />
              </Field>
            </div>
            <Field id="lead-campaign" label="Campaign">
              <Select id="lead-campaign" value={campaignId} onChange={(e) => onCampaignChange(e.target.value)}>
                <option value="">Unassigned</option>
                {campaigns.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="lead-list" label="List">
              <Select id="lead-list" value={listId} onChange={(e) => onListChange(e.target.value)}>
                <option value="">No list</option>
                {lists.data?.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.campaign_name ?? 'no campaign'})
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="lead-status" label="Status" hint="The campaign's own dispositions.">
              <Select id="lead-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                {statusOptions.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              id="lead-assigned"
              label="Given to agent"
              hint="Only that agent sees it and calls it; the dialer leaves it to them."
            >
              <Select id="lead-assigned" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
                <option value="">Nobody - shared with the campaign</option>
                {agents.data
                  ?.filter((u) => u.active)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.username}
                    </option>
                  ))}
                {lead.assigned_user_id && !agents.data?.some((u) => u.id === lead.assigned_user_id) && (
                  <option value={lead.assigned_user_id}>{lead.assigned_to ?? 'another agent'}</option>
                )}
              </Select>
            </Field>
            {fields.length > 0 && (
              <fieldset className="grid gap-4 rounded-md border p-3 sm:grid-cols-2">
                <legend className="px-1 text-sm font-semibold">Form: {form?.name}</legend>
                {fields.map((f) => (
                  <FieldInput
                    key={f.field_key}
                    f={f}
                    idPrefix="lead-ff"
                    optional
                    value={customValue(f.field_key)}
                    onChange={(v) => setCustomEdits((prev) => ({ ...prev, [f.field_key]: v }))}
                  />
                ))}
              </fieldset>
            )}
            {otherSaved.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Also saved (not on {form ? 'this' : "the campaign's"} form, kept as is):{' '}
                {otherSaved.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(' · ')}
              </p>
            )}
            <FormError message={save.error?.message} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
