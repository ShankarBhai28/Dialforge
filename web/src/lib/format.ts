// Dates come from the API as ISO strings (MySQL DATETIME via mysql2) and are
// shown in the browser's local time, like the classic screens.
const dt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const d = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' });
const t = new Intl.DateTimeFormat('en-IN', { timeStyle: 'short' });

const valid = (v: string | number | Date | null | undefined): v is string | number | Date =>
  v !== null && v !== undefined && v !== '' && !Number.isNaN(new Date(v).getTime());

export const formatDateTime = (v: string | number | Date | null | undefined) =>
  valid(v) ? dt.format(new Date(v)) : '—';
export const formatDate = (v: string | number | Date | null | undefined) => (valid(v) ? d.format(new Date(v)) : '—');
export const formatTime = (v: string | number | Date | null | undefined) => (valid(v) ? t.format(new Date(v)) : '—');

/** Value for <input type="datetime-local"> in the browser's time zone. */
export function toDateTimeLocal(v: string | number | Date) {
  const x = new Date(v);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

/** Value for <input type="date"> (local date). */
export function toDateInput(v: string | number | Date = new Date()) {
  return toDateTimeLocal(v).slice(0, 10);
}
