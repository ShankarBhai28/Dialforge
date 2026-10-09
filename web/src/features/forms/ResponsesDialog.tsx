// Saved answers of one form, one column per (current) field - reads like a
// spreadsheet of answers.
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { useFormResponses, type Form, type FormResponse } from './api';

const none = <span className="text-muted-foreground">—</span>;

// `data` is a JSON column; parse defensively in case it arrives as text.
function answers(r: FormResponse): Record<string, unknown> {
  if (typeof r.data !== 'string') return r.data ?? {};
  try {
    return JSON.parse(r.data) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function showValue(v: unknown) {
  if (v == null || v === '') return none;
  if (Array.isArray(v)) return v.length ? v.join(', ') : none;
  return String(v);
}

export function ResponsesDialog({ form, onOpenChange }: { form: Form; onOpenChange: (open: boolean) => void }) {
  const responses = useFormResponses(form.id);
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>
            Responses - {form.name}
            {responses.data && ` (latest ${responses.data.length})`}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="pb-5">
          {responses.isPending ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          ) : responses.error ? (
            <ErrorState message={responses.error.message} onRetry={() => responses.refetch()} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Lead</TableHead>
                  {form.fields.map((f) => (
                    <TableHead key={f.field_key}>{f.label}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {responses.data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4 + form.fields.length} className="py-6 text-center text-muted-foreground">
                      No responses yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  responses.data.map((r) => {
                    const a = answers(r);
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap">{formatDateTime(r.created_at)}</TableCell>
                        <TableCell>{r.username}</TableCell>
                        <TableCell>{r.campaign_name ?? none}</TableCell>
                        <TableCell className="tabular-nums">{r.lead_phone ?? none}</TableCell>
                        {form.fields.map((f) => (
                          <TableCell key={f.field_key}>{showValue(a[f.field_key])}</TableCell>
                        ))}
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
