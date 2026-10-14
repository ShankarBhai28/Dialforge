import { useMutation, useQueryClient } from '@tanstack/react-query';
import { del, post, put } from '@/lib/api';
import { useExtensions, userKeys, type Extension } from '@/features/users/api';

// GET /admin/extensions is shared with Users (the extension picker), so the
// same query and cache key are used here.
export { useExtensions, type Extension };

/** New password: the only time the server returns the SIP password. */
export type SipPasswordReply = { id: number; name: string; sipPassword: string };

export function useUpdateExtension() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; label?: string; enabled?: boolean }) =>
      put(`/admin/extensions/${id}`, body),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: userKeys.extensions }),
  });
}

export function useNewSipPassword() {
  return useMutation({
    mutationFn: (id: number) => post<SipPasswordReply>(`/admin/extensions/${id}/password`),
    meta: { errorInline: true },
  });
}

export function useDeleteExtension() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => del(`/admin/extensions/${id}`),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: userKeys.extensions }),
  });
}
