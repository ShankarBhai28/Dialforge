// Upload an .xlsx/.csv into a list, plus the template download for that list.
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Download, LoaderCircle, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
import { Skeleton } from '@/components/ui/skeleton';
import { Field, FormError, SectionHeader } from '@/components/common';
import { ErrorState } from '@/components/ErrorState';
import { templateUrl, useImportLeads, useLists, type ImportResult } from './api';

export function ImportSummary({ result }: { result: ImportResult }) {
  return (
    <div className="grid gap-2" aria-label="Import result">
      <p role="status" className="rounded-md bg-status-available/12 px-3 py-2 text-sm text-status-available">
        Imported {result.imported} of {result.total} ({result.duplicates} duplicate, {result.dnc} on DNC list,{' '}
        {result.invalid} invalid).
      </p>
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
  // Bumped after a successful import to clear the file input.
  const [fileKey, setFileKey] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);

  // Falls back to the first list when none is picked (or the picked one is gone).
  const effectiveList = lists.data?.some((l) => l.id === listId) ? listId : (lists.data?.[0]?.id ?? null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    upload.reset();
    if (!effectiveList) return setLocalError('Create a list first.');
    if (!file) return setLocalError('Choose an .xlsx or .csv file first.');
    setLocalError(null);
    upload.mutate(
      { listId: effectiveList, file },
      {
        onSuccess: (r) => {
          toast.success(`Imported ${r.imported} lead(s)`);
          setFile(null);
          setFileKey((k) => k + 1);
        },
      },
    );
  }

  return (
    <>
      <SectionHeader
        title="Import leads"
        description={
          <>
            Excel (.xlsx) or CSV. Needs a <code>phone</code> column; optional <code>name</code>, <code>alt_phone</code>,{' '}
            <code>priority</code>, plus one column per field of the campaign's form. <b>Download template</b> gives the
            exact columns for the selected list. Numbers already in the campaign, repeated in the file, or on the DNC
            list are skipped.
          </>
        }
      />
      {lists.isPending ? (
        <Skeleton className="h-32" />
      ) : lists.error ? (
        <ErrorState message={lists.error.message} onRetry={() => lists.refetch()} />
      ) : (
        <form onSubmit={onSubmit} className="grid max-w-xl gap-4">
          <Field id="import-list" label="Into list">
            <Select
              id="import-list"
              value={effectiveList ?? ''}
              onChange={(e) => onListChange(Number(e.target.value))}
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
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={upload.isPending}>
              {upload.isPending ? <LoaderCircle className="animate-spin" /> : <Upload />}
              {upload.isPending ? 'Importing...' : 'Import'}
            </Button>
            <Button variant="outline" asChild>
              <a href={templateUrl('xlsx', effectiveList)} target="_blank" rel="noreferrer">
                <Download /> Download template (.xlsx)
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
