import type { ComponentProps } from 'react';
import { Tabs as T } from 'radix-ui';
import { cn } from '@/lib/utils';

export const Tabs = T.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof T.List>) {
  return (
    <T.List
      className={cn(
        'inline-flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
export function TabsTrigger({ className, ...props }: ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold whitespace-nowrap transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        className,
      )}
      {...props}
    />
  );
}
export function TabsContent({ className, ...props }: ComponentProps<typeof T.Content>) {
  return <T.Content className={cn('mt-4 focus-visible:outline-none', className)} {...props} />;
}
