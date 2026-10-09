import type { ComponentProps } from 'react';
import { Dialog as D } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

/** Centered modal; scrolls inside when content is taller than the screen. */
export function DialogContent({
  className,
  children,
  size = 'md',
  ...props
}: ComponentProps<typeof D.Content> & { size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <D.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-card shadow-xl focus:outline-none',
          width,
          className,
        )}
        {...props}
      >
        {children}
        <D.Close className="absolute top-4 right-4 cursor-pointer rounded-sm text-muted-foreground opacity-70 hover:opacity-100 focus:ring-2 focus:ring-ring focus:outline-none">
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}
export function DialogHeader({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 p-5 pr-12 pb-3', className)} {...props} />;
}
export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 pb-2', className)} {...props} />;
}
export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-wrap justify-end gap-2 border-t p-4', className)} {...props} />;
}
export function DialogTitle({ className, ...props }: ComponentProps<typeof D.Title>) {
  return <D.Title className={cn('text-lg font-bold', className)} {...props} />;
}
export function DialogDescription({ className, ...props }: ComponentProps<typeof D.Description>) {
  return <D.Description className={cn('text-sm text-muted-foreground', className)} {...props} />;
}
