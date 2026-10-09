// Manual recycle of one list: tick lead statuses to make dialable again now.
import { useState } from 'react';
import { toast } from 'sonner';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/form-controls';
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
import { FormError } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { formatDateTime } from '@/lib/format';
import { useRecycleInfo, useRecycleList, type LeadList, type RecycleInfo, type RecycleResult } from './api';
import { RECYCLE_DEFAULT_TICK } from './statuses';

const defaultPicks = (info: RecycleInfo) =>
  info.statuses.filter((s) => s.recyclable && RECYCLE_DEFAULT_TICK.includes(s.status)).map((s) => s.status);

function resultMessage(r: RecycleResult) {
  const skipped = [r.skippedDnc ? `${r.skippedDnc} on DNC` : '', r.skippedOnCall ? `${r.skippedOnCall} on a call` : '']
    .filter(Boolean)
    .join(', ');
  return `${r.recycled} lead(s) recycled${skipped ? ` (skipped: ${skipped})` : ''}. A running campaign dials them within seconds.`;
}

export function RecycleDialog({ list, onOpenChange }: { list: LeadList; onOpenChange: (open: boolean) => void }) {
  const info = useRecycleInfo(list.id);
  const recycle = useRecycleList(list.id);
  // null = the admin hasn't touched the ticks yet, so the defaults apply.
  const [picked, setPicked] = useState<string[] | null>(null);
  const [resetAttempts, setResetAttempts] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const data = info.data;
  const ticks = picked ?? (data ? defaultPicks(data) : []);
  // Only statuses still in the list and allowed to recycle are sent.
  const chosen = data ? data.statuses.filter((s) => s.recyclable && ticks.includes(s.status)).map((s) => s.status) : [];

  function toggle(status: string, on: boolean) {
    setPicked(on ? [...ticks, status] : ticks.filter((s) => s !== status));
    setConfirming(false);
  }

  function onRecycle() {
    setResult(null);
    recycle.reset();
    if (!chosen.length) {
      setLocalError('Tick at least one status');
      return;
    }
    setLocalError(null);
    setConfirming(true);
  }

  function onConfirm() {
    recycle.mutate(
      { statuses: chosen, resetAttempts },
      {
        onSuccess: (r) => {
          setConfirming(false);
          setResult(resultMessage(r));
          toast.success(`${r.recycled} lead(s) recycled`);
        },
        onError: () => setConfirming(false),
      },
    );
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Recycle list - {data?.list.name ?? list.name}</DialogTitle>
          <DialogDescription>
            Make leads dialable again <b>right away</b>: tick the statuses to redial, then Recycle. Leads on the DNC
            list, Do Not Call leads and leads on a call right now are never recycled. Final outcomes (e.g. Interested)
            are unticked by default - only tick them if you really want those customers called again.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-3">
          {info.isPending ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-9" />
              ))}
            </div>
          ) : info.error ? (
            <ErrorState message={info.error.message} onRetry={() => info.refetch()} />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <span className="sr-only">Pick</span>
                    </TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Leads</TableHead>
                    <TableHead>Dialable now</TableHead>
                    <TableHead>Waiting for retry</TableHead>
                    <TableHead>Done (final / attempts used)</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {info.data.statuses.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                        This list has no leads.
                      </TableCell>
                    </TableRow>
                  ) : (
                    info.data.statuses.map((s) => (
                      <TableRow key={s.status}>
                        <TableCell>
                          <Checkbox
                            aria-label={`Recycle ${s.label ?? s.status}`}
                            checked={s.recyclable && ticks.includes(s.status)}
                            disabled={!s.recyclable}
                            title={s.recyclable ? undefined : 'never recycled'}
                            onChange={(e) => toggle(s.status, e.target.checked)}
                          />
                        </TableCell>
                        <TableCell>
                          {s.label ?? s.status}
                          {s.label && <span className="text-muted-foreground"> ({s.status})</span>}
                          {!s.recyclable && <span className="text-xs text-muted-foreground"> - never recycled</span>}
                        </TableCell>
                        <TableCell className="tabular-nums">{s.total}</TableCell>
                        <TableCell className="tabular-nums">{s.dialable}</TableCell>
                        <TableCell className="tabular-nums">{s.scheduled}</TableCell>
                        <TableCell className="tabular-nums">{s.done}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>

              <label className="inline-flex items-center gap-2 text-sm">
                <Checkbox
                  checked={resetAttempts}
                  onChange={(e) => {
                    setResetAttempts(e.target.checked);
                    setConfirming(false);
                  }}
                />
                Reset attempt count to 0 (needed for leads that used all {info.data.list.maxAttempts} attempts)
              </label>

              {confirming && (
                <div className="rounded-md bg-status-break/12 px-3 py-2 text-sm">
                  Make all leads with status <b>{chosen.join(', ')}</b> dialable again now?
                  {resetAttempts && ' Their attempt counts go back to 0.'}
                </div>
              )}
              <FormError message={localError ?? recycle.error?.message} />
              {result && (
                <p role="status" className="rounded-md bg-status-available/12 px-3 py-2 text-sm text-status-available">
                  {result}
                </p>
              )}

              {info.data.history.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  <p className="font-semibold">Recent</p>
                  <ul className="mt-1 space-y-0.5">
                    {info.data.history.map((h, i) => (
                      <li key={i}>
                        {formatDateTime(h.created_at)} - {h.username ?? '?'} recycled {h.leads_recycled} ({h.statuses}
                        {h.reset_attempts ? ', attempts reset' : ''})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => (confirming ? setConfirming(false) : onOpenChange(false))}
          >
            {confirming ? 'Back' : 'Close'}
          </Button>
          {confirming ? (
            <Button onClick={onConfirm} disabled={recycle.isPending}>
              {recycle.isPending && <LoaderCircle className="animate-spin" />}
              Yes, recycle
            </Button>
          ) : (
            <Button onClick={onRecycle} disabled={!info.data || info.data.statuses.length === 0}>
              <RotateCcw /> Recycle
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
