// The VIZTEX logo: a mark (a "V" with a signal dot, teal gradient) and the
// name. `tone="light"` on dark backgrounds (sidebar, agent bar, login art).
import { useId } from 'react';
import { APP_NAME } from '@/lib/brand';
import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-8 shrink-0', className)}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#0f766e" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id})`} />
      <path
        d="M8 9.5l8 13 8-13"
        fill="none"
        stroke="#fff"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="9" r="2" fill="#fff" />
    </svg>
  );
}

export function Logo({
  tone = 'dark',
  className,
  markClassName,
  nameClassName,
  showName = true,
}: {
  tone?: 'dark' | 'light';
  className?: string;
  markClassName?: string;
  /** e.g. "hidden sm:inline" to show only the mark on phones. */
  nameClassName?: string;
  showName?: boolean;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 font-extrabold', className)}>
      <LogoMark className={markClassName} />
      {showName && (
        <span className={cn('tracking-wider', tone === 'light' ? 'text-white' : 'text-foreground', nameClassName)}>
          {APP_NAME.slice(0, 3)}
          <span className={tone === 'light' ? 'text-teal-300' : 'text-primary'}>{APP_NAME.slice(3)}</span>
        </span>
      )}
    </span>
  );
}
