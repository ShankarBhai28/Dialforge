// Upload an .xlsx/.csv into a list, plus the template download for that list.
// Duplicate check: none / within the file / this list / this campaign / all
// campaigns; "Check file" shows what would happen without saving; every
// skipped row (with its reason) downloads as Excel.
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Download, FileSearch, FileSpreadsheet, LoaderCircle, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Field, FormError, SectionHeader } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { cn } from '@/lib/utils';
import { importReportUrl, templateUrl, useImportLeads, useLists, type DuplicateCheck, type ImportResult } from './api';

export const DUPLICATE_CHECKS: { key: DuplicateCheck; label: string; hint: string }[] = [
  {
    key: 'campaign',
    label: 'In this campaign (recommended)',
    hint: 'Skips numbers repeated in the file and numbers already in any list of this campaign.',
  },
  { key: 'list', label: 'In this list', hint: 'Skips repeats in the file and numbers already in the chosen list.' },
  {
    key: 'all',
    label: 'In all campaigns',
    hint: 'Skips repeats in the file and numbers already anywhere in the system.',
  },
  {
    key: 'file',
    label: 'Within this file only',
    hint: 'Skips only numbers repeated inside the file; numbers already in the system are added again.',
  },
  {
    key: 'none',
    label: 'No duplicate check',
    hint: 'Every valid row is added, even repeats - the same customer may be called more than once.',
  },
];
const CHECK_KEY = 'viztex-import-duplicate-check';
function rememberedCheck(): DuplicateCheck {
  try {
    const v = localStorage.getItem(CHECK_KEY) as DuplicateCheck | null;
    return v && DUPLICATE_CHECKS.some((c) => c.key === v) ? v : 'campaign';
  } catch {
    return 'campaign';
  }
}

function Count({ n, label, tone }: { n: number; label: string; tone: 'good' | 'warn' | 'bad' | 'muted' }) {
  return (
    <div
      className={cn(
        'rounded-md px-3 py-2',
        tone === 'good' && 'bg-status-available/12 text-status-available',
        tone === 'warn' && 'bg-status-break/12 text-status-break',
        tone === 'bad' && 'bg-destructive/10 text-destructive',
        tone === 'muted' && 'bg-muted text-muted-foreground',
      )}
    >
      <div className="text-xl font-bold tabular-nums">{n.toLocaleString('en-IN')}</div>
      <div className="text-xs font-medium">{label}</div>
    </div>
  );
}

export function ImportSummary({ result }: { result: ImportResult }) {
  const ok = result.wouldImport ?? result.imported;
  const checkLabel = DUPLICATE_CHECKS.find((c) => c.key === result.scope)?.label.replace(' (recommended)', '');
  return (
    <div className="grid gap-3" aria-label="Import result">
      <p
        role="status"
        className={cn(
          'rounded-md px-3 py-2 text-sm font-medium',
          result.dryRun ? 'bg-muted' : 'bg-status-available/12 text-status-available',
        )}
      >
        {result.dryRun
          ? `Checked only - nothing saved. ${ok} of ${result.total} row(s) would be imported.`
          : `Imported ${result.imported} of ${result.total}.`}
        {checkLabel && <span className="font-normal"> Duplicate check: {checkLabel}.</span>}
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Count n={ok} label={result.dryRun ? 'Would import' : 'Imported'} tone="good" />
        <Count n={result.inFile ?? 0} label="Repeated in file" tone="warn" />
        <Count
          n={result.existing ?? (result.inFile === undefined ? result.duplicates : 0)}
          label="Already exist"
          tone="warn"
        />
        <Count n={result.dnc} label="On DNC list" tone="muted" />
        <Count n={result.invalid} label="Invalid" tone="bad" />
      </div>
      {result.reportId && (
        <Button variant="outline" className="w-fit" asChild>
          <a href={importReportUrl(result.reportId)} download>
            <FileSpreadsheet /> Download skipped rows (.xlsx)
          </a>
        </Button>
      )}
      {result.errors.length > 0 && (
        <div className="rounded-md bg-status-break/12 px-3 py-2 text-sm text-status-break">
          <p className="font-semibold">
            Invalid rows
            {result.invalid > result.errors.length && ` (first ${result.errors.length} of ${result.invalid})`}:
          </p>
          <ul className="mt-1 max-h-60 space-y-0.5 overflow-y-auto">
            {result.errors.map((e) => (
              <li key={e.row}>
                Row {e.row}: {e.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ImportTab({ listId, onListChange }: { listId: number | null; onListChange: (id: number) => void }) {
  const lists = useLists();
  const upload = useImportLeads();
  const [file, setFile] = useState<File | null>(null);
  const [check, setCheck] = useState<DuplicateCheck>(rememberedCheck);
  // Bumped after a successful import to clear the file input.
  const [fileKey, setFileKey] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);

  // Falls back to the first list when none is picked (or the picked one is gone).
  const effectiveList = lists.data?.some((l) => l.id === listId) ? listId : (lists.data?.[0]?.id ?? null);

  function chooseCheck(v: DuplicateCheck) {
    setCheck(v);
    upload.reset(); // an earlier result was for the other setting
    try {
      localStorage.setItem(CHECK_KEY, v);
    } catch {
      /* private mode */
    }
  }

  function send(dryRun: boolean) {
    upload.reset();
    if (!effectiveList) return setLocalError('Create a list first.');
    if (!file) return setLocalError('Choose an .xlsx or .csv file first.');
    setLocalError(null);
    upload.mutate(
      { listId: effectiveList, file, duplicateCheck: check, dryRun },
      {
        onSuccess: (r) => {
          if (r.dryRun) return;
          toast.success(`Imported ${r.imported} lead(s)`);
          setFile(null);
          setFileKey((k) => k + 1);
        },
      },
    );
  }
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send(false);
  }
  const hint = DUPLICATE_CHECKS.find((c) => c.key === check)!.hint;

  return (
    <>
      <SectionHeader
        title="Import leads"
        description={
          <>
            Excel (.xlsx) or CSV. Needs a <code>phone</code> column; optional <code>name</code>, <code>alt_phone</code>,{' '}
            <code>priority</code>, plus one column per field of the campaign's form. <b>Download template</b> gives the
            exact columns for the selected list. Numbers on the DNC list and invalid rows are always skipped.
          </>
        }
      />
      {lists.isPending ? (
        <Skeleton className="h-32" />
      ) : lists.error ? (
        <ErrorState message={lists.error.message} onRetry={() => lists.refetch()} />
      ) : (
        <form onSubmit={onSubmit} className="grid max-w-2xl gap-4">
          <Field id="import-list" label="Into list">
            <Select
              id="import-list"
              value={effectiveList ?? ''}
              onChange={(e) => {
                upload.reset();
                onListChange(Number(e.target.value));
              }}
              disabled={lists.data.length === 0}
            >
              {lists.data.length === 0 && <option value="">No lists yet</option>}
              {lists.data.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.campaign_name ?? 'no campaign'})
                </option>
              ))}
            </Select>
          </Field>
          <Field id="import-file" label="File" hint="Max 5 MB, 20000 rows. Row 1 must be the column headers.">
            <Input
              key={fileKey}
              id="import-file"
              type="file"
              accept=".xlsx,.csv"
              className="h-auto py-2"
              onChange={(e) => {
                upload.reset();
                setFile(e.target.files?.[0] ?? null);
              }}
            />
          </Field>
          <Field id="import-dup" label="Duplicate check" hint={hint}>
            <Select id="import-dup" value={check} onChange={(e) => chooseCheck(e.target.value as DuplicateCheck)}>
              {DUPLICATE_CHECKS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={upload.isPending} onClick={() => send(true)}>
              {upload.isPending && upload.variables?.dryRun ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <FileSearch />
              )}
              Check file
            </Button>
            <Button type="submit" disabled={upload.isPending}>
              {upload.isPending && !upload.variables?.dryRun ? <LoaderCircle className="animate-spin" /> : <Upload />}
              {upload.isPending && !upload.variables?.dryRun ? 'Importing...' : 'Import'}
            </Button>
            <Button variant="outline" asChild>
              <a href={templateUrl('xlsx', effectiveList)} target="_blank" rel="noreferrer">
                <Download /> Template (.xlsx)
              </a>
            </Button>
            <Button variant="outline" asChild>
              <a href={templateUrl('csv', effectiveList)} target="_blank" rel="noreferrer">
                <Download /> .csv
              </a>
            </Button>
          </div>
          <FormError message={localError ?? (upload.error ? `Import failed: ${upload.error.message}` : null)} />
          {upload.data && <ImportSummary result={upload.data} />}
        </form>
      )}
    </>
  );
}
