// Extensions: the agents' SIP lines. Asterisk reads them straight from the
// database, so disabling or re-keying one here takes effect at once - no
// Asterisk file editing. They are the client's agent seats (one extension,
// one agent at a time), so they are added by the provider on the server
// (npm run ext:add), not here. The SIP password is shown only right after a
// new password (for a desk phone); the agent screen gets its own.
import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Headset, KeyRound, Power, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog, EmptyState, SectionHeader, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { useCan } from '@/features/auth/access';
import {
  useDeleteExtension,
  useExtensions,
  useNewSipPassword,
  useUpdateExtension,
  type Extension,
  type SipPasswordReply,
} from './api';
import { toastDeleted } from '@/lib/deleted';

const NONE = <span className="text-muted-foreground">—</span>;

/** Shows a SIP password once (after a new password). */
function PasswordDialog({ reply, onClose }: { reply: SipPasswordReply; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>SIP password for {reply.name}</DialogTitle>
          <DialogDescription>
            Shown only now. Agents on the agent screen don&apos;t need it (it&apos;s fetched automatically); copy it
            only for a desk phone or softphone app.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3 pb-5">
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-muted px-3 py-2 font-mono text-sm break-all" aria-label="SIP password">
              {reply.sipPassword}
            </code>
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy password"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(reply.sipPassword)
                  .then(() => toast.success('Copied'))
                  .catch(() => {})
              }
            >
              <Copy />
            </Button>
          </div>
          <Button onClick={onClose}>Done</Button>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function LabelEdit({ ext, canEdit }: { ext: Extension; canEdit: boolean }) {
  const update = useUpdateExtension();
  const [value, setValue] = useState(ext.label ?? '');
  if (!canEdit) return <>{ext.label ?? NONE}</>;
  const save = () => value.trim() !== (ext.label ?? '') && update.mutate({ id: ext.id, label: value.trim() });
  return (
    <Input
      aria-label={`Label of ${ext.name}`}
      value={value}
      placeholder="—"
      className="h-8 max-w-48"
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function ExtensionsPage() {
  const extensions = useExtensions();
  const can = useCan('extensions');
  const update = useUpdateExtension();
  const newPassword = useNewSipPassword();
  const remove = useDeleteExtension();
  const [shown, setShown] = useState<SipPasswordReply | null>(null);
  const [toggling, setToggling] = useState<Extension | null>(null);
  const [rekeying, setRekeying] = useState<Extension | null>(null);
  const [deleting, setDeleting] = useState<Extension | null>(null);

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Extensions"
          description="The agents' phone lines - one per agent seat. To get more, contact your VIZTEX provider."
          actions={
            <>
              <Button variant="outline" onClick={() => extensions.refetch()} disabled={extensions.isFetching}>
                <RefreshCw className={extensions.isFetching ? 'animate-spin' : undefined} /> Refresh
              </Button>
            </>
          }
        />
        {extensions.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : extensions.error ? (
          <ErrorState message={extensions.error.message} onRetry={() => extensions.refetch()} />
        ) : extensions.data.length === 0 ? (
          <EmptyState icon={Headset} title="No extensions yet">
            Your VIZTEX provider sets up your agent seats. Once they are here, give each agent one in Users.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Extension</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Used by</TableHead>
                <TableHead>Connected</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {extensions.data.map((x) => (
                <TableRow key={x.id} className={x.enabled ? undefined : 'text-muted-foreground'}>
                  <TableCell className="font-semibold tabular-nums">{x.name}</TableCell>
                  <TableCell>
                    <LabelEdit ext={x} canEdit={can('edit')} />
                  </TableCell>
                  <TableCell>{x.used_by ?? NONE}</TableCell>
                  <TableCell>
                    {x.registered === null ? (
                      <span className="text-xs text-muted-foreground">unknown</span>
                    ) : x.registered ? (
                      <StatusPill tone="green">Online</StatusPill>
                    ) : (
                      <StatusPill tone="grey">Offline</StatusPill>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusPill tone={x.enabled ? 'green' : 'grey'}>{x.enabled ? 'Enabled' : 'Disabled'}</StatusPill>
                    {!x.has_password && <span className="ml-2 text-xs text-destructive">no password</span>}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {can('edit') && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setRekeying(x)}
                          aria-label={`New SIP password for ${x.name}`}
                        >
                          <KeyRound /> New password
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className={x.enabled ? 'text-destructive' : undefined}
                          onClick={() => setToggling(x)}
                          aria-label={`${x.enabled ? 'Disable' : 'Enable'} ${x.name}`}
                        >
                          <Power /> {x.enabled ? 'Disable' : 'Enable'}
                        </Button>
                      </>
                    )}
                    {can('delete') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setDeleting(x)}
                        aria-label={`Delete ${x.name}`}
                      >
                        <Trash2 /> Delete
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {shown && <PasswordDialog reply={shown} onClose={() => setShown(null)} />}
      <ConfirmDialog
        open={!!toggling}
        onOpenChange={(v) => {
          if (!v) {
            setToggling(null);
            update.reset();
          }
        }}
        title={`${toggling?.enabled ? 'Disable' : 'Enable'} extension ${toggling?.name}?`}
        description={
          toggling?.enabled
            ? 'It can no longer connect. A browser already connected stays until its registration ends - force-logout the agent on Live Agents to cut it at once.'
            : 'It can connect again with its current password.'
        }
        confirmLabel={toggling?.enabled ? 'Disable' : 'Enable'}
        destructive={!!toggling?.enabled}
        pending={update.isPending}
        error={update.error?.message}
        onConfirm={() =>
          toggling &&
          update.mutate(
            { id: toggling.id, enabled: !toggling.enabled },
            {
              onSuccess: () => {
                toast.success(`${toggling.name} ${toggling.enabled ? 'disabled' : 'enabled'}`);
                setToggling(null);
              },
            },
          )
        }
      />
      <ConfirmDialog
        open={!!rekeying}
        onOpenChange={(v) => {
          if (!v) {
            setRekeying(null);
            newPassword.reset();
          }
        }}
        title={`New SIP password for ${rekeying?.name}?`}
        description="The old password stops working. The agent screen picks up the new one when it next connects; a desk phone must be updated by hand."
        confirmLabel="Make new password"
        pending={newPassword.isPending}
        error={newPassword.error?.message}
        onConfirm={() =>
          rekeying &&
          newPassword.mutate(rekeying.id, {
            onSuccess: (r) => {
              setRekeying(null);
              setShown(r);
            },
          })
        }
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v) {
            setDeleting(null);
            remove.reset();
          }
        }}
        title={`Delete extension ${deleting?.name}?`}
        description="Asterisk stops knowing it. Users who have it lose it and are logged out. Past calls keep the number."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: (r) => {
              toastDeleted('Extension', r);
              setDeleting(null);
            },
          })
        }
      />
    </Card>
  );
}
