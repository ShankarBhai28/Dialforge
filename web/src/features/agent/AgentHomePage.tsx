import { ExternalLink, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useLogout, useMe } from '@/features/auth/auth';

/** Agents keep the classic agent screen until its rebuild passes real-call testing. */
export function AgentHomePage() {
  const { data: user } = useMe();
  const logout = useLogout();
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Hi {user?.username}</CardTitle>
          <CardDescription>
            The new agent screen is still being built. Your calls, leads and softphone are on the agent screen you
            already use.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild>
            <a href="/agent.html">
              <ExternalLink /> Open agent screen
            </a>
          </Button>
          <Button variant="outline" onClick={() => logout.mutate()}>
            <LogOut /> Log out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
