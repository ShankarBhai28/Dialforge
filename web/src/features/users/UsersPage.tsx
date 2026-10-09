// Users: agent / admin login accounts. The API offers list + create only.
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Plus, UserRound } from 'lucide-react';
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
import { EmptyState, Field, FormError, SectionHeader, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { useCreateUser, useExtensions, useUsers } from './api';

function CreateUserDialog({ onOpenChange }: { onOpenChange: (v: boolean) => void }) {
  const extensions = useExtensions();
  const create = useCreateUser();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('agent');
  const [extensionId, setExtensionId] = useState('');
  // Classic pre-selected the first extension; do the same once they load.
  const extension = extensionId || (extensions.data?.[0] ? String(extensions.data[0].id) : '');

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
            <Field id="user-name" label="Username">
              <Input
                id="user-name"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
                autoComplete="off"
              />
            </Field>
            <Field id="user-password" label="Password">
              <Input
                id="user-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
              />
            </Field>
            <Field id="user-role" label="Role">
              <Select id="user-role" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="agent">agent</option>
                <option value="admin">admin</option>
              </Select>
            </Field>
            {role === 'agent' && (
              <Field
                id="user-extension"
                label="Extension"
                error={extensions.error ? `Could not load extensions: ${extensions.error.message}` : null}
                hint={extensions.data?.length === 0 ? 'No extensions exist yet.' : undefined}
              >
                <Select
                  id="user-extension"
                  value={extension}
                  onChange={(e) => setExtensionId(e.target.value)}
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
            )}
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

export function UsersPage() {
  const users = useUsers();
  const [creating, setCreating] = useState(false);

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Users"
          description="Create and manage agent / admin accounts."
          actions={
            <Button onClick={() => setCreating(true)}>
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
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="font-semibold">{u.username}</TableCell>
                  <TableCell>
                    <StatusPill tone={u.role === 'admin' ? 'amber' : 'blue'}>{u.role}</StatusPill>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {u.extension_name ?? <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(u.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {creating && <CreateUserDialog onOpenChange={setCreating} />}
    </Card>
  );
}
