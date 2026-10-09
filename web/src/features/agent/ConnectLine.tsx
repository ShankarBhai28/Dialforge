// Step 1 of a shift: pick the extension (desk phone) to use and register it.
// The choice is remembered, so a page refresh reconnects by itself.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Headset, LoaderCircle, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/form-controls';
import { Field, FormError } from '@/components/common';
import { get } from '@/lib/api';
import { meKey, useLogout, useMe } from '@/features/auth/auth';
import type { WebrtcConfig } from './api';
import { usePhone } from './AgentProvider';
import type { Softphone } from './softphone/softphone';

export const EXTENSION_KEY = 'dialforge_extension'; // same key as the classic page

/** Fetches the line settings + this extension's SIP password, then registers. */
async function registerLine(phone: Softphone, ext: string) {
  const [config, creds] = await Promise.all([
    get<WebrtcConfig>('/agent/webrtc-config'),
    get<{ extension: string; sipPassword: string }>(`/agent/extension-credentials/${encodeURIComponent(ext)}`),
  ]);
  phone.connect({ extension: creds.extension, password: creds.sipPassword, ...config });
}

function savedExtension() {
  try {
    return localStorage.getItem(EXTENSION_KEY);
  } catch {
    return null;
  }
}

/**
 * Once the line registers: remember the extension (refresh reconnects by
 * itself) and reload the user, whose session now carries this extension.
 * Used by the parent screen - ConnectLine itself unmounts on registration.
 */
export function useRememberLine() {
  const { line } = usePhone();
  const qc = useQueryClient();
  useEffect(() => {
    if (line.reg !== 'registered' || !line.extension) return;
    try {
      localStorage.setItem(EXTENSION_KEY, line.extension);
    } catch {
      /* private mode */
    }
    void qc.invalidateQueries({ queryKey: meKey });
  }, [line.reg, line.extension, qc]);
}

/** The extensions this agent may use; null = any (their teams don't limit it). */
function useAllowedExtensions() {
  return useQuery({
    queryKey: ['agent', 'extensions'],
    queryFn: () => get<{ allowed: string[] | null }>('/agent/extensions'),
    select: (d) => d.allowed,
  });
}

export function ConnectLine() {
  const { data: me } = useMe();
  // On error this stays undefined and the free-text box is shown; the
  // server still refuses an extension the agent may not use.
  const { data: allowed } = useAllowedExtensions();
  const { phone, line } = usePhone();
  const logout = useLogout();
  const [extension, setExtension] = useState(() => savedExtension() ?? me?.extensionName ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect(ext: string) {
    if (!ext) return setError('Extension is required');
    setBusy(true);
    setError(null);
    try {
      await registerLine(phone, ext);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Reconnect automatically after a page refresh.
  const tried = useRef(false);
  useEffect(() => {
    const saved = savedExtension();
    if (tried.current || !saved || phone.getSnapshot().reg !== 'idle') return;
    tried.current = true;
    registerLine(phone, saved).catch((err: Error) => setError(err.message));
  }, [phone]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const ext = extension.trim();
    // A remembered extension the team no longer allows shows as "Choose…" - send what is shown.
    void connect(allowed && !allowed.includes(ext) ? '' : ext);
  }

  const connecting = busy || line.reg === 'connecting';
  const regError = line.reg === 'failed' ? `Registration failed: ${line.regError}` : null;
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-ink to-ink-2 p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-lg bg-card p-8 shadow-card">
        <div className="mb-5 flex size-12 items-center justify-center rounded-lg bg-accent text-accent-foreground">
          <Headset className="size-6" />
        </div>
        <h1 className="text-lg font-bold">Connect your line</h1>
        <p className="mb-5 text-sm text-muted-foreground">
          Hi {me?.username}. Choose the extension for this shift; calls ring here in the browser.
        </p>
        <Field id="ext" label="Extension" className="mb-4">
          {allowed ? (
            <Select
              id="ext"
              value={allowed.includes(extension) ? extension : ''}
              onChange={(e) => setExtension(e.target.value)}
              autoFocus
            >
              <option value="">Choose…</option>
              {allowed.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              id="ext"
              value={extension}
              onChange={(e) => setExtension(e.target.value)}
              placeholder="e.g. 1001"
              inputMode="numeric"
              autoFocus
            />
          )}
        </Field>
        <FormError message={error ?? regError} />
        <Button type="submit" className="mt-4 w-full" disabled={connecting}>
          {connecting && <LoaderCircle className="animate-spin" />}
          {connecting ? 'Connecting…' : 'Connect'}
        </Button>
        <Button type="button" variant="ghost" className="mt-2 w-full" onClick={() => logout.mutate()}>
          <LogOut /> Log out
        </Button>
      </form>
    </div>
  );
}
