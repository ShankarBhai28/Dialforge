// Campaigns: list, create/edit with all dialer settings, delete, and the
// per-campaign Dispositions and Recycle rules editors (tabs in one dialog).
import { useState } from 'react';
import { toast } from 'sonner';
import { ListChecks, Megaphone, Pencil, Plus, Repeat, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog, EmptyState, SectionHeader, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { useCampaigns, useDeleteCampaign, type Campaign } from './api';
import { CampaignSettingsForm } from './CampaignSettingsForm';
import { DispositionsEditor } from './DispositionsEditor';
import { RecycleRulesEditor } from './RecycleRulesEditor';
import { useAccess } from '@/features/auth/access';

type Tab = 'settings' | 'dispositions' | 'recycle';

/** "Progressive 1.5:1", "Predictive ≤2.5:1", like the classic Mode column. */
function modeText(c: Campaign) {
  const mode = c.dial_mode.charAt(0).toUpperCase() + c.dial_mode.slice(1);
  if (c.dial_mode === 'progressive') return `${mode} ${Number(c.dial_ratio)}:1`;
  if (c.dial_mode === 'predictive') return `${mode} ≤${Number(c.max_dial_ratio)}:1`;
  return mode;
}

const dash = <span className="text-muted-foreground">—</span>;

function CampaignDialog({
  campaign,
  initialTab,
  onClose,
}: {
  campaign: Campaign | null;
  initialTab: Tab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>{campaign ? campaign.name : 'Create campaign'}</DialogTitle>
          <DialogDescription>
            {campaign
              ? 'Each tab saves on its own.'
              : 'A campaign references a queue, plus its outbound CLI and auto-answer behavior. It starts with the default dispositions; edit them after creating it.'}
          </DialogDescription>
        </DialogHeader>
        {campaign ? (
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex min-h-0 flex-1 flex-col">
            <div className="px-5">
              <TabsList>
                <TabsTrigger value="settings">Settings</TabsTrigger>
                <TabsTrigger value="dispositions">Dispositions</TabsTrigger>
                <TabsTrigger value="recycle">Recycle rules</TabsTrigger>
              </TabsList>
            </div>
            {/* forceMount + hidden keeps unsaved edits when switching tabs */}
            {(
              [
                ['settings', <CampaignSettingsForm key="s" campaign={campaign} onDone={onClose} />],
                ['dispositions', <DispositionsEditor key="d" campaignId={campaign.id} onClose={onClose} />],
                ['recycle', <RecycleRulesEditor key="r" campaignId={campaign.id} onClose={onClose} />],
              ] as const
            ).map(([value, panel]) => (
              <TabsContent
                key={value}
                value={value}
                forceMount
                className="mt-3 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
              >
                {panel}
              </TabsContent>
            ))}
          </Tabs>
        ) : (
          <CampaignSettingsForm campaign={null} onDone={onClose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function CampaignsPage() {
  const { canManage, teamScope } = useAccess();
  const manages = canManage('campaigns');
  // Creating or deleting a campaign reaches outside a team-scoped role's teams.
  const managesAll = manages && !teamScope;
  const campaigns = useCampaigns();
  const remove = useDeleteCampaign();
  // null = closed; otherwise which campaign (or 'new') and which tab to open on.
  const [open, setOpen] = useState<{ campaign: Campaign | 'new'; tab: Tab } | null>(null);
  const [deleting, setDeleting] = useState<Campaign | null>(null);

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Campaigns"
          description="A campaign references a queue, plus its outbound CLI, auto-answer behavior and dialer settings."
          actions={
            managesAll && (
              <Button onClick={() => setOpen({ campaign: 'new', tab: 'settings' })}>
                <Plus /> Create campaign
              </Button>
            )
          }
        />

        {campaigns.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : campaigns.error ? (
          <ErrorState message={campaigns.error.message} onRetry={() => campaigns.refetch()} />
        ) : campaigns.data.length === 0 ? (
          <EmptyState icon={Megaphone} title="No campaigns yet">
            Create a campaign, pick the queue whose agents take its calls, then load leads into a list for it.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Queue</TableHead>
                <TableHead>Outbound Caller ID</TableHead>
                <TableHead>Auto answer</TableHead>
                <TableHead>Form</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.data.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-semibold">{c.name}</TableCell>
                  <TableCell>{c.queue_name ?? dash}</TableCell>
                  <TableCell className="tabular-nums">{c.outbound_caller_id || dash}</TableCell>
                  <TableCell>{c.auto_answer ? 'Yes' : 'No'}</TableCell>
                  <TableCell>{c.form_name ?? dash}</TableCell>
                  <TableCell className="whitespace-nowrap">{modeText(c)}</TableCell>
                  <TableCell>
                    <StatusPill tone={c.status === 'active' ? 'green' : 'amber'}>
                      {c.status === 'active' ? 'Active' : c.status === 'paused' ? 'Paused' : c.status}
                    </StatusPill>
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {manages && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setOpen({ campaign: c, tab: 'settings' })}
                        aria-label={`Edit ${c.name}`}
                      >
                        <Pencil /> Edit
                      </Button>
                    )}
                    {manages && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setOpen({ campaign: c, tab: 'dispositions' })}
                        aria-label={`Dispositions for ${c.name}`}
                      >
                        <ListChecks /> Dispositions
                      </Button>
                    )}
                    {manages && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setOpen({ campaign: c, tab: 'recycle' })}
                        aria-label={`Recycle rules for ${c.name}`}
                      >
                        <Repeat /> Recycle rules
                      </Button>
                    )}
                    {managesAll && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setDeleting(c)}
                        aria-label={`Delete ${c.name}`}
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

      {open && (
        <CampaignDialog
          // fresh form state per campaign
          key={open.campaign === 'new' ? 'new' : open.campaign.id}
          campaign={open.campaign === 'new' ? null : open.campaign}
          initialTab={open.tab}
          onClose={() => setOpen(null)}
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
        title={`Delete campaign "${deleting?.name}"?`}
        description="Only possible when no DID numbers, leads, calls, form responses or callbacks still use it."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('Campaign deleted');
              setDeleting(null);
            },
          })
        }
      />
    </Card>
  );
}
