// Users: agent / admin login accounts. Create, edit role / extension,
// reset password, deactivate. There is no delete - calls, status history,
// form answers and callbacks point at users - so leavers are deactivated.
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { KeyRound, Pencil, Plus, UserRound, UserRoundCheck, UserRoundX } from 'lucide-react';
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
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useMe } from '@/features/auth/auth';
import { useCreateUser, useExtensions, useResetPassword, useUpdateUser, useUsers, type User } from './api';

const PASSWORD_HINT = 'At least 8 characters.';

function ExtensionSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const extensions = useExtensions();
  return (
    <Field
      id={id}
      label="Extension"
      error={extensions.error ? `Could not load extensions: ${extensions.error.message}` : null}
      hint={extensions.data?.length === 0 ? 'No extensions exist yet.' : 'The softphone line this agent usually uses.'}
    >
      <Select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={!extensions.data?.length}
        required
      >
        {extensions.isPending && <option value="">Loading…</option>}
        {extensions.data?.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label ? `${x.name} (${x.label})` : x.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** First extension pre-selected once the list loads. */
function useDefaultExtension(chosen: string) {
  const extensions = useExtensions();
  return chosen || (extensions.data?.[0] ? String(extensions.data[0].id) : '');
}

function CreateUserDialog({ onOpenChange }: { onOpenChange: (v: boolean) => void }) {
  const create = useCreateUser();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('agent');
  const [extensionId, setExtensionId] = useState('');
  const extension = useDefaultExtension(extensionId);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const name = username.trim();
    create.mutate(
      { username: name, password, role, extensionId: role === 'agent' && extension ? Number(extension) : null },
      {
        onSuccess: () => {
          toast.success(`Created ${role} account: ${name}`);
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
            <DialogTitle>Create user account</DialogTitle>
            <DialogDescription>Agents must be linked to the extension (softphone) they log in on.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <Field id="user-name" label="Username" hint="3-50 letters, digits, dots, dashes or underscores.">
              <Input
                id="user-name"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
                autoComplete="off"
              />
            </Field>
            <Field id="user-password" label="Password" hint={PASSWORD_HINT}>
              <Input
                id="user-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
              />
            </Field>
            <Field id="user-role" label="Role">
              <Select id="user-role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="agent">agent</option>
                <option value="admin">admin</option>
              </Select>
            </Field>
            {role === 'agent' && <ExtensionSelect id="user-extension" value={extension} onChange={setExtensionId} />}
            <FormError message={create.error?.message} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditUserDialog({ user, onOpenChange }: { user: User; onOpenChange: (v: boolean) => void }) {
  const update = useUpdateUser();
  const [role, setRole] = useState(user.role);
  const [extensionId, setExtensionId] = useState(user.extension_id ? String(user.extension_id) : '');
  const extension = useDefaultExtension(extensionId);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    update.mutate(
      { id: user.id, role, status: user.status, extensionId: role === 'agent' && extension ? Number(extension) : null },
      {
        onSuccess: () => {
          toast.success(`Saved ${user.username}`);
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
            <DialogTitle>Edit {user.username}</DialogTitle>
            <DialogDescription>
              Changing the role logs {user.username} out; they log in again with the new access.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <Field id="edit-role" label="Role">
              <Select id="edit-role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="agent">agent</option>
                <option value="admin">admin</option>
              </Select>
            </Field>
            {role === 'agent' && <ExtensionSelect id="edit-extension" value={extension} onChange={setExtensionId} />}
            <FormError message={update.error?.message} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onOpenChange }: { user: User; onOpenChange: (v: boolean) => void }) {
  const reset = useResetPassword();
  const [password, setPassword] = useState('');
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    reset.mutate(
      { id: user.id, password },
      {
        onSuccess: () => {
          toast.success(`New password set for ${user.username}`);
          onOpenChange(false);
        },
      },
    );
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>Reset password: {user.username}</DialogTitle>
            <DialogDescription>They are logged out everywhere and log in with the new password.</DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            <Field id="new-password" label="New password" hint={PASSWORD_HINT}>
              <Input
                id="new-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoFocus
                autoComplete="new-password"
              />
            </Field>
            <FormError message={reset.error?.message} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={reset.isPending}>
              Set password
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Open = { kind: 'create' } | { kind: 'edit' | 'password' | 'toggle'; user: User } | null;

export function UsersPage() {
  const users = useUsers();
  const { data: me } = useMe();
  const toggle = useUpdateUser();
  const [open, setOpen] = useState<Open>(null);
  const close = () => {
    setOpen(null);
    toggle.reset();
  };
  const target = open && open.kind === 'toggle' ? open.user : null;
  const deactivating = target?.status === 'active';

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Users"
          description="Agent and admin accounts. People who leave are deactivated, so their call history stays."
          actions={
            <Button onClick={() => setOpen({ kind: 'create' })}>
              <Plus /> Create user
            </Button>
          }
        />

        {users.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : users.error ? (
          <ErrorState message={users.error.message} onRetry={() => users.refetch()} />
        ) : users.data.length === 0 ? (
          <EmptyState icon={UserRound} title="No users yet" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Username</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Extension</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.map((u) => {
                const active = u.status !== 'inactive';
                const isMe = u.id === me?.id;
                return (
                  <TableRow key={u.id} className={cn(!active && 'text-muted-foreground')}>
                    <TableCell className="font-semibold">
                      {u.username}
                      {isMe && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={u.role === 'admin' ? 'amber' : 'blue'}>{u.role}</StatusPill>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {u.extension_name ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={active ? 'green' : 'grey'}>{active ? 'Active' : 'Inactive'}</StatusPill>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(u.created_at)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Edit ${u.username}`}
                        onClick={() => setOpen({ kind: 'edit', user: u })}
                      >
                        <Pencil /> Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Reset password for ${u.username}`}
                        onClick={() => setOpen({ kind: 'password', user: u })}
                      >
                        <KeyRound /> Password
                      </Button>
                      {!isMe && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className={cn(active && 'text-destructive')}
                          aria-label={`${active ? 'Deactivate' : 'Activate'} ${u.username}`}
                          onClick={() => setOpen({ kind: 'toggle', user: u })}
                        >
                          {active ? <UserRoundX /> : <UserRoundCheck />} {active ? 'Deactivate' : 'Activate'}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {open?.kind === 'create' && <CreateUserDialog onOpenChange={(v) => !v && close()} />}
      {open?.kind === 'edit' && <EditUserDialog user={open.user} onOpenChange={(v) => !v && close()} />}
      {open?.kind === 'password' && <ResetPasswordDialog user={open.user} onOpenChange={(v) => !v && close()} />}
      <ConfirmDialog
        open={!!target}
        onOpenChange={(v) => !v && close()}
        title={`${deactivating ? 'Deactivate' : 'Activate'} ${target?.username}?`}
        description={
          deactivating
            ? `${target?.username} is logged out at once and can't log in. Their calls and history stay.`
            : `${target?.username} can log in again.`
        }
        confirmLabel={deactivating ? 'Deactivate' : 'Activate'}
        destructive={deactivating}
        pending={toggle.isPending}
        error={toggle.error?.message}
        onConfirm={() =>
          target &&
          toggle.mutate(
            {
              id: target.id,
              role: target.role,
              extensionId: target.extension_id,
              status: deactivating ? 'inactive' : 'active',
            },
            {
              onSuccess: () => {
                toast.success(`${target.username} ${deactivating ? 'deactivated' : 'activated'}`);
                close();
              },
            },
          )
        }
      />
    </Card>
  );
}
