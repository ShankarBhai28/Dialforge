// Roles: admin logins with restricted rights (Team Leader, Supervisor, ...).
// Super Admin only. Per screen, tick what the role may do: View, Create,
// Edit, Delete and the screen's own actions (Dialer start/stop, Leads
// import, ...). Plus whether the role sees all teams or only its own.
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Lock, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
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
import type { Action, Screen } from '@/features/auth/access';
import {
  useDeleteRole,
  useRoles,
  useSaveRole,
  type AdminRole,
  type Permissions,
  type RoleScope,
  type RolesResponse,
} from './api';

const MAIN: Action[] = ['view', 'create', 'edit', 'delete'];

/** What `scope` allows for `screen` (an own-teams role can't reach outside its teams). */
function blockedFor(meta: RolesResponse, scope: RoleScope, screen: Screen): Action[] {
  return scope === 'team' ? (meta.teamScopeBlocked[screen] ?? []) : [];
}

/** Ticking any action ticks View; unticking View clears the row. */
function toggle(current: Action[], action: Action, on: boolean): Action[] {
  if (action === 'view' && !on) return [];
  const next = new Set(current);
  if (on) {
    next.add(action);
    next.add('view');
  } else next.delete(action);
  return [...next];
}

function ActionBox({
  screenLabel,
  label,
  checked,
  blocked,
  onChange,
}: {
  screenLabel: string;
  label: string;
  checked: boolean;
  blocked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label
      className="inline-flex cursor-pointer items-center gap-1.5 text-xs has-disabled:cursor-not-allowed has-disabled:opacity-50"
      title={blocked ? 'Needs a role that sees all teams' : undefined}
    >
      <Checkbox
        aria-label={`${screenLabel}: ${label}`}
        checked={checked && !blocked}
        disabled={blocked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {blocked && <Lock className="size-3" />}
    </label>
  );
}

/** Screens down, View / Create / Edit / Delete across, then each screen's own actions. */
function PermissionGrid({
  meta,
  scope,
  value,
  onChange,
}: {
  meta: RolesResponse;
  scope: RoleScope;
  value: Permissions;
  onChange: (next: Permissions) => void;
}) {
  const set = (screen: Screen, actions: Action[]) => onChange({ ...value, [screen]: actions });
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-semibold">Screen</th>
            {MAIN.map((a) => (
              <th key={a} className="px-2 py-2 text-center font-semibold">
                {meta.actionLabels[a]}
              </th>
            ))}
            <th className="px-3 py-2 text-left font-semibold">More</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {meta.screens.map((s) => {
            const current = value[s.key] ?? [];
            const blocked = blockedFor(meta, scope, s.key);
            const extra = s.actions.filter((a) => !MAIN.includes(a));
            const box = (a: Action) => (
              <ActionBox
                screenLabel={s.label}
                label={meta.actionLabels[a]}
                checked={current.includes(a)}
                blocked={blocked.includes(a)}
                onChange={(on) => set(s.key, toggle(current, a, on))}
              />
            );
            return (
              <tr key={s.key} className={current.length ? undefined : 'text-muted-foreground'}>
                <td className="px-3 py-1.5 font-medium">{s.label}</td>
                {MAIN.map((a) => (
                  <td key={a} className="px-2 py-1.5 text-center">
                    {s.actions.includes(a) ? box(a) : <span className="text-muted-foreground/50">—</span>}
                  </td>
                ))}
                <td className="px-3 py-1.5">
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {extra.map((a) => (
                      <span key={a} className="inline-flex items-center gap-1.5">
                        {box(a)}
                        <span className="text-xs">{meta.actionLabels[a]}</span>
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Drops what the scope doesn't allow (switching a role to own teams). */
function clamp(meta: RolesResponse, scope: RoleScope, p: Permissions): Permissions {
  const out: Permissions = {};
  for (const s of meta.screens) {
    const blocked = blockedFor(meta, scope, s.key);
    out[s.key] = (p[s.key] ?? []).filter((a) => !blocked.includes(a));
  }
  return out;
}

function RoleDialog({
  role,
  meta,
  onOpenChange,
}: {
  role: AdminRole | null;
  meta: RolesResponse;
  onOpenChange: (v: boolean) => void;
}) {
  const save = useSaveRole();
  const [name, setName] = useState(role?.name ?? '');
  const [scope, setScope] = useState<RoleScope>(role?.scope ?? 'all');
  const [permissions, setPermissions] = useState<Permissions>(() => ({ ...role?.permissions }));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    save.mutate(
      { id: role?.id, name: trimmed, scope, permissions: clamp(meta, scope, permissions) },
      {
        onSuccess: () => {
          toast.success(`Saved role: ${trimmed}`);
          onOpenChange(false);
        },
      },
    );
  }

  const viewAll = () => {
    const next: Permissions = { ...permissions };
    for (const s of meta.screens) if (!(next[s.key] ?? []).length) next[s.key] = ['view'];
    setPermissions(next);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>{role ? `Edit ${role.name}` : 'Create role'}</DialogTitle>
            <DialogDescription>
              {role
                ? 'Changes apply to everyone with this role within about 30 seconds.'
                : 'e.g. Team Leader or Supervisor. Then give it to people in Users.'}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="role-name" label="Role name">
                <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
              </Field>
              <Field
                id="role-scope"
                label="Sees data of"
                hint={
                  scope === 'team'
                    ? "Only the teams they're added to in Teams. Creating or deleting campaigns, users and teams is locked (it reaches outside their teams)."
                    : 'Every team.'
                }
              >
                <Select id="role-scope" value={scope} onChange={(e) => setScope(e.target.value as RoleScope)}>
                  <option value="all">All teams</option>
                  <option value="team">Their own teams</option>
                </Select>
              </Field>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Tick what this role may do. Any tick also gives View; a screen with nothing ticked is hidden.
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={viewAll}>
                  View everything
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setPermissions({})}>
                  Clear
                </Button>
              </div>
            </div>
            <PermissionGrid meta={meta} scope={scope} value={permissions} onChange={setPermissions} />
            <FormError message={save.error?.message} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {role ? 'Save changes' : 'Create role'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Live Agents: View · Campaigns: View, Edit · …" */
function summary(role: AdminRole, meta: RolesResponse) {
  return meta.screens
    .filter((s) => (role.permissions[s.key] ?? []).length)
    .map((s) => `${s.label}: ${(role.permissions[s.key] ?? []).map((a) => meta.actionLabels[a]).join(', ')}`)
    .join(' · ');
}

export function RolesPage() {
  const roles = useRoles();
  const remove = useDeleteRole();
  const [editing, setEditing] = useState<AdminRole | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminRole | null>(null);

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Roles"
          description="Admin logins with only the rights you tick. Give a role to someone in Users (account type: Admin with a role)."
          actions={
            <Button onClick={() => setEditing('new')} disabled={!roles.data}>
              <Plus /> Create role
            </Button>
          }
        />

        {roles.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : roles.error ? (
          <ErrorState message={roles.error.message} onRetry={() => roles.refetch()} />
        ) : roles.data.roles.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No roles yet">
            Create one, e.g. Team Leader: Live Agents and Reports to view, Dialer start / stop.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Sees</TableHead>
                <TableHead>Rights</TableHead>
                <TableHead>Users</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.data.roles.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-semibold">{r.name}</TableCell>
                  <TableCell>
                    <StatusPill tone={r.scope === 'team' ? 'blue' : 'amber'}>
                      {r.scope === 'team' ? 'Own teams' : 'All teams'}
                    </StatusPill>
                  </TableCell>
                  <TableCell className="min-w-64 text-sm">{summary(r, roles.data)}</TableCell>
                  <TableCell className="tabular-nums">{r.userCount}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}>
                      <Pencil /> Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setDeleting(r)}
                      aria-label={`Delete ${r.name}`}
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

      {editing && roles.data && (
        <RoleDialog
          key={editing === 'new' ? 'new' : editing.id}
          role={editing === 'new' ? null : editing}
          meta={roles.data}
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
        title={`Delete role "${deleting?.name}"?`}
        description="Only possible when nobody has this role."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('Role deleted');
              setDeleting(null);
            },
          })
        }
      />
    </Card>
  );
}
