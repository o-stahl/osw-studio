'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tip } from '@/components/ui/tooltip';
import { SchemaViewer } from './schema-viewer';
import { SqlEditor } from './sql-editor';
import { FunctionsManager } from './functions-manager';
import { ServerFunctionsManager } from './server-functions-manager';
import { SecretsManager } from './secrets-manager';
import { ScheduledFunctionsManager } from './scheduled-functions-manager';
import { LogsViewer } from './logs-viewer';
import { Database, Code2, Terminal, ScrollText, Wrench, Key, Clock } from 'lucide-react';

interface DatabaseManagerProps {
  deploymentId: string;
  workspaceId?: string;
}

export function DatabaseManager({ deploymentId, workspaceId }: DatabaseManagerProps) {
  const t = useTranslations('deploymentDetail.nav');
  const tips = useTranslations('deploymentDetail.navTips');
  const [activeTab, setActiveTab] = useState('schema');

  return (
    <div className="h-full flex flex-col">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        <TabsList className="grid w-full grid-cols-7">
          <Tip label={tips('schema')} side="bottom" wrap wrapClassName="grid">
            <TabsTrigger value="schema" className="flex items-center gap-1.5">
              <Database className="h-3.5 w-3.5" />
              {t('schema')}
            </TabsTrigger>
          </Tip>
          <Tip label={tips('sql')} side="bottom" wrap wrapClassName="grid">
            <TabsTrigger value="query" className="flex items-center gap-1.5">
              <Terminal className="h-3.5 w-3.5" />
              {t('sql')}
            </TabsTrigger>
          </Tip>
          <Tip label={tips('functions')} side="bottom" wrap wrapClassName="grid">
            <TabsTrigger value="functions" className="flex items-center gap-1.5">
              <Code2 className="h-3.5 w-3.5" />
              {t('functions')}
            </TabsTrigger>
          </Tip>
          <Tip label={tips('helpers')} side="bottom" wrap wrapClassName="grid">
            <TabsTrigger value="helpers" className="flex items-center gap-1.5">
              <Wrench className="h-3.5 w-3.5" />
              {t('helpers')}
            </TabsTrigger>
          </Tip>
          <Tip label={tips('secrets')} side="bottom" wrap wrapClassName="grid">
            <TabsTrigger value="secrets" className="flex items-center gap-1.5">
              <Key className="h-3.5 w-3.5" />
              {t('secrets')}
            </TabsTrigger>
          </Tip>
          <Tip label={tips('schedules')} side="bottom" wrap wrapClassName="grid">
            <TabsTrigger value="schedules" className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              {t('schedules')}
            </TabsTrigger>
          </Tip>
          <Tip label={tips('logs')} side="bottom" wrap wrapClassName="grid">
            <TabsTrigger value="logs" className="flex items-center gap-1.5">
              <ScrollText className="h-3.5 w-3.5" />
              {t('logs')}
            </TabsTrigger>
          </Tip>
        </TabsList>

        <div className="flex-1 overflow-hidden mt-4">
          <TabsContent value="schema" className="h-full m-0">
            <SchemaViewer deploymentId={deploymentId} workspaceId={workspaceId} />
          </TabsContent>

          <TabsContent value="query" className="h-full m-0">
            <SqlEditor deploymentId={deploymentId} workspaceId={workspaceId} />
          </TabsContent>

          <TabsContent value="functions" className="h-full m-0">
            <FunctionsManager deploymentId={deploymentId} workspaceId={workspaceId} />
          </TabsContent>

          <TabsContent value="helpers" className="h-full m-0">
            <ServerFunctionsManager deploymentId={deploymentId} workspaceId={workspaceId} />
          </TabsContent>

          <TabsContent value="secrets" className="h-full m-0">
            <SecretsManager deploymentId={deploymentId} workspaceId={workspaceId} />
          </TabsContent>

          <TabsContent value="schedules" className="h-full m-0">
            <ScheduledFunctionsManager deploymentId={deploymentId} workspaceId={workspaceId} />
          </TabsContent>

          <TabsContent value="logs" className="h-full m-0">
            <LogsViewer deploymentId={deploymentId} workspaceId={workspaceId} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

export { SchemaViewer } from './schema-viewer';
export { SqlEditor } from './sql-editor';
export { FunctionsManager } from './functions-manager';
export { ServerFunctionsManager } from './server-functions-manager';
export { SecretsManager } from './secrets-manager';
export { ScheduledFunctionsManager } from './scheduled-functions-manager';
export { LogsViewer } from './logs-viewer';
