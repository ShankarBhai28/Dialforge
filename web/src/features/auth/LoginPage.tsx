import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { homeFor, useLogin, useMe } from './auth';

export function LoginPage() {
  const { data: user, isPending } = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Only follow ?next= inside this app.
  const next = params.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;

  if (isPending) return <FullPageSpinner />;
  if (user) return <Navigate to={safeNext ?? homeFor(user.role)} replace />;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    login.mutate(
      { username: username.trim(), password },
      { onSuccess: ({ user: u }) => navigate(safeNext ?? homeFor(u.role), { replace: true }) },
    );
  }

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

        {login.error && (
          <p role="alert" className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {login.error.message}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending && <LoaderCircle className="animate-spin" />}
          Sign in
        </Button>
      </form>
    </div>
  );
}
