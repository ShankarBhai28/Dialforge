import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '@/lib/api';

export const FIELD_TYPE_LABELS = {
  text: 'Text',
  textarea: 'Long text',
  number: 'Number',
  email: 'Email',
  phone: 'Phone',
  date: 'Date',
  dropdown: 'Dropdown',
  radio: 'Radio',
  checkbox: 'Checkbox',
} as const;
export type FieldType = keyof typeof FIELD_TYPE_LABELS;
export const TYPES_WITH_OPTIONS: FieldType[] = ['dropdown', 'radio', 'checkbox'];

// form_fields row; `options` is a JSON column (mysql2 parses it).
export type FormField = {
  id: number;
  form_id: number;
  field_key: string;
  label: string;
  field_type: FieldType;
  options: string[] | null;
  is_required: 0 | 1;
  sort_order: number;
};

// One row of GET /admin/forms.
export type Form = {
  id: number;
  name: string;
  description: string | null;
  status: 'active' | 'inactive';
  created_at: string;
  fields: FormField[];
  /** Comma-separated campaign names using this form. */
  campaigns: string | null;
  response_count: number;
};

export type FormResponse = {
  id: number;
  data: Record<string, unknown> | string;
  created_at: string;
  lead_id: number | null;
  call_id: number | null;
  username: string;
  campaign_name: string | null;
  lead_phone: string | null;
};

/** Body of POST/PUT /admin/forms. The server sets sort order from array order. */
export type FormInput = {
  name: string;
  description: string;
  status: 'active' | 'inactive';
  fields: { label: string; fieldKey: string; fieldType: FieldType; options: string[]; isRequired: boolean }[];
};

export const formKeys = {
  all: ['admin', 'forms'] as const,
  responses: (id: number) => ['admin', 'forms', id, 'responses'] as const,
};

export function useForms() {
  return useQuery({ queryKey: formKeys.all, queryFn: () => get<Form[]>('/admin/forms') });
}

export function useSaveForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: number; body: FormInput }) =>
      id ? put(`/admin/forms/${id}`, body) : post('/admin/forms', body),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: formKeys.all }),
  });
}

export function useDeleteForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => del(`/admin/forms/${id}`),
    meta: { errorInline: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: formKeys.all }),
  });
}

export function useFormResponses(id: number) {
  return useQuery({
    queryKey: formKeys.responses(id),
    queryFn: () => get<FormResponse[]>(`/admin/forms/${id}/responses`),
  });
}

/** A saved form as the save body - used to flip status without the builder. */
export function toFormInput(f: Form, status: Form['status'] = f.status): FormInput {
  return {
    name: f.name,
    description: f.description ?? '',
    status,
    fields: f.fields.map((x) => ({
      label: x.label,
      fieldKey: x.field_key,
      fieldType: x.field_type,
      options: x.options ?? [],
      isRequired: !!x.is_required,
    })),
  };
}
