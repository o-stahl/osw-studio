'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DetailedSyncStatus, SyncableItem } from '@/lib/vfs/sync-types';
import { ProjectsTab } from './projects-tab';
import { SkillsTab } from './skills-tab';
import { TemplatesTab } from './templates-tab';
import { ModelTemplatesTab } from './model-templates-tab';
import { InterviewTemplatesTab } from './interview-templates-tab';
import { FolderGit2, BookOpen, Layout, Cpu, ClipboardList } from 'lucide-react';

export interface BulkActionState {
  selectableCount: number;
  selectedCount: number;
  pushableCount: number;
  pullableCount: number;
  isSyncing: boolean;
  onSelectAll: () => void;
  onPushSelected: () => void;
  onPullSelected: () => void;
}

interface SyncTabsProps {
  syncStatus: DetailedSyncStatus;
  onRefresh: () => void;
  onSyncComplete: () => void;
  onBulkActionStateChange?: (state: BulkActionState) => void;
}

type TabType = 'projects' | 'skills' | 'templates' | 'modelTemplates' | 'interviewTemplates';

export function SyncTabs({
  syncStatus,
  onRefresh,
  onSyncComplete,
  onBulkActionStateChange,
}: SyncTabsProps) {
  const tc = useTranslations('common');
  const tn = useTranslations('nav');
  const [activeTab, setActiveTab] = useState<TabType>('projects');

  // Selection state per tab
  const [projectSelectedIds, setProjectSelectedIds] = useState<Set<string>>(new Set());
  const [skillSelectedIds, setSkillSelectedIds] = useState<Set<string>>(new Set());
  const [templateSelectedIds, setTemplateSelectedIds] = useState<Set<string>>(new Set());
  const [modelTemplateSelectedIds, setModelTemplateSelectedIds] = useState<Set<string>>(new Set());
  const [interviewTemplateSelectedIds, setInterviewTemplateSelectedIds] = useState<Set<string>>(new Set());

  // Syncing state per tab
  const [projectSyncingIds, setProjectSyncingIds] = useState<Set<string>>(new Set());
  const [skillSyncingIds, setSkillSyncingIds] = useState<Set<string>>(new Set());
  const [templateSyncingIds, setTemplateSyncingIds] = useState<Set<string>>(new Set());
  const [modelTemplateSyncingIds, setModelTemplateSyncingIds] = useState<Set<string>>(new Set());
  const [interviewTemplateSyncingIds, setInterviewTemplateSyncingIds] = useState<Set<string>>(new Set());

  // Push/pull handler refs (set by child tabs) - using refs to avoid re-render loops
  const pushSelectedHandlerRef = useRef<(() => Promise<void>) | null>(null);
  const pullSelectedHandlerRef = useRef<(() => Promise<void>) | null>(null);

  const projectCount = syncStatus.projects.items.length;
  const skillCount = syncStatus.skills.items.length;
  const templateCount = syncStatus.templates.items.length;
  const modelTemplateCount = syncStatus.modelTemplates.items.length;
  const interviewTemplateCount = syncStatus.interviewTemplates.items.length;

  // Helper functions for calculating item states
  const getSelectableItems = useCallback((items: SyncableItem[]) =>
    items.filter(item => item.status !== 'synced'), []);

  const getPushableItems = useCallback((items: SyncableItem[], selectedIds: Set<string>) =>
    items.filter(item => selectedIds.has(item.id) && ['local-newer', 'local-only', 'conflict'].includes(item.status)), []);

  const getPullableItems = useCallback((items: SyncableItem[], selectedIds: Set<string>) =>
    items.filter(item => selectedIds.has(item.id) && ['server-newer', 'server-only', 'conflict'].includes(item.status)), []);

  // Get current tab's state
  const getCurrentTabData = useCallback(() => {
    switch (activeTab) {
      case 'projects':
        return {
          items: syncStatus.projects.items,
          selectedIds: projectSelectedIds,
          setSelectedIds: setProjectSelectedIds,
          syncingIds: projectSyncingIds,
        };
      case 'skills':
        return {
          items: syncStatus.skills.items,
          selectedIds: skillSelectedIds,
          setSelectedIds: setSkillSelectedIds,
          syncingIds: skillSyncingIds,
        };
      case 'templates':
        return {
          items: syncStatus.templates.items,
          selectedIds: templateSelectedIds,
          setSelectedIds: setTemplateSelectedIds,
          syncingIds: templateSyncingIds,
        };
      case 'modelTemplates':
        return {
          items: syncStatus.modelTemplates.items,
          selectedIds: modelTemplateSelectedIds,
          setSelectedIds: setModelTemplateSelectedIds,
          syncingIds: modelTemplateSyncingIds,
        };
      case 'interviewTemplates':
        return {
          items: syncStatus.interviewTemplates.items,
          selectedIds: interviewTemplateSelectedIds,
          setSelectedIds: setInterviewTemplateSelectedIds,
          syncingIds: interviewTemplateSyncingIds,
        };
    }
  }, [activeTab, syncStatus, projectSelectedIds, skillSelectedIds, templateSelectedIds, modelTemplateSelectedIds, interviewTemplateSelectedIds, projectSyncingIds, skillSyncingIds, templateSyncingIds, modelTemplateSyncingIds, interviewTemplateSyncingIds]);

  const handleSelectAll = useCallback(() => {
    const { items, selectedIds, setSelectedIds } = getCurrentTabData();
    const selectableItems = getSelectableItems(items);
    if (selectedIds.size === selectableItems.length && selectableItems.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableItems.map(item => item.id)));
    }
  }, [getCurrentTabData, getSelectableItems]);

  const handlePushSelected = useCallback(async () => {
    if (pushSelectedHandlerRef.current) {
      await pushSelectedHandlerRef.current();
    }
  }, []);

  const handlePullSelected = useCallback(async () => {
    if (pullSelectedHandlerRef.current) {
      await pullSelectedHandlerRef.current();
    }
  }, []);

  // Stable callback setters for child components
  const registerPushSelected = useCallback((handler: (() => Promise<void>) | null) => {
    pushSelectedHandlerRef.current = handler;
  }, []);

  const registerPullSelected = useCallback((handler: (() => Promise<void>) | null) => {
    pullSelectedHandlerRef.current = handler;
  }, []);

  // Update bulk action state when relevant state changes
  useEffect(() => {
    if (!onBulkActionStateChange) return;

    const { items, selectedIds, syncingIds } = getCurrentTabData();
    const selectableItems = getSelectableItems(items);
    const pushableItems = getPushableItems(items, selectedIds);
    const pullableItems = getPullableItems(items, selectedIds);

    onBulkActionStateChange({
      selectableCount: selectableItems.length,
      selectedCount: selectedIds.size,
      pushableCount: pushableItems.length,
      pullableCount: pullableItems.length,
      isSyncing: syncingIds.size > 0,
      onSelectAll: handleSelectAll,
      onPushSelected: handlePushSelected,
      onPullSelected: handlePullSelected,
    });
  }, [getCurrentTabData, getSelectableItems, getPushableItems, getPullableItems, handleSelectAll, handlePushSelected, handlePullSelected, onBulkActionStateChange]);

  return (
    <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabType)}>
      <TabsList className="grid w-full grid-cols-5">
        <TabsTrigger value="projects" className="flex items-center gap-1.5">
          <FolderGit2 className="h-3.5 w-3.5" />
          <span>{tc('terms.projects')}</span>
          <span className="text-xs text-muted-foreground">({projectCount})</span>
        </TabsTrigger>
        <TabsTrigger value="skills" className="flex items-center gap-1.5">
          <BookOpen className="h-3.5 w-3.5" />
          <span>{tc('terms.skills')}</span>
          <span className="text-xs text-muted-foreground">({skillCount})</span>
        </TabsTrigger>
        <TabsTrigger value="templates" className="flex items-center gap-1.5">
          <Layout className="h-3.5 w-3.5" />
          <span>{tc('terms.templates')}</span>
          <span className="text-xs text-muted-foreground">({templateCount})</span>
        </TabsTrigger>
        <TabsTrigger value="modelTemplates" className="flex items-center gap-1.5">
          <Cpu className="h-3.5 w-3.5" />
          <span>{tc('terms.models')}</span>
          <span className="text-xs text-muted-foreground">({modelTemplateCount})</span>
        </TabsTrigger>
        <TabsTrigger value="interviewTemplates" className="flex items-center gap-1.5">
          <ClipboardList className="h-3.5 w-3.5" />
          <span>{tn('items.interviews')}</span>
          <span className="text-xs text-muted-foreground">({interviewTemplateCount})</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="projects" className="mt-4">
        <ProjectsTab
          items={syncStatus.projects.items}
          selectedIds={projectSelectedIds}
          syncingIds={projectSyncingIds}
          onSelectedIdsChange={setProjectSelectedIds}
          onSyncingIdsChange={setProjectSyncingIds}
          onRefresh={onRefresh}
          onSyncComplete={onSyncComplete}
          onRegisterPushSelected={registerPushSelected}
          onRegisterPullSelected={registerPullSelected}
        />
      </TabsContent>

      <TabsContent value="skills" className="mt-4">
        <SkillsTab
          items={syncStatus.skills.items}
          selectedIds={skillSelectedIds}
          syncingIds={skillSyncingIds}
          onSelectedIdsChange={setSkillSelectedIds}
          onSyncingIdsChange={setSkillSyncingIds}
          onRefresh={onRefresh}
          onSyncComplete={onSyncComplete}
          onRegisterPushSelected={registerPushSelected}
          onRegisterPullSelected={registerPullSelected}
        />
      </TabsContent>

      <TabsContent value="templates" className="mt-4">
        <TemplatesTab
          items={syncStatus.templates.items}
          selectedIds={templateSelectedIds}
          syncingIds={templateSyncingIds}
          onSelectedIdsChange={setTemplateSelectedIds}
          onSyncingIdsChange={setTemplateSyncingIds}
          onRefresh={onRefresh}
          onSyncComplete={onSyncComplete}
          onRegisterPushSelected={registerPushSelected}
          onRegisterPullSelected={registerPullSelected}
        />
      </TabsContent>

      <TabsContent value="modelTemplates" className="mt-4">
        <ModelTemplatesTab
          items={syncStatus.modelTemplates.items}
          selectedIds={modelTemplateSelectedIds}
          syncingIds={modelTemplateSyncingIds}
          onSelectedIdsChange={setModelTemplateSelectedIds}
          onSyncingIdsChange={setModelTemplateSyncingIds}
          onRefresh={onRefresh}
          onSyncComplete={onSyncComplete}
          onRegisterPushSelected={registerPushSelected}
          onRegisterPullSelected={registerPullSelected}
        />
      </TabsContent>

      <TabsContent value="interviewTemplates" className="mt-4">
        <InterviewTemplatesTab
          items={syncStatus.interviewTemplates.items}
          selectedIds={interviewTemplateSelectedIds}
          syncingIds={interviewTemplateSyncingIds}
          onSelectedIdsChange={setInterviewTemplateSelectedIds}
          onSyncingIdsChange={setInterviewTemplateSyncingIds}
          onRefresh={onRefresh}
          onSyncComplete={onSyncComplete}
          onRegisterPushSelected={registerPushSelected}
          onRegisterPullSelected={registerPullSelected}
        />
      </TabsContent>
    </Tabs>
  );
}
