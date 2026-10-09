// Step 1 of a shift: connect the browser line. The extension is the one the
// admin assigned (Users screen) - shown here, not chosen. Once connected,
// a page refresh reconnects by itself.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Headset, LoaderCircle, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/common';
import { get } from '@/lib/api';
import { meKey, useLogout, useMe } from '@/features/auth/auth';
import type { WebrtcConfig } from './api';
import { usePhone } from './AgentProvider';
import type { Softphone } from './softphone/softphone';

/** Set while the agent is connected, so a refresh reconnects; cleared on logout. */
export const EXTENSION_KEY = 'dialforge_extension';

/** Fetches the line settings + the agent's own extension and SIP password, then registers. */
async function registerLine(phone: Softphone) {
  const [config, creds] = await Promise.all([
    get<WebrtcConfig>('/agent/webrtc-config'),
    get<{ extension: string; sipPassword: string }>('/agent/extension-credentials'),
  ]);
  phone.connect({ extension: creds.extension, password: creds.sipPassword, ...config });
}

function wasConnected() {
  try {
    return !!localStorage.getItem(EXTENSION_KEY);
  } catch {
    return false;
  }
}

/**
 * Once the line registers: remember it (refresh reconnects by itself) and
 * reload the user, whose session now carries the extension.
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

export function ConnectLine() {
  const { data: me } = useMe();
  const { phone, line } = usePhone();
  const logout = useLogout();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      await registerLine(phone);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Reconnect automatically after a page refresh.
  const tried = useRef(false);
  useEffect(() => {
    if (tried.current || !wasConnected() || phone.getSnapshot().reg !== 'idle') return;
    tried.current = true;
    registerLine(phone).catch((err: Error) => setError(err.message));
  }, [phone]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void connect();
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
        <p className="mb-5 text-sm text-muted-foreground">Hi {me?.username}. Calls ring here in the browser.</p>
        <div className="mb-4 flex items-center justify-between rounded-md border bg-muted/40 px-3.5 py-2.5">
          <span className="text-sm text-muted-foreground">Your extension</span>
          <span className="font-bold tabular-nums" aria-label="Your extension">
            {me?.extensionName ?? '—'}
          </span>
        </div>
        <FormError message={error ?? regError} />
        <Button type="submit" className="mt-4 w-full" disabled={connecting} autoFocus>
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
