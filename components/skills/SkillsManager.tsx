'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useSkillGroupCopy } from '@/lib/i18n/use-skill-group-catalog';
import { Skill, SkillGroup } from '@/lib/vfs/skills/types';
import { skillsService } from '@/lib/vfs/skills';
import { vfs } from '@/lib/vfs';
import { track } from '@/lib/telemetry';
import { logger } from '@/lib/utils';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Section } from '@/components/ui/section';
import { InfoTip } from '@/components/ui/info-tip';
import {
  Plus,
  Search,
  Download,
  Upload,
  Trash2,
  Edit,
  FileText,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Power,
  FolderTree,
  MoreVertical,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { SkillEditor } from './SkillEditor';
import { usePagination } from '@/lib/hooks/use-pagination';
import { Pagination, PaginationRange } from '@/components/ui/pagination';
import { ViewModeToggle, useViewMode } from '@/components/ui/view-mode-toggle';
import { COMPACT_ROW_WIDTH } from '@/lib/constants/layout';
import { useNarrowContainer } from '@/lib/hooks/use-narrow-container';

/** The skills the list shows for a search and the built-in/custom filters, custom first. */
export function filterSkills(skills: Skill[], searchQuery: string, showBuiltIn: boolean, showCustom: boolean): Skill[] {
  return skills.filter(skill => {
    const q = searchQuery.toLowerCase();
    const matchesSearch =
      skill.name.toLowerCase().includes(q) ||
      skill.description.toLowerCase().includes(q);
    if (!matchesSearch) return false;
    if (skill.isBuiltIn && !showBuiltIn) return false;
    if (!skill.isBuiltIn && !showCustom) return false;
    return true;
  }).sort((a, b) => Number(!!a.isBuiltIn) - Number(!!b.isBuiltIn)); // custom first, then built-in
}

/** The groups the list shows for a search, matched against the name and description as shown. */
export function filterGroups(
  groups: SkillGroup[],
  searchQuery: string,
  groupCopy: (group: SkillGroup) => { name: string; description: string },
): SkillGroup[] {
  return groups.filter(g => {
    const q = searchQuery.toLowerCase();
    const { name, description } = groupCopy(g);
    return !q || name.toLowerCase().includes(q) || description.toLowerCase().includes(q);
  });
}

export function SkillsManager() {
  const when = useLocalFormat();
  const t = useTranslations('skills');
  const tc = useTranslations('common');
  const groupCopy = useSkillGroupCopy();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [groups, setGroups] = useState<SkillGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [skillToDelete, setSkillToDelete] = useState<Skill | null>(null);
  const [groupToDelete, setGroupToDelete] = useState<SkillGroup | null>(null);
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [evaluationEnabled, setEvaluationEnabled] = useState(false);
  const [enabledSkills, setEnabledSkills] = useState<Set<string>>(new Set());
  const [enabledGroups, setEnabledGroups] = useState<Set<string>>(new Set());
  const [showBuiltIn, setShowBuiltIn] = useState(true);
  const [showCustom, setShowCustom] = useState(true);
  const [viewMode, setViewMode] = useViewMode('skills');
  const [activeTab, setActiveTab] = useState<'skills' | 'groups'>('skills');
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [groupDialogMode, setGroupDialogMode] = useState<'create' | 'edit'>('create');
  const [groupBeingEdited, setGroupBeingEdited] = useState<SkillGroup | null>(null);

  useEffect(() => {
    loadAll();
  }, []);

  const loadAll = async () => {
    try {
      setLoading(true);
      const [allSkills, allGroups] = await Promise.all([
        skillsService.getAllSkills(),
        skillsService.getAllGroups(),
      ]);
      setSkills(allSkills);
      setGroups(allGroups);
      await loadEnabledState(allSkills, allGroups);
    } catch (error) {
      logger.error('[SkillsManager] Failed to load skills/groups', error);
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const loadEnabledState = async (allSkills: Skill[], allGroups: SkillGroup[]) => {
    try {
      const isGlobalEnabled = await skillsService.isGloballyEnabled();
      setGlobalEnabled(isGlobalEnabled);
      const isEvalEnabled = await skillsService.isEvaluationEnabled();
      setEvaluationEnabled(isEvalEnabled);

      const enabled = new Set<string>();
      for (const skill of allSkills) {
        if (await skillsService.isSkillEnabled(skill.id)) enabled.add(skill.id);
      }
      setEnabledSkills(enabled);

      const enabledG = new Set<string>();
      for (const g of allGroups) {
        if (await skillsService.isGroupEnabled(g.id)) enabledG.add(g.id);
      }
      setEnabledGroups(enabledG);
    } catch (error) {
      logger.error('[SkillsManager] Failed to load enabled state', error);
    }
  };

  const handleGlobalToggle = async (enabled: boolean) => {
    try {
      await skillsService.setGlobalEnabled(enabled);
      setGlobalEnabled(enabled);
      await vfs.reloadTransientSkills();
      toast.success(enabled ? t('skillsEnabled') : t('skillsDisabled'));
    } catch {
      toast.error(t('updateStateFailed'));
    }
  };

  const handleEvaluationToggle = async (enabled: boolean) => {
    try {
      await skillsService.setEvaluationEnabled(enabled);
      setEvaluationEnabled(enabled);
      toast.success(enabled ? t('evalEnabled') : t('evalDisabled'));
    } catch {
      toast.error(t('updateEvalFailed'));
    }
  };

  const handleBulkSkillToggle = async (skillIds: string[], enabled: boolean) => {
    if (skillIds.length === 0) {
      toast.error(t('noneToUpdate'));
      return;
    }
    try {
      for (const id of skillIds) {
        if (enabled) await skillsService.enableSkill(id);
        else await skillsService.disableSkill(id);
      }
      setEnabledSkills(prev => {
        const next = new Set(prev);
        for (const id of skillIds) {
          if (enabled) next.add(id);
          else next.delete(id);
        }
        return next;
      });
      await vfs.reloadTransientSkills();
      toast.success(t(enabled ? 'enabledSkills' : 'disabledSkills', { count: skillIds.length }));
    } catch {
      toast.error(t('updateFailed'));
    }
  };

  const handleSkillToggle = async (skillId: string, enabled: boolean) => {
    try {
      if (enabled) {
        await skillsService.enableSkill(skillId);
        setEnabledSkills(prev => new Set([...prev, skillId]));
      } else {
        await skillsService.disableSkill(skillId);
        setEnabledSkills(prev => {
          const newSet = new Set(prev);
          newSet.delete(skillId);
          return newSet;
        });
      }
      await vfs.reloadTransientSkills();
    } catch {
      toast.error(t('toggleFailed'));
    }
  };

  const handleGroupToggle = async (groupId: string, enabled: boolean) => {
    try {
      if (enabled) {
        await skillsService.enableGroup(groupId);
        setEnabledGroups(prev => new Set([...prev, groupId]));
      } else {
        await skillsService.disableGroup(groupId);
        setEnabledGroups(prev => {
          const next = new Set(prev);
          next.delete(groupId);
          return next;
        });
      }
      await vfs.reloadTransientSkills();
    } catch {
      toast.error(t('toggleGroupFailed'));
    }
  };

  const handleCreateNew = () => {
    setSelectedSkill(null);
    setEditorMode('create');
  };

  const handleEdit = (skill: Skill) => {
    setSelectedSkill(skill);
    setEditorMode('edit');
  };

  const handleDelete = (skill: Skill) => {
    setSkillToDelete(skill);
    setDeleteConfirmOpen(true);
  };

  const confirmDelete = async () => {
    if (skillToDelete) {
      try {
        await skillsService.deleteSkill(skillToDelete.id);
        track('skill_deleted');
        toast.success(t('deletedSkill', { name: skillToDelete.name }));
        await loadAll();
        await vfs.reloadTransientSkills();
      } catch (error) {
        const message = error instanceof Error ? error.message : t('deleteSkillFailed');
        toast.error(message);
      } finally {
        setDeleteConfirmOpen(false);
        setSkillToDelete(null);
      }
    } else if (groupToDelete) {
      try {
        await skillsService.deleteGroup(groupToDelete.id);
        toast.success(t('deletedGroup', { name: groupToDelete.name }));
        await loadAll();
        await vfs.reloadTransientSkills();
      } catch (error) {
        const message = error instanceof Error ? error.message : t('deleteGroupFailed');
        toast.error(message);
      } finally {
        setDeleteConfirmOpen(false);
        setGroupToDelete(null);
      }
    }
  };

  const handleImport = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.zip';
    input.multiple = false;

    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      try {
        if (file.name.endsWith('.zip')) {
          const imported = await skillsService.importSkills(file);
          toast.success(t('importedSkills', { count: imported.length }));
        } else {
          const skill = await skillsService.importSkillFile(file);
          toast.success(t('importedSkill', { name: skill.name }));
        }
        await loadAll();
        await vfs.reloadTransientSkills();
      } catch (error) {
        const message = error instanceof Error ? error.message : t('importSkillFailed');
        toast.error(message);
      }
    };

    input.click();
  };

  const handleExportAll = async () => {
    try {
      const customSkills = skills.filter(s => !s.isBuiltIn);
      if (customSkills.length === 0) {
        toast.error(t('noCustomToExport'));
        return;
      }

      const blob = await skillsService.exportSkills(customSkills.map(s => s.id));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `osw-skills-${new Date().toISOString().split('T')[0]}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t('exportedSkills', { count: customSkills.length }));
    } catch {
      toast.error(t('exportFailed'));
    }
  };

  const handleEditorSave = async () => {
    setEditorMode(null);
    setSelectedSkill(null);
    await loadAll();
    await vfs.reloadTransientSkills();
  };

  const handleEditorCancel = () => {
    setEditorMode(null);
    setSelectedSkill(null);
  };

  const handleOpenCreateGroup = () => {
    setGroupDialogMode('create');
    setGroupBeingEdited(null);
    setGroupDialogOpen(true);
  };

  const handleEditGroup = (group: SkillGroup) => {
    setGroupDialogMode('edit');
    setGroupBeingEdited(group);
    setGroupDialogOpen(true);
  };

  const handleDeleteGroup = (group: SkillGroup) => {
    setGroupToDelete(group);
    setDeleteConfirmOpen(true);
  };

  const handleGroupDialogSave = async () => {
    setGroupDialogOpen(false);
    setGroupBeingEdited(null);
    await loadAll();
    await vfs.reloadTransientSkills();
  };

  // Map each skill to the groups it belongs to (for the "via group" badges)
  const skillToGroups = React.useMemo(() => {
    const map = new Map<string, SkillGroup[]>();
    for (const group of groups) {
      for (const memberId of group.memberIds) {
        const arr = map.get(memberId) ?? [];
        arr.push(group);
        map.set(memberId, arr);
      }
    }
    return map;
  }, [groups]);

  const filteredSkills = filterSkills(skills, searchQuery, showBuiltIn, showCustom);
  const filteredGroups = filterGroups(groups, searchQuery, groupCopy);

  const skillsPagination = usePagination(filteredSkills, {
    perPage: 30,
    resetOn: [searchQuery, showBuiltIn, showCustom],
  });
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  const [compactRows, measureRowsRef] = useNarrowContainer(COMPACT_ROW_WIDTH);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <Spinner size={48} className="mx-auto text-primary" />
          <p className="mt-4">{t('loading')}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="h-full flex flex-col">
        {/* Toolbar */}
        <div className="pt-4 px-4 pb-3 sm:pt-6 sm:px-6 sm:pb-3 shrink-0">
          <div className="mx-auto max-w-7xl flex flex-col gap-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <h1 className="text-lg font-semibold shrink-0">{tc('terms.skills')}</h1>
              <div className="flex items-center shrink-0">
                <Button onClick={handleCreateNew} size="sm">
                  <Plus className="w-4 h-4 mr-2" />
                  {tc('actions.new')}
                </Button>
              </div>

              {/* Search */}
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={t('searchPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2">
                <ViewModeToggle value={viewMode} onChange={setViewMode} />
                <Button variant="outline" size="sm" onClick={handleOpenCreateGroup}>
                  <FolderTree className="w-4 h-4 mr-2" />
                  {t('newGroup')}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="px-2" title={t('more')}>
                      <MoreVertical className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={handleImport}>
                      <Upload className="w-4 h-4 mr-2" />
                      {tc('actions.import')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleExportAll}>
                      <Download className="w-4 h-4 mr-2" />
                      {tc('actions.export')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {/* Skills system master toggle + skill evaluation (slim strip) */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
              <Power className="w-4 h-4 text-muted-foreground shrink-0" />
              <Label htmlFor="global-toggle" className="text-[13px] font-medium cursor-pointer">
                {t('skillsSystem')}
              </Label>
              <InfoTip>
                {t('systemInfo')}
              </InfoTip>
              <Switch
                id="global-toggle"
                checked={globalEnabled}
                onCheckedChange={handleGlobalToggle}
              />

              <span className="mx-1 h-5 w-px bg-border hidden sm:block" />

              <Sparkles className="w-4 h-4 text-muted-foreground shrink-0" />
              <Label htmlFor="eval-toggle" className="text-[13px] font-medium cursor-pointer">
                {t('skillEvaluation')}
              </Label>
              <InfoTip>
                {t('evalInfo')}
              </InfoTip>
              <Switch
                id="eval-toggle"
                checked={evaluationEnabled}
                disabled={!globalEnabled}
                onCheckedChange={handleEvaluationToggle}
              />
            </div>

          </div>
        </div>

        {/* Tabs */}
        <div ref={listScrollRef} className="flex-1 min-h-0 flex flex-col px-4 pb-4 sm:px-6 sm:pb-6">
          <div className="mx-auto w-full max-w-7xl flex-1 min-h-0 flex flex-col">
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'skills' | 'groups')} className="w-full flex-1 min-h-0 flex flex-col">
              <Section className="flex-1 min-h-0 flex flex-col">
                {/* Header: Skills/Groups switch + (skills-only) source filter & bulk actions */}
                <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-muted/40 border-b border-border shrink-0">
                  <TabsList className="h-8 bg-muted/60">
                    <TabsTrigger value="skills" className="gap-1.5 h-6 data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none">
                      <Sparkles className="w-3.5 h-3.5" />
                      {tc('terms.skills')}
                      <Badge variant="outline" className="text-xs ml-1">{filteredSkills.length}</Badge>
                    </TabsTrigger>
                    <TabsTrigger value="groups" className="gap-1.5 h-6 data-[state=active]:bg-primary/15 data-[state=active]:text-primary data-[state=active]:shadow-none">
                      <FolderTree className="w-3.5 h-3.5" />
                      {t('groups')}
                      <Badge variant="outline" className="text-xs ml-1">{filteredGroups.length}</Badge>
                    </TabsTrigger>
                  </TabsList>

                  {activeTab === 'skills' && (
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">{tc('labels.show')}</span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 gap-1.5"
                        style={showBuiltIn ? { backgroundColor: 'color-mix(in oklab, var(--primary) 5%, transparent)', borderColor: 'color-mix(in oklab, var(--primary) 30%, transparent)' } : undefined}
                        onClick={() => setShowBuiltIn(v => !v)}
                        aria-pressed={showBuiltIn}
                        title={t('showBuiltIn')}
                      >
                        <FileText className="w-3 h-3" />
                        {tc('labels.builtIn')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 gap-1.5"
                        style={showCustom ? { backgroundColor: 'color-mix(in oklab, var(--primary) 5%, transparent)', borderColor: 'color-mix(in oklab, var(--primary) 30%, transparent)' } : undefined}
                        onClick={() => setShowCustom(v => !v)}
                        aria-pressed={showCustom}
                        title={t('showCustom')}
                      >
                        <Sparkles className="w-3 h-3" />
                        {t('custom')}
                      </Button>
                      <span className="w-px h-5 bg-border mx-0.5" />
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2"
                        onClick={() => handleBulkSkillToggle(filteredSkills.map(s => s.id), true)}
                        disabled={!globalEnabled || filteredSkills.length === 0}
                        title={t('enableAllShown')}
                      >
                        {t('enableAll')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2"
                        onClick={() => handleBulkSkillToggle(filteredSkills.map(s => s.id), false)}
                        disabled={!globalEnabled || filteredSkills.length === 0}
                        title={t('disableAllShown')}
                      >
                        {t('disableAll')}
                      </Button>
                    </div>
                  )}
                </div>

                <TabsContent value="skills" className="mt-0 flex-1 min-h-0 flex flex-col">
                  {filteredSkills.length === 0 ? (
                  <div className="text-center py-12">
                    <Sparkles className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                    <h3 className="text-lg font-semibold mb-2">{t('noSkillsFound')}</h3>
                    <p className="text-muted-foreground mb-4">
                      {!showBuiltIn && !showCustom
                        ? t('bothHidden')
                        : searchQuery
                          ? t('tryDifferentSearch')
                          : t('createFirstSkill')}
                    </p>
                    {!searchQuery && showBuiltIn && showCustom && (
                      <Button onClick={handleCreateNew}>
                        <Plus className="w-4 h-4 mr-2" />
                        {t('createSkill')}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="flex-1 min-h-0 flex flex-col">
                    {skillsPagination.totalPages > 1 && (
                      <div className="flex items-center justify-between gap-3 px-3 pt-3 pb-2 shrink-0 border-b border-border">
                        <PaginationRange
                          total={skillsPagination.total}
                          rangeStart={skillsPagination.rangeStart}
                          rangeEnd={skillsPagination.rangeEnd}
                          totalPages={skillsPagination.totalPages}
                        />
                        <Pagination
                          page={skillsPagination.page}
                          totalPages={skillsPagination.totalPages}
                          onPageChange={skillsPagination.setPage}
                          scrollTarget={contentScrollRef}
                          className="pt-0 pb-0"
                        />
                      </div>
                    )}
                    {viewMode === 'table' ? (
                      <div ref={(el) => { contentScrollRef.current = el; measureRowsRef(el); }} className="@container flex-1 min-h-0 overflow-auto">
                        <table className="w-full table-auto border-collapse">
                          <thead className="sticky top-0 z-10">
                            <tr>
                              <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none w-full">{tc('labels.name')}</th>
                              <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{tc('labels.type')}</th>
                              <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{t('group')}</th>
                              <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none">{tc('labels.updated')}</th>
                              <th className="bg-muted text-[11px] font-medium text-muted-foreground text-left p-[6px_10px] border-b whitespace-nowrap select-none"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {skillsPagination.pageItems.map(skill => {
                              const memberOf = skillToGroups.get(skill.id) ?? [];
                              return (
                                <tr key={skill.id} className="border-b border-border/50 hover:bg-muted/50 cursor-pointer h-[44px]" onClick={() => handleEdit(skill)}>
                                  <td className="w-full p-[4px_10px] text-[13px] align-middle overflow-hidden" style={{ maxWidth: 0 }}>
                                    <div className="min-w-0">
                                      <span className="block font-medium text-foreground text-[13px] truncate">{skill.name}</span>
                                      <span className="block text-[11px] text-muted-foreground truncate">{skill.description}</span>
                                    </div>
                                  </td>
                                  <td className="p-[4px_10px] align-middle whitespace-nowrap">
                                    <Badge variant={skill.isBuiltIn ? 'secondary' : 'outline'} className="text-[11px] px-[7px] py-[1px] h-auto rounded-full">
                                      {skill.isBuiltIn ? tc('labels.builtIn') : tc('labels.custom')}
                                    </Badge>
                                  </td>
                                  <td className="p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap">
                                    {memberOf.length > 0 ? groupCopy(memberOf[0]).name : '—'}
                                  </td>
                                  <td className="p-[4px_10px] text-[13px] text-muted-foreground align-middle whitespace-nowrap overflow-hidden text-ellipsis">
                                    {when.age(skill.updatedAt)}
                                  </td>
                                  <td className="p-[4px_10px] align-middle whitespace-nowrap text-right" onClick={e => e.stopPropagation()}>
                                    <div className="flex items-center justify-end gap-1">
                                      <Button variant="outline" size="xs" className="@max-3xl:hidden" onClick={() => handleEdit(skill)}>
                                        <Edit className="w-3 h-3" />{tc('actions.edit')}
                                      </Button>
                                      <Button
                                        variant={enabledSkills.has(skill.id) ? 'outline' : 'ghost'}
                                        size="xs"
                                        className="@max-3xl:hidden"
                                        onClick={() => handleSkillToggle(skill.id, !enabledSkills.has(skill.id))}
                                        disabled={!globalEnabled}
                                      >
                                        {enabledSkills.has(skill.id) ? t('on') : t('off')}
                                      </Button>
                                      {!skill.isBuiltIn && (
                                        <Button variant="ghost" size="xs" className="@max-3xl:hidden" onClick={() => handleDelete(skill)}>
                                          <Trash2 className="w-3 h-3" />
                                        </Button>
                                      )}
                                      {/* This row had no overflow menu, so one appears with the
                                          actions in it once they hide. */}
                                      {compactRows && (
                                        <DropdownMenu>
                                          <DropdownMenuTrigger asChild>
                                            <Button variant="ghost" size="xs" className="px-1"><MoreVertical className="w-3.5 h-3.5" /></Button>
                                          </DropdownMenuTrigger>
                                          <DropdownMenuContent align="end">
                                            <DropdownMenuItem onClick={() => handleEdit(skill)}>
                                              <Edit className="w-4 h-4 mr-2" />{tc('actions.edit')}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                              onClick={() => handleSkillToggle(skill.id, !enabledSkills.has(skill.id))}
                                              disabled={!globalEnabled}
                                            >
                                              <Sparkles className="w-4 h-4 mr-2" />
                                              {enabledSkills.has(skill.id) ? t('disable') : t('enable')}
                                            </DropdownMenuItem>
                                            {!skill.isBuiltIn && (
                                              <DropdownMenuItem onClick={() => handleDelete(skill)} className="text-destructive focus:text-destructive">
                                                <Trash2 className="w-4 h-4 mr-2" />{tc('actions.delete')}
                                              </DropdownMenuItem>
                                            )}
                                          </DropdownMenuContent>
                                        </DropdownMenu>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div ref={contentScrollRef} className="flex-1 min-h-0 overflow-auto p-3">
                        <div className="grid gap-3">
                        {skillsPagination.pageItems.map(skill => (
                          <SkillCard
                            key={skill.id}
                            skill={skill}
                            isEnabled={enabledSkills.has(skill.id)}
                            globalEnabled={globalEnabled}
                            groups={skillToGroups.get(skill.id) ?? []}
                            enabledGroups={enabledGroups}
                            onToggle={handleSkillToggle}
                            onEdit={handleEdit}
                            onDelete={handleDelete}
                          />
                        ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="groups" className="mt-0 flex-1 min-h-0 overflow-auto p-3">
                {filteredGroups.length === 0 ? (
                  <div className="text-center py-12">
                    <FolderTree className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                    <h3 className="text-lg font-semibold mb-2">{t('noGroupsFound')}</h3>
                    <p className="text-muted-foreground mb-4">
                      {searchQuery ? t('tryDifferentSearch') : t('createFirstGroup')}
                    </p>
                    {!searchQuery && (
                      <Button onClick={handleOpenCreateGroup}>
                        <FolderTree className="w-4 h-4 mr-2" />
                        {t('newGroup')}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {filteredGroups.map(group => (
                      <GroupCard
                        key={group.id}
                        group={group}
                        isEnabled={enabledGroups.has(group.id)}
                        globalEnabled={globalEnabled}
                        allSkills={skills}
                        enabledSkills={enabledSkills}
                        onGroupToggle={handleGroupToggle}
                        onSkillToggle={handleSkillToggle}
                        onEditGroup={handleEditGroup}
                        onDeleteGroup={handleDeleteGroup}
                      />
                    ))}
                  </div>
                )}
              </TabsContent>
              </Section>
            </Tabs>
          </div>
        </div>
      </div>

      {/* Skill Editor Dialog */}
      <Dialog open={!!editorMode} onOpenChange={(open) => !open && handleEditorCancel()}>
        <DialogContent className="max-w-[90vw] sm:max-w-[85vw] lg:max-w-3xl h-[90vh] p-0 overflow-hidden">
          {editorMode && (
            <SkillEditor
              skill={selectedSkill}
              mode={editorMode}
              onSave={handleEditorSave}
              onCancel={handleEditorCancel}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Group Create/Edit Dialog */}
      <GroupEditorDialog
        open={groupDialogOpen}
        mode={groupDialogMode}
        group={groupBeingEdited}
        allSkills={skills}
        onSave={handleGroupDialogSave}
        onCancel={() => {
          setGroupDialogOpen(false);
          setGroupBeingEdited(null);
        }}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteConfirmOpen} onOpenChange={(open) => {
        setDeleteConfirmOpen(open);
        if (!open) {
          setSkillToDelete(null);
          setGroupToDelete(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{skillToDelete ? t('deleteSkill') : t('deleteGroup')}</DialogTitle>
            <DialogDescription>
              {skillToDelete
                ? t('confirmDeleteSkill', { name: skillToDelete.name })
                : t('confirmDeleteGroup', { name: groupToDelete?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
              {tc('actions.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              {tc('actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface SkillCardProps {
  skill: Skill;
  isEnabled: boolean;
  globalEnabled: boolean;
  groups: SkillGroup[];
  enabledGroups: Set<string>;
  onToggle: (skillId: string, enabled: boolean) => void;
  onEdit: (skill: Skill) => void;
  onDelete: (skill: Skill) => void;
}

function SkillCard({ skill, isEnabled, globalEnabled, groups, enabledGroups, onToggle, onEdit, onDelete }: SkillCardProps) {
  const tc = useTranslations('common');
  const t = useTranslations('skills');
  const groupCopy = useSkillGroupCopy();
  const when = useLocalFormat();
  const [isOpen, setIsOpen] = useState(false);
  const enabledMemberGroups = groups.filter(g => enabledGroups.has(g.id));
  const enabledByGroup = enabledMemberGroups.length > 0;
  // Group enables override the individual disabled state.
  const effectiveEnabled = globalEnabled && (isEnabled || enabledByGroup);
  // The individual toggle is ignored as long as a group is enabling the skill.
  const individualOverridden = enabledByGroup && !isEnabled;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className={`border rounded-lg transition-colors ${effectiveEnabled ? 'border-primary/30 bg-primary/5' : 'border-border'}`}>
        <div className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <CollapsibleTrigger className="flex items-center gap-2 hover:text-primary transition-colors">
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 shrink-0" />
                  )}
                  <h3 className="font-semibold truncate">{skill.name}</h3>
                </CollapsibleTrigger>
                {skill.isBuiltIn && (
                  <Badge variant="secondary" className="text-xs">
                    {tc('labels.builtIn')}
                  </Badge>
                )}
                {!effectiveEnabled && (
                  <Badge variant="outline" className="text-xs text-muted-foreground">
                    {t('disabled')}
                  </Badge>
                )}
                {enabledByGroup && (
                  <Badge
                    variant="outline"
                    className="text-xs gap-1"
                    title={t('activeViaGroups', { count: enabledMemberGroups.length, groups: enabledMemberGroups.map(g => groupCopy(g).name).join(', '), override: individualOverridden ? 'yes' : 'no' })}
                  >
                    <FolderTree className="w-3 h-3" />
                    {enabledMemberGroups.length === 1
                      ? groupCopy(enabledMemberGroups[0]).name
                      : t('groupCount', { count: enabledMemberGroups.length })}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground line-clamp-2">
                {skill.description}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={isEnabled}
                onCheckedChange={(checked) => onToggle(skill.id, checked)}
                disabled={!globalEnabled}
              />
              {!skill.isBuiltIn && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEdit(skill)}
                  >
                    <Edit className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(skill)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        <CollapsibleContent>
          <div className="border-t px-4 py-3 bg-muted/30">
            <div className="text-sm space-y-2">
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="font-medium">{t('updatedLabel')}</span>
                <span>{when.dateTime(skill.updatedAt, { dateStyle: 'medium' })}</span>
              </div>
              <div>
                <span className="font-medium text-muted-foreground">{t('descriptionLabel')}</span>
                <p className="mt-1">{skill.description}</p>
              </div>
              <div>
                <span className="font-medium text-muted-foreground">{t('contentLabel')}</span>
                <pre className="mt-1 text-xs bg-background p-3 rounded border overflow-auto max-h-96 whitespace-pre-wrap">
                  {skill.markdown}
                </pre>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

interface GroupCardProps {
  group: SkillGroup;
  isEnabled: boolean;
  globalEnabled: boolean;
  allSkills: Skill[];
  enabledSkills: Set<string>;
  onGroupToggle: (groupId: string, enabled: boolean) => void;
  onSkillToggle: (skillId: string, enabled: boolean) => void;
  onEditGroup: (group: SkillGroup) => void;
  onDeleteGroup: (group: SkillGroup) => void;
}

function GroupCard({
  group,
  isEnabled,
  globalEnabled,
  allSkills,
  enabledSkills,
  onGroupToggle,
  onSkillToggle,
  onEditGroup,
  onDeleteGroup,
}: GroupCardProps) {
  const tc = useTranslations('common');
  const t = useTranslations('skills');
  const groupCopy = useSkillGroupCopy();
  const [isOpen, setIsOpen] = useState(false);
  const effectiveEnabled = globalEnabled && isEnabled;
  const memberSkills = group.memberIds
    .map(id => allSkills.find(s => s.id === id))
    .filter((s): s is Skill => Boolean(s));
  const missingCount = group.memberIds.length - memberSkills.length;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className={`border rounded-lg transition-colors ${effectiveEnabled ? 'border-primary/30 bg-primary/5' : 'border-border'}`}>
        <div className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <CollapsibleTrigger className="flex items-center gap-2 hover:text-primary transition-colors">
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4 shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 shrink-0" />
                  )}
                  <h3 className="font-semibold truncate">{groupCopy(group).name}</h3>
                </CollapsibleTrigger>
                <Badge variant="outline" className="text-xs">
                  {t('memberCount', { count: memberSkills.length })}
                </Badge>
                {group.isBuiltIn && (
                  <Badge variant="secondary" className="text-xs">{tc('labels.builtIn')}</Badge>
                )}
                {!effectiveEnabled && (
                  <Badge variant="outline" className="text-xs text-muted-foreground">{t('disabled')}</Badge>
                )}
                {missingCount > 0 && (
                  <Badge variant="outline" className="text-xs text-amber-600 border-amber-600/30">
                    {t('missingCount', { count: missingCount })}
                  </Badge>
                )}
              </div>
              {groupCopy(group).description && (
                <p className="text-sm text-muted-foreground line-clamp-2">{groupCopy(group).description}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={isEnabled}
                onCheckedChange={(checked) => onGroupToggle(group.id, checked)}
                disabled={!globalEnabled}
              />
              {!group.isBuiltIn && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => onEditGroup(group)}>
                    <Edit className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onDeleteGroup(group)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        <CollapsibleContent>
          <div className="border-t bg-muted/30">
            {memberSkills.length === 0 ? (
              <div className="px-4 py-3 text-xs text-muted-foreground">{t('noMemberSkills')}</div>
            ) : (
              <div className="divide-y">
                {memberSkills.map(skill => {
                  const skillEnabled = enabledSkills.has(skill.id);
                  return (
                    <div key={skill.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{skill.name}</span>
                          {skill.isBuiltIn && (
                            <Badge variant="secondary" className="text-[10px] py-0">{tc('labels.builtIn')}</Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-1">{skill.description}</p>
                      </div>
                      <Switch
                        checked={skillEnabled}
                        onCheckedChange={(checked) => onSkillToggle(skill.id, checked)}
                        disabled={!globalEnabled}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

interface GroupEditorDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  group: SkillGroup | null;
  allSkills: Skill[];
  onSave: () => void;
  onCancel: () => void;
}

function GroupEditorDialog({ open, mode, group, allSkills, onSave, onCancel }: GroupEditorDialogProps) {
  const t = useTranslations('skills');
  const tc = useTranslations('common');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [memberFilter, setMemberFilter] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      if (mode === 'edit' && group) {
        setName(group.name);
        setDescription(group.description ?? '');
        setMemberIds(new Set(group.memberIds));
      } else {
        setName('');
        setDescription('');
        setMemberIds(new Set());
      }
      setMemberFilter('');
    }
  }, [open, mode, group]);

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error(t('groupNameRequired'));
      return;
    }
    setSaving(true);
    try {
      if (mode === 'create') {
        await skillsService.createGroup({
          name: name.trim(),
          description: description.trim() || undefined,
          memberIds: Array.from(memberIds),
        });
        toast.success(t('createdGroup', { name: name.trim() }));
      } else if (group) {
        await skillsService.updateGroup(group.id, {
          name: name.trim(),
          description: description.trim() || undefined,
          memberIds: Array.from(memberIds),
        });
        toast.success(t('updatedGroup', { name: name.trim() }));
      }
      onSave();
    } catch (error) {
      const message = error instanceof Error ? error.message : t('saveGroupFailed');
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const filteredSkills = allSkills.filter(s => {
    if (!memberFilter) return true;
    const q = memberFilter.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('newGroupTitle') : t('editGroupTitle')}</DialogTitle>
          <DialogDescription>
            {t('groupDialogDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4">
          <div>
            <Label htmlFor="group-name" className="text-sm font-medium">{tc('labels.name')}</Label>
            <Input
              id="group-name"
              placeholder={t('groupNamePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={mode === 'edit'}
              className="mt-1"
            />
            {mode === 'edit' && (
              <p className="text-xs text-muted-foreground mt-1">{t('groupIdFixed')}</p>
            )}
          </div>

          <div>
            <Label htmlFor="group-description" className="text-sm font-medium">{tc('labels.descriptionOptional')}</Label>
            <Textarea
              id="group-description"
              placeholder={t('groupPurpose')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1"
              rows={2}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label className="text-sm font-medium">
                {t('members')}
                <span className="ml-2 text-xs text-muted-foreground font-normal">
                  {t('selectedCount', { count: memberIds.size })}
                </span>
              </Label>
            </div>
            <div className="relative mb-2">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('filterSkills')}
                value={memberFilter}
                onChange={(e) => setMemberFilter(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="border rounded-lg max-h-72 overflow-y-auto divide-y">
              {filteredSkills.length === 0 ? (
                <div className="px-3 py-4 text-xs text-muted-foreground text-center">{t('noSkillsMatch')}</div>
              ) : (
                filteredSkills.map(skill => (
                  <label
                    key={skill.id}
                    className="flex items-start gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                  >
                    <Checkbox
                      checked={memberIds.has(skill.id)}
                      onCheckedChange={(checked) => {
                        setMemberIds(prev => {
                          const next = new Set(prev);
                          if (checked) next.add(skill.id);
                          else next.delete(skill.id);
                          return next;
                        });
                      }}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{skill.name}</span>
                        {skill.isBuiltIn && (
                          <Badge variant="secondary" className="text-[10px] py-0">{tc('labels.builtIn')}</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-1">{skill.description}</p>
                    </div>
                  </label>
                ))
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>{tc('actions.cancel')}</Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? tc('actions.saving') : mode === 'create' ? t('createGroup') : tc('actions.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
