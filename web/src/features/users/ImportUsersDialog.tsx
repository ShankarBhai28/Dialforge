// Bulk user import: agent accounts from an Excel / CSV file. Choosing a file
// checks it straight away (nothing is saved) and lists every problem by row;
// "Create" is only offered once the whole file is clean - the server creates
// all accounts or none.
import { useState } from 'react';
import { toast } from 'sonner';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { Field, FormError } from '@/components/common';
import { useAccess } from '@/features/auth/access';
import { useCheckUserImport, useImportUsers } from './api';

// A starting file: the four columns and two example rows (replace them).
const TEMPLATE =
  'username,password,extension,team\nagent1001,ChangeMe-1001,1001,TL 1\nagent1002,ChangeMe-1002,1002,TL 1\n';
const TEMPLATE_URL = `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`;

export function ImportUsersDialog({ onOpenChange }: { onOpenChange: (v: boolean) => void }) {
  const { teamScope } = useAccess();
  const check = useCheckUserImport();
  const create = useImportUsers();
  const [file, setFile] = useState<File | null>(null);
  const result = check.data;
  const clean = !!file && !!result && result.problems.length === 0 && result.ready > 0;

  function choose(f: File | null) {
    setFile(f);
    create.reset();
    if (f) check.mutate(f);
    else check.reset();
  }

  function onCreate() {
    if (!file) return;
    create.mutate(file, {
      onSuccess: (r) => {
        toast.success(`Created ${r.created} agent account${r.created === 1 ? '' : 's'}`);
        onOpenChange(false);
      },
    });
  }

  return (
    <Dialog open onOpenChange={(v) => !create.isPending && onOpenChange(v)}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Import agents</DialogTitle>
          <DialogDescription>
            An Excel (.xlsx) or CSV file with the columns <b>username, password, extension, team</b> - one agent per
            row, up to 500 per file. The file is checked first; accounts are created only when every row is fine.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <div className="text-sm text-muted-foreground">
            Team is the team&apos;s name as on the Teams screen
            {teamScope ? ' - one of your teams (required).' : ' (optional).'} Extensions must exist already.{' '}
            <a
              className="inline-flex items-center gap-1 text-primary underline"
              href={TEMPLATE_URL}
              download="agents.csv"
            >
              <Download className="size-3" /> Template
            </a>
          </div>
          <Field id="import-file" label="File">
            <Input
              id="import-file"
              type="file"
              accept=".xlsx,.csv"
              onChange={(e) => choose(e.target.files?.[0] ?? null)}
              disabled={create.isPending}
            />
          </Field>

          {check.isPending && <p className="text-sm text-muted-foreground">Checking the file…</p>}
          <FormError message={check.error?.message} />
          {result && (
            <div className="grid gap-2" aria-label="Check result">
              <p className="text-sm">
                <b>{result.ready}</b> ready
                {result.problems.length > 0 && (
                  <>
                    , <b className="text-destructive">{result.problems.length}</b> with problems - fix them in the file
                    and choose it again.
                  </>
                )}
              </p>
              {result.problems.length > 0 && (
                <div className="max-h-64 overflow-y-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Row</TableHead>
                        <TableHead>Username</TableHead>
                        <TableHead>Problem</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {result.problems.map((p) => (
                        <TableRow key={p.rowNum}>
                          <TableCell>{p.rowNum}</TableCell>
                          <TableCell>{p.username || '-'}</TableCell>
                          <TableCell>{p.error}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
          {create.isPending && (
            <p className="text-sm text-muted-foreground">
              Creating the accounts - about a minute for 500, keep this open…
            </p>
          )}
          <FormError message={create.error?.message} />
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={onCreate} disabled={!clean || create.isPending}>
            {clean ? `Create ${result.ready} agent${result.ready === 1 ? '' : 's'}` : 'Create agents'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
