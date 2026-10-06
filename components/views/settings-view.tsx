'use client';

import { useTranslations } from 'next-intl';
import React, { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { UnifiedSettings, SETTINGS_PANE_IDS, type SettingsPane } from '@/components/unified-settings';

// Derived from the pane definitions, so a new pane is deep-linkable the moment it is declared.
const VALID_PANES = new Set<SettingsPane>(SETTINGS_PANE_IDS);

// Backward compat: map old param values to new pane IDs
const LEGACY_MAP: Record<string, SettingsPane> = {
  application: 'appearance',
  model: 'models',
  'connected-agents': 'mcp',
};

interface SettingsViewProps {
  tab?: string;
  workspaceId?: string;
}

function SettingsViewInner({ tab, workspaceId }: SettingsViewProps) {
  const searchParams = useSearchParams();
  const raw = searchParams.get('settings') || tab || 'connections';
  const pane: SettingsPane =
    VALID_PANES.has(raw as SettingsPane) ? raw as SettingsPane
    : LEGACY_MAP[raw] ?? 'connections';

  return (
    <div className="h-full flex flex-col">
      <UnifiedSettings activePane={pane} workspaceId={workspaceId} />
    </div>
  );
}

export function SettingsView({ tab, workspaceId }: SettingsViewProps) {
  const tc = useTranslations('common');
  return (
    <Suspense fallback={<div className="h-full flex items-center justify-center"><p className="text-muted-foreground">{tc('loading')}</p></div>}>
      <SettingsViewInner tab={tab} workspaceId={workspaceId} />
    </Suspense>
  );
}
