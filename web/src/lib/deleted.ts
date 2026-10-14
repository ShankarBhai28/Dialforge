// After a delete: "Campaign deleted", plus what the server unlinked with it
// (e.g. "2 DID numbers no longer route to it") - deletes always work and
// keep history, so the admin is told what else changed.
import { toast } from 'sonner';
import { READ_TOAST } from '@/lib/toast';

export function toastDeleted(what: string, reply: unknown) {
  const notes = (reply as { notes?: string[] } | null)?.notes ?? [];
  toast.success(`${what} deleted`, notes.length ? { description: notes.join(' · '), ...READ_TOAST } : undefined);
}
