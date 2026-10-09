// Teams: group agents and map them to campaigns (and optionally to the
// extensions they may connect with). An agent only sees the campaigns
// mapped to their team(s).
import { useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Pencil, Plus, RefreshCw, Trash2, UsersRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Checkbox, Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog, EmptyState, Field, FormError, SectionHeader, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { useCampaigns } from '@/features/campaigns/api';
import { useExtensions, useUsers } from '@/features/users/api';
import { useDeleteTeam, useSaveTeam, useTeams, type Team } from './api';

/** A titled box of checkboxes; `selected` holds the ticked ids. */
function CheckList({
  legend,
  items,
  selected,
  onChange,
  loading,
  error,
  emptyText,
}: {
  legend: string;
  items: { id: number; label: ReactNode; name: string }[] | undefined;
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
  loading: boolean;
  error?: string;
  emptyText: string;
}) {
  return (
    <fieldset className="min-w-0 rounded-md border p-3">
      <legend className="px-1 text-sm font-semibold">
        {legend} {selected.size > 0 && <span className="text-muted-foreground">({selected.size})</span>}
      </legend>
      {loading ? (
        <Skeleton className="h-16" />
      ) : error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : !items?.length ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="grid max-h-56 gap-1.5 overflow-y-auto text-sm">
          {items.map((it) => (
            <label key={it.id} className="flex cursor-pointer items-center gap-2">
              <Checkbox
                checked={selected.has(it.id)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(it.id);
                  else next.delete(it.id);
                  onChange(next);
                }}
                aria-label={`${legend}: ${it.name}`}
              />
              <span>{it.label}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function TeamDialog({ team, onOpenChange }: { team: Team | null; onOpenChange: (v: boolean) => void }) {
  const users = useUsers();
  const campaigns = useCampaigns();
  const extensions = useExtensions();
  const save = useSaveTeam();
  const [name, setName] = useState(team?.name ?? '');
  const [status, setStatus] = useState(team?.status ?? 'active');
  const [members, setMembers] = useState(() => new Set<number>(team?.members.map((m) => m.id)));
  const [campaignIds, setCampaignIds] = useState(() => new Set<number>(team?.campaigns.map((c) => c.id)));
  const [extensionIds, setExtensionIds] = useState(() => new Set<number>(team?.extensions.map((x) => x.id)));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    save.mutate(
      {
        id: team?.id,
        name: trimmed,
        status,
        // Straight from the sets (not filtered by the loaded lists), so a list
        // that failed to load can't silently drop existing mappings.
        memberIds: [...members],
        campaignIds: [...campaignIds],
        extensionIds: [...extensionIds],
      },
      {
        onSuccess: () => {
          toast.success(`Saved team: ${trimmed}`);
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{team ? `Edit ${team.name}` : 'Create team'}</DialogTitle>
            <DialogDescription>Agents in this team can work the campaigns ticked here.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
              <Field id="team-name" label="Team name">
                <Input id="team-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
              </Field>
              <Field id="team-status" label="Status">
                <Select id="team-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </Select>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <CheckList
                legend="Agents"
                items={users.data
                  ?.filter((u) => u.role === 'agent')
                  .map((u) => ({
                    id: u.id,
                    name: u.username,
                    label: u.status === 'inactive' ? `${u.username} (inactive)` : u.username,
                  }))}
                selected={members}
                onChange={setMembers}
                loading={users.isPending}
                error={users.error?.message}
                emptyText="No agents yet"
              />
              <CheckList
                legend="Campaigns"
                items={campaigns.data?.map((c) => ({
                  id: c.id,
                  name: c.name,
                  label: (
                    <>
                      {c.name}
                      {c.status !== 'active' && <span className="text-muted-foreground"> ({c.status})</span>}
                    </>
                  ),
                }))}
                selected={campaignIds}
                onChange={setCampaignIds}
                loading={campaigns.isPending}
                error={campaigns.error?.message}
                emptyText="No campaigns yet"
              />
            </div>
            <div>
              <CheckList
                legend="Extensions"
                items={extensions.data?.map((x) => ({
                  id: x.id,
                  name: x.name,
                  label: x.label ? `${x.name} - ${x.label}` : x.name,
                }))}
                selected={extensionIds}
                onChange={setExtensionIds}
                loading={extensions.isPending}
                error={extensions.error?.message}
                emptyText="No extensions yet"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                None ticked: members may connect with any free extension. Ticked: only these, plus each agent&apos;s own
                extension.
              </p>
            </div>
            <FormError message={save.error?.message} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {team ? 'Save changes' : 'Create team'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const none = <span className="text-muted-foreground">—</span>;

export function TeamsPage() {
  const teams = useTeams();
  const remove = useDeleteTeam();
  // null = closed, 'new' = create, Team = edit that one.
  const [editing, setEditing] = useState<Team | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Team | null>(null);

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Teams"
          description="Group agents and map them to campaigns - an agent only sees campaigns mapped to their team(s)."
          actions={
            <>
              <Button variant="outline" onClick={() => teams.refetch()}>
                <RefreshCw /> Refresh
              </Button>
              <Button onClick={() => setEditing('new')}>
                <Plus /> Create team
              </Button>
            </>
          }
        />

        {teams.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : teams.error ? (
          <ErrorState message={teams.error.message} onRetry={() => teams.refetch()} />
        ) : teams.data.length === 0 ? (
          <EmptyState icon={UsersRound} title="No teams yet">
            Create one to choose which agents can work which campaigns.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Agents</TableHead>
                <TableHead>Campaigns</TableHead>
                <TableHead>Extensions</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.data.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-semibold">{t.name}</TableCell>
                  <TableCell className="min-w-40">
                    {t.members.length ? t.members.map((m) => m.username).join(', ') : none}
                  </TableCell>
                  <TableCell className="min-w-40">
                    {t.campaigns.length ? t.campaigns.map((c) => c.name).join(', ') : none}
                  </TableCell>
                  <TableCell>
                    {t.extensions.length ? (
                      t.extensions.map((x) => x.name).join(', ')
                    ) : (
                      <span className="text-muted-foreground">Any</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusPill tone={t.status === 'active' ? 'green' : 'grey'}>{t.status}</StatusPill>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(t)} aria-label={`Edit ${t.name}`}>
                      <Pencil /> Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setDeleting(t)}
                      aria-label={`Delete ${t.name}`}
                    >
                      <Trash2 /> Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {editing && (
        <TeamDialog
          // fresh form state per team
          key={editing === 'new' ? 'new' : editing.id}
          team={editing === 'new' ? null : editing}
          onOpenChange={(v) => !v && setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v) {
            setDeleting(null);
            remove.reset();
          }
        }}
        title={`Delete team "${deleting?.name}"?`}
        description="Its agents will lose access to its campaigns."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('Team deleted');
              setDeleting(null);
            },
          })
        }
      />
    </Card>
  );
}
