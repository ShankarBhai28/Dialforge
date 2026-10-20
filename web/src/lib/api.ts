// The one way screens talk to the backend. Same-origin, cookie session
// (the backend's existing login), JSON in and out. Errors become ApiError
// carrying the server's own `{ error: "..." }` message.

export class ApiError extends Error {
  readonly status: number;
  /** The server's machine-readable reason, when it gives one (e.g. 'already_logged_in'). */
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** keepalive: the request still goes out while the page closes (small bodies only). */
export async function api<T>(
  path: string,
  options: { method?: Method; body?: unknown; keepalive?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, keepalive } = options;
  let res: Response;
  // FormData (file uploads) goes as-is: the browser sets the multipart header.
  const isForm = body instanceof FormData;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      keepalive,
      headers: body === undefined || isForm ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server - check your connection.');
  }
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const data: unknown = isJson ? await res.json() : null;
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed (${res.status})`;
    const code = data && typeof data === 'object' && 'code' in data && typeof data.code === 'string' ? data.code : null;
    throw new ApiError(res.status, message, code);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body ?? {} });
export const put = <T>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body: body ?? {} });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** The screen shows this mutation's error itself, so skip the global toast. */
      errorInline?: boolean;
    };
  }
}
