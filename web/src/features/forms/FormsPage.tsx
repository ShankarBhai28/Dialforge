// Forms: custom forms agents fill in during a call. List, build, (de)activate,
// delete, and view saved responses.
import { useState } from 'react';
import { toast } from 'sonner';
import { Eye, FilePlus2, Pencil, Plus, Power, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConfirmDialog, EmptyState, SectionHeader, StatusPill } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { toFormInput, useDeleteForm, useForms, useSaveForm, type Form } from './api';
import { FormBuilderDialog } from './FormBuilderDialog';
import { ResponsesDialog } from './ResponsesDialog';
import { useCanManage } from '@/features/auth/access';

export function FormsPage() {
  const manages = useCanManage('forms');
  const forms = useForms();
  const remove = useDeleteForm();
  // Separate from the builder's own mutation so its error shows in this dialog only.
  const toggle = useSaveForm();
  const [editing, setEditing] = useState<Form | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Form | null>(null);
  const [toggling, setToggling] = useState<Form | null>(null);
  const [viewing, setViewing] = useState<Form | null>(null);

  const deactivating = toggling?.status === 'active';

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Forms"
          description="Custom forms agents fill in during a call - attach an active form to a campaign from the Campaigns page."
          actions={
            <>
              <Button variant="outline" onClick={() => forms.refetch()}>
                <RefreshCw /> Refresh
              </Button>
              {manages && (
                <Button onClick={() => setEditing('new')}>
                  <Plus /> Create form
                </Button>
              )}
            </>
          }
        />

        {forms.isPending ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : forms.error ? (
          <ErrorState message={forms.error.message} onRetry={() => forms.refetch()} />
        ) : forms.data.length === 0 ? (
          <EmptyState icon={FilePlus2} title="No forms yet">
            Create a form with the fields agents should fill in, then pick it for a campaign.
          </EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Fields</TableHead>
                <TableHead>Used by campaigns</TableHead>
                <TableHead>Responses</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {forms.data.map((f) => (
                <TableRow key={f.id}>
                  <TableCell>
                    <div className="font-semibold">{f.name}</div>
                    {f.description && <div className="text-xs text-muted-foreground">{f.description}</div>}
                  </TableCell>
                  <TableCell className="min-w-40">
                    {/* * marks required fields */}
                    {f.fields.map((x) => x.label + (x.is_required ? '*' : '')).join(', ')}
                  </TableCell>
                  <TableCell>{f.campaigns ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="tabular-nums">{f.response_count}</TableCell>
                  <TableCell>
                    {f.status === 'active' ? (
                      <StatusPill tone="green">Active</StatusPill>
                    ) : (
                      <StatusPill tone="grey">Inactive</StatusPill>
                    )}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setViewing(f)}
                      aria-label={`Responses of ${f.name}`}
                    >
                      <Eye /> Responses
                    </Button>
                    {manages && (
                      <Button variant="ghost" size="sm" onClick={() => setEditing(f)} aria-label={`Edit ${f.name}`}>
                        <Pencil /> Edit
                      </Button>
                    )}
                    {manages && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setToggling(f)}
                        aria-label={`${f.status === 'active' ? 'Deactivate' : 'Activate'} ${f.name}`}
                      >
                        <Power /> {f.status === 'active' ? 'Deactivate' : 'Activate'}
                      </Button>
                    )}
                    {manages && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setDeleting(f)}
                        aria-label={`Delete ${f.name}`}
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

      {editing && (
        <FormBuilderDialog
          key={editing === 'new' ? 'new' : editing.id}
          form={editing === 'new' ? null : editing}
          onOpenChange={(v) => !v && setEditing(null)}
        />
      )}
      {viewing && <ResponsesDialog key={viewing.id} form={viewing} onOpenChange={(v) => !v && setViewing(null)} />}

      <ConfirmDialog
        open={!!toggling}
        onOpenChange={(v) => {
          if (!v) {
            setToggling(null);
            toggle.reset();
          }
        }}
        title={`${deactivating ? 'Deactivate' : 'Activate'} form "${toggling?.name}"?`}
        description={
          deactivating
            ? 'Agents stop seeing it. A form still used by a campaign cannot be deactivated - pick another form for those campaigns first.'
            : 'It can then be picked for a campaign again.'
        }
        confirmLabel={deactivating ? 'Deactivate' : 'Activate'}
        pending={toggle.isPending}
        error={toggle.error?.message}
        onConfirm={() =>
          toggling &&
          toggle.mutate(
            { id: toggling.id, body: toFormInput(toggling, deactivating ? 'inactive' : 'active') },
            {
              onSuccess: () => {
                toast.success(deactivating ? 'Form deactivated' : 'Form activated');
                setToggling(null);
              },
            },
          )
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
        title={`Delete form "${deleting?.name}"?`}
        description="A form used by a campaign or with saved responses can't be deleted - set it Inactive instead."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        error={remove.error?.message}
        onConfirm={() =>
          deleting &&
          remove.mutate(deleting.id, {
            onSuccess: () => {
              toast.success('Form deleted');
              setDeleting(null);
            },
          })
        }
      />
    </Card>
  );
}
