import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { NavItem } from '@/app/nav';

/** Stand-in for a screen that hasn't moved to the new app yet. */
export function ClassicScreenPage({ item }: { item: NavItem }) {
  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle>{item.label} is moving here soon</CardTitle>
        <CardDescription>
          This screen is being rebuilt in the new app. Until then it works as before in the classic admin.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild>
          <a href={`/admin.html#${item.classic}`}>
            <ExternalLink /> Open {item.label} (classic)
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}
