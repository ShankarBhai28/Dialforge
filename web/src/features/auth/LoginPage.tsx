// The login page: the product on the left (large screens), the sign-in card
// on the right. Show / hide password, Caps Lock warning, "remember my
// username" (this browser only - never the password), the "logged in
// elsewhere" takeover prompt and why the last session ended.
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import {
  ArrowRight,
  BarChart3,
  Eye,
  EyeOff,
  Headphones,
  Info,
  LoaderCircle,
  LockKeyhole,
  PhoneCall,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import { ApiError } from '@/lib/api';
import { APP_NAME, APP_TAGLINE } from '@/lib/brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/form-controls';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { Logo } from '@/components/Logo';
import { homeFor, takeSessionEndedNotice, useLogin, useMe } from './auth';

const REMEMBER_KEY = 'viztex-remember-username';
function rememberedUsername() {
  try {
    return localStorage.getItem(REMEMBER_KEY) ?? '';
  } catch {
    return '';
  }
}

const FEATURES = [
  { icon: PhoneCall, title: 'Every way to dial', text: 'Manual, preview, progressive and predictive - on one screen.' },
  { icon: Headphones, title: 'Live supervision', text: 'Listen, whisper or barge; every call recorded.' },
  {
    icon: BarChart3,
    title: 'Reports and history',
    text: 'Agent, campaign and dialer reports; every customer’s story.',
  },
];

/** Left half on large screens: what this is. */
function Showcase() {
  return (
    <aside className="relative hidden overflow-hidden bg-gradient-to-br from-ink via-ink to-ink-2 p-12 text-white lg:flex lg:flex-col">
      {/* soft light + fine grid, purely decorative */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 -left-24 size-96 rounded-full bg-teal-400/20 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -bottom-40 size-[28rem] rounded-full bg-teal-300/10 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:linear-gradient(white_1px,transparent_1px),linear-gradient(90deg,white_1px,transparent_1px)] [background-size:40px_40px]"
      />
      <Logo tone="light" className="relative text-2xl" markClassName="size-10" />
      <div className="relative my-auto max-w-md py-12">
        <p className="mb-3 text-sm font-semibold tracking-widest text-teal-300 uppercase">{APP_TAGLINE}</p>
        <h2 className="text-4xl leading-tight font-extrabold">Every call, every customer, one screen.</h2>
        <ul className="mt-10 space-y-6">
          {FEATURES.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-4">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
                <Icon className="size-5 text-teal-300" />
              </span>
              <span>
                <span className="block font-semibold">{title}</span>
                <span className="block text-sm text-white/70">{text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="relative text-xs text-white/50">
        © {new Date().getFullYear()} {APP_NAME}
      </p>
    </aside>
  );
}

export function LoginPage() {
  const { data: user, isPending } = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState(rememberedUsername);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(() => rememberedUsername() !== '');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  // Why the last session ended (logged in on another computer), shown once.
  const [ended] = useState(takeSessionEndedNotice);

  // Only follow ?next= inside this app.
  const next = params.get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : null;

  if (isPending) return <FullPageSpinner />;
  if (user) return <Navigate to={safeNext ?? homeFor(user.role)} replace />;

  function signIn(takeOver = false) {
    const name = username.trim();
    try {
      if (remember) localStorage.setItem(REMEMBER_KEY, name);
      else localStorage.removeItem(REMEMBER_KEY);
    } catch {
      /* private mode */
    }
    login.mutate(
      { username: name, password, ...(takeOver ? { takeOver: true } : {}) },
      { onSuccess: ({ user: u }) => navigate(safeNext ?? homeFor(u.role), { replace: true }) },
    );
  }
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    signIn();
  }
  const watchCaps = (e: KeyboardEvent<HTMLInputElement>) => setCapsLock(e.getModifierState?.('CapsLock') ?? false);
  const elsewhere = login.error instanceof ApiError && login.error.code === 'already_logged_in';

  return (
    <div className="grid min-h-full bg-background lg:grid-cols-[1.1fr_1fr]">
      <Showcase />
      <main className="flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-sm">
          <Logo className="mb-8 text-2xl lg:hidden" markClassName="size-10" />
          <form onSubmit={onSubmit} className="rounded-xl bg-card p-7 shadow-card ring-1 ring-border sm:p-8">
            <h1 className="text-2xl font-extrabold tracking-tight">Sign in</h1>
            <p className="mt-1 mb-6 text-sm text-muted-foreground">
              Welcome back to {APP_NAME}. Use your username and password.
            </p>

            <div className="mb-4 grid gap-1.5">
              <Label htmlFor="username">Username</Label>
              <div className="relative">
                <UserRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="username"
                  autoComplete="username"
                  autoFocus={!username}
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="h-11 pl-9"
                />
              </div>
            </div>
            <div className="mb-2 grid gap-1.5">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <LockKeyhole className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  autoFocus={!!username}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={watchCaps}
                  onKeyUp={watchCaps}
                  onBlur={() => setCapsLock(false)}
                  className="h-11 pr-10 pl-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute top-1/2 right-1.5 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {capsLock && (
                <p className="flex items-center gap-1.5 text-xs font-medium text-status-break">
                  <TriangleAlert className="size-3.5" /> Caps Lock is on
                </p>
              )}
            </div>
            <label className="mb-5 flex w-fit cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember my username
            </label>

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
                  Log in here and that screen will be closed (its phone line disconnects). An agent can only be logged
                  in once, so calls don&apos;t ring in the wrong place.
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
                <p
                  role="alert"
                  className="mb-4 flex gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  {login.error.message}
                </p>
              )
            )}

            <Button type="submit" className="h-11 w-full text-base" disabled={login.isPending}>
              {login.isPending ? <LoaderCircle className="animate-spin" /> : null}
              Sign in
              {!login.isPending && <ArrowRight />}
            </Button>
          </form>
          <p className="mt-6 text-center text-xs text-muted-foreground">
            Trouble signing in? Ask your administrator to reset your password.
          </p>
        </div>
      </main>
    </div>
  );
}
