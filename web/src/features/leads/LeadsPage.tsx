// Leads & Lists: lists (with recycle), all leads, and file import - one tab each.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SectionHeader } from '@/components/common';
import { leadKeys } from './api';
import { ListsTab } from './ListsTab';
import { LeadsTab } from './LeadsTab';
import { ImportTab } from './ImportTab';

export function LeadsPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState('lists');
  // Lifted so "Import" on a list row opens the Import tab with that list picked.
  const [importListId, setImportListId] = useState<number | null>(null);

  return (
    <Card>
      <CardContent className="pt-5">
        <SectionHeader
          title="Leads & Lists"
          description="Import, browse, and track leads across every campaign."
          actions={
            <Button
              variant="outline"
              onClick={() => {
                qc.invalidateQueries({ queryKey: leadKeys.lists });
                qc.invalidateQueries({ queryKey: leadKeys.leads });
              }}
            >
              <RefreshCw /> Refresh
            </Button>
          }
        />
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="lists">Lists</TabsTrigger>
            <TabsTrigger value="leads">Leads</TabsTrigger>
            <TabsTrigger value="import">Import</TabsTrigger>
          </TabsList>
          <TabsContent value="lists">
            <ListsTab
              onImport={(id) => {
                setImportListId(id);
                setTab('import');
              }}
            />
          </TabsContent>
          <TabsContent value="leads">
            <LeadsTab />
          </TabsContent>
          <TabsContent value="import">
            <ImportTab listId={importListId} onListChange={setImportListId} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
