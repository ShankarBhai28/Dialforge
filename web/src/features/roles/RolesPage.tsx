// Roles: admin logins with restricted rights (Team Leader, Supervisor, ...).
// Super Admin only. Per screen: None (hidden), View (read only) or Manage
// (also change), plus whether the role sees all teams or only its own.
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
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
import { cn } from '@/lib/utils';
import type { Level, Screen } from '@/features/auth/access';
import { useDeleteRole, useRoles, useSaveRole, type AdminRole, type RoleScope, type RolesResponse } from './api';

const LEVELS: { value: Level; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'view', label: 'View' },
  { value: 'manage', label: 'Manage' },
];

/** One row per screen: None / View / Manage. */
function PermissionGrid({
  screens,
  value,
  onChange,
}: {
  screens: RolesResponse['screens'];
  value: Partial<Record<Screen, Level>>;
  onChange: (screen: Screen, level: Level) => void;
}) {
  return (
    <fieldset className="rounded-md border">
      <legend className="sr-only">Rights per screen</legend>
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 border-b bg-muted/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
        <span>Screen</span>
        <span>Access</span>
      </div>
      <div className="max-h-[45vh] divide-y overflow-y-auto">
        {screens.map((s) => {
          const current = value[s.key] ?? 'none';
          return (
            <div key={s.key} className="grid grid-cols-[1fr_auto] items-center gap-x-3 px-3 py-1.5">
              <span className="text-sm font-medium">{s.label}</span>
              <div role="radiogroup" aria-label={s.label} className="flex overflow-hidden rounded-md border text-xs">
                {LEVELS.map((l) => (
                  <label
                    key={l.value}
                    className={cn(
                      'cursor-pointer px-2.5 py-1 font-semibold select-none',
                      current === l.value
                        ? l.value === 'none'
                          ? 'bg-muted text-foreground'
                          : 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted/60',
                    )}
                  >
                    <input
                      type="radio"
                      className="sr-only"
                      name={`perm-${s.key}`}
                      aria-label={`${s.label}: ${l.label}`}
                      checked={current === l.value}
                      onChange={() => onChange(s.key, l.value)}
                    />
                    {l.label}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function RoleDialog({
  role,
  screens,
  onOpenChange,
}: {
  role: AdminRole | null;
  screens: RolesResponse['screens'];
  onOpenChange: (v: boolean) => void;
}) {
  const save = useSaveRole();
  const [name, setName] = useState(role?.name ?? '');
  const [scope, setScope] = useState<RoleScope>(role?.scope ?? 'team');
  const [permissions, setPermissions] = useState<Partial<Record<Screen, Level>>>(() => ({ ...role?.permissions }));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    save.mutate(
      { id: role?.id, name: trimmed, scope, permissions },
      {
        onSuccess: () => {
          toast.success(`Saved role: ${trimmed}`);
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
            <DialogTitle>{role ? `Edit ${role.name}` : 'Create role'}</DialogTitle>
            <DialogDescription>
              {role
                ? 'Changes apply to everyone with this role straight away.'
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
                    ? "Only the teams they're a member of (Teams screen). They can't create campaigns, manage users or change teams."
                    : 'Every team.'
                }
              >
                <Select id="role-scope" value={scope} onChange={(e) => setScope(e.target.value as RoleScope)}>
                  <option value="team">Their own teams</option>
                  <option value="all">All teams</option>
                </Select>
              </Field>
            </div>
            <PermissionGrid
              screens={screens}
              value={permissions}
              onChange={(screen, level) => setPermissions((p) => ({ ...p, [screen]: level }))}
            />
            <p className="text-xs text-muted-foreground">
              View: open the screen and read it. Manage: also create, edit, delete and its actions (e.g. start the
              dialer). Roles themselves are always Super Admin only.
            </p>
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

/** "Live Agents (view), Dialer (manage), …" */
function summary(role: AdminRole, screens: RolesResponse['screens']) {
  const parts = screens
    .filter((s) => (role.permissions[s.key] ?? 'none') !== 'none')
    .map((s) => `${s.label}${role.permissions[s.key] === 'manage' ? ' (manage)' : ''}`);
  return parts.join(', ');
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
          description="Admin logins with only the rights you give them. Give a role to someone in Users (account type: Admin with a role)."
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
            Create one, e.g. Team Leader: Live Agents, Dialer and Reports for their own team.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Role</TableHead>
                <TableHead>Sees</TableHead>
                <TableHead>Screens</TableHead>
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
                  <TableCell className="min-w-56 text-sm">{summary(r, roles.data.screens)}</TableCell>
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
          screens={roles.data.screens}
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
