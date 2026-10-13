import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { Info, LoaderCircle } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { homeFor, takeSessionEndedNotice, useLogin, useMe } from './auth';

export function LoginPage() {
  const { data: user, isPending } = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Why the last session ended (logged in on another computer), shown once.
  const [ended] = useState(takeSessionEndedNotice);

  // Only follow ?next= inside this app.
  const next = params.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;

  if (isPending) return <FullPageSpinner />;
  if (user) return <Navigate to={safeNext ?? homeFor(user.role)} replace />;

  function signIn(takeOver = false) {
    login.mutate(
      { username: username.trim(), password, ...(takeOver ? { takeOver: true } : {}) },
      { onSuccess: ({ user: u }) => navigate(safeNext ?? homeFor(u.role), { replace: true }) },
    );
  }
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    signIn();
  }
  const elsewhere = login.error instanceof ApiError && login.error.code === 'already_logged_in';

  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-ink to-ink-2 p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-lg bg-card p-8 shadow-card">
        <div className="mb-6 flex items-center gap-2 text-xl font-extrabold">
          <span className="size-2.5 rounded-full bg-primary shadow-[0_0_12px] shadow-primary" />
          DialForge
        </div>
        <h1 className="mb-1 text-lg font-bold">Sign in</h1>
        <p className="mb-6 text-sm text-muted-foreground">Use your DialForge username and password.</p>

        <div className="mb-4 grid gap-1.5">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            autoComplete="username"
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="mb-5 grid gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {ended && !login.error && (
          <p role="status" className="mb-4 flex gap-2 rounded-md bg-muted px-3 py-2 text-sm">
            <Info className="mt-0.5 size-4 shrink-0" />
            {ended}
          </p>
        )}
        {elsewhere ? (
          <div
            role="alert"
            className="mb-4 space-y-3 rounded-md border border-status-break/40 bg-status-break/10 p-3 text-sm"
          >
            <p className="font-semibold">You are already logged in on another browser or computer.</p>
            <p className="text-muted-foreground">
              Log in here and that screen will be closed (its phone line disconnects). An agent can only be logged in
              once, so calls don&apos;t ring in the wrong place.
            </p>
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={() => signIn(true)} disabled={login.isPending}>
                Log in here
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => login.reset()}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          login.error && (
            <p role="alert" className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {login.error.message}
            </p>
          )
        )}

        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending && <LoaderCircle className="animate-spin" />}
          Sign in
        </Button>
      </form>
    </div>
  );
}
