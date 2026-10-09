import { LoaderCircle } from 'lucide-react';

export function FullPageSpinner() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground" role="status" aria-label="Loading">
      <LoaderCircle className="size-6 animate-spin" />
    </div>
  );
}
