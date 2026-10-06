'use client';

import React, { useState, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import { useTranslations } from 'next-intl';
import { vfs } from '@/lib/vfs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { UnifiedSettingsModal } from '@/components/unified-settings';
import { FunctionsManager } from '@/components/database-manager/functions-manager';
import { ServerFunctionsManager } from '@/components/database-manager/server-functions-manager';
import { SecretsManager } from '@/components/database-manager/secrets-manager';
import { ScheduledFunctionsManager } from '@/components/database-manager/scheduled-functions-manager';
import { Code2, Wrench, Key, Clock, Lock, Settings, Settings2, PowerOff, Database, AlertTriangle, Plus, Trash2, ArrowUp, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { logger } from '@/lib/utils';
import { track } from '@/lib/telemetry';
import { newPromptSuggestion, usablePromptSuggestions } from '@/lib/vfs/prompt-suggestions';
import { INLINE_SUGGESTION_COUNT } from '@/lib/constants/suggestion-pills';
import type { Project, ProjectRuntime, PromptSuggestion } from '@/lib/vfs/types';
import { getProjectRuntimes } from '@/lib/runtimes/registry';
import { useRuntimeDescriptions } from '@/lib/i18n/use-runtime-descriptions';
import type {
  FunctionsDataProvider,
  ServerFunctionsDataProvider,
  SecretsDataProvider,
  ScheduledFunctionsDataProvider,
} from '@/components/database-manager/data-providers';
import { SchemaEditor } from './schema-editor';
import { getProjectSchema } from '@/lib/vfs/project-schema';
import { InfoTip } from '@/components/ui/info-tip';
import { matchesPathPattern } from '@/lib/vfs/suggestion-paths';
import {
  pageDirectories,
  patternToRule,
  ruleToPattern,
  type PathRule,
} from '@/lib/vfs/suggestion-path-rules';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { REPO_URL } from '@/lib/constants/links';

interface ProjectSettingsPanelProps {
  project: Project;
  onProjectUpdate: (project: Project) => void;
  enabled: boolean;
  workspaceId?: string;
}

function createFunctionsProvider(projectId: string): FunctionsDataProvider {
  return {
    async list() {
      const adapter = vfs.getStorageAdapter();
      return adapter.listEdgeFunctions ? await adapter.listEdgeFunctions(projectId) : [];
    },
    async save(id, data) {
      const adapter = vfs.getStorageAdapter();
      const now = new Date();
      if (id && adapter.getEdgeFunction && adapter.updateEdgeFunction) {
        const existing = await adapter.getEdgeFunction(id);
        if (existing) await adapter.updateEdgeFunction({ ...existing, ...data, updatedAt: now });
      } else if (adapter.createEdgeFunction) {
        const enabled = data.enabled ?? true;
        await adapter.createEdgeFunction({
          id: crypto.randomUUID(),
          projectId,
          name: data.name || '',
          method: data.method || 'GET',
          code: data.code || '',
          description: data.description || '',
          enabled,
          timeoutMs: data.timeoutMs ?? 10000,
          createdAt: now,
          updatedAt: now,
        });
        if (enabled) track('backend_feature_enabled', { kind: 'edge' });
      }
      await vfs.noteProjectEdit(projectId);
    },
    async remove(id) {
      const adapter = vfs.getStorageAdapter();
      if (adapter.deleteEdgeFunction) await adapter.deleteEdgeFunction(id);
      await vfs.noteProjectEdit(projectId);
    },
    async toggle(id, enabled) {
      const adapter = vfs.getStorageAdapter();
      if (adapter.getEdgeFunction && adapter.updateEdgeFunction) {
        const existing = await adapter.getEdgeFunction(id);
        if (existing) {
          await adapter.updateEdgeFunction({ ...existing, enabled, updatedAt: new Date() });
          if (enabled && !existing.enabled) track('backend_feature_enabled', { kind: 'edge' });
        }
      }
      await vfs.noteProjectEdit(projectId);
    },
  };
}

function createServerFunctionsProvider(projectId: string): ServerFunctionsDataProvider {
  return {
    async list() {
      const adapter = vfs.getStorageAdapter();
      return adapter.listServerFunctions ? await adapter.listServerFunctions(projectId) : [];
    },
    async save(id, data) {
      const adapter = vfs.getStorageAdapter();
      const now = new Date();
      if (id && adapter.getServerFunction && adapter.updateServerFunction) {
        const existing = await adapter.getServerFunction(id);
        if (existing) await adapter.updateServerFunction({ ...existing, ...data, updatedAt: now });
      } else if (adapter.createServerFunction) {
        const enabled = data.enabled ?? true;
        await adapter.createServerFunction({
          id: crypto.randomUUID(),
          projectId,
          name: data.name || '',
          code: data.code || '',
          description: data.description || '',
          enabled,
          createdAt: now,
          updatedAt: now,
        });
        if (enabled) track('backend_feature_enabled', { kind: 'server_fn' });
      }
      await vfs.noteProjectEdit(projectId);
    },
    async remove(id) {
      const adapter = vfs.getStorageAdapter();
      if (adapter.deleteServerFunction) await adapter.deleteServerFunction(id);
      await vfs.noteProjectEdit(projectId);
    },
    async toggle(id, enabled) {
      const adapter = vfs.getStorageAdapter();
      if (adapter.getServerFunction && adapter.updateServerFunction) {
        const existing = await adapter.getServerFunction(id);
        if (existing) {
          await adapter.updateServerFunction({ ...existing, enabled, updatedAt: new Date() });
          if (enabled && !existing.enabled) track('backend_feature_enabled', { kind: 'server_fn' });
        }
      }
      await vfs.noteProjectEdit(projectId);
    },
  };
}

function createSecretsProvider(projectId: string): SecretsDataProvider {
  return {
    async list() {
      const adapter = vfs.getStorageAdapter();
      const secrets = adapter.listSecrets ? await adapter.listSecrets(projectId) : [];
      return { secrets, encryptionConfigured: true };
    },
    async save(id, data) {
      const adapter = vfs.getStorageAdapter();
      const now = new Date();
      if (id && adapter.getSecret && adapter.updateSecret) {
        const existing = await adapter.getSecret(id);
        if (existing) await adapter.updateSecret({ ...existing, ...data, hasValue: !!data.value || existing.hasValue, updatedAt: now });
      } else if (adapter.createSecret) {
        await adapter.createSecret({
          id: crypto.randomUUID(),
          projectId,
          name: data.name,
          description: data.description || '',
          hasValue: !!data.value,
          value: data.value,
          createdAt: now,
          updatedAt: now,
        });
        track('backend_feature_enabled', { kind: 'secrets' });
      }
      await vfs.noteProjectEdit(projectId);
    },
    async remove(id) {
      const adapter = vfs.getStorageAdapter();
      if (adapter.deleteSecret) await adapter.deleteSecret(id);
      await vfs.noteProjectEdit(projectId);
    },
  };
}

function createScheduledFunctionsProvider(projectId: string): ScheduledFunctionsDataProvider {
  return {
    async listScheduled() {
      const adapter = vfs.getStorageAdapter();
      return adapter.listScheduledFunctions ? await adapter.listScheduledFunctions(projectId) : [];
    },
    async listEdgeFunctions() {
      const adapter = vfs.getStorageAdapter();
      return adapter.listEdgeFunctions ? await adapter.listEdgeFunctions(projectId) : [];
    },
    async save(id, data) {
      const adapter = vfs.getStorageAdapter();
      const now = new Date();
      if (id && adapter.getScheduledFunction && adapter.updateScheduledFunction) {
        const existing = await adapter.getScheduledFunction(id);
        if (existing) await adapter.updateScheduledFunction({ ...existing, ...data, updatedAt: now });
      } else if (adapter.createScheduledFunction) {
        const enabled = data.enabled ?? true;
        await adapter.createScheduledFunction({
          id: crypto.randomUUID(),
          projectId,
          name: data.name || '',
          description: data.description || '',
          functionId: data.functionId || '',
          cronExpression: data.cronExpression || '',
          timezone: data.timezone || 'UTC',
          config: data.config || {},
          enabled,
          createdAt: now,
          updatedAt: now,
        });
        if (enabled) track('backend_feature_enabled', { kind: 'scheduled' });
      }
      await vfs.noteProjectEdit(projectId);
    },
    async remove(id) {
      const adapter = vfs.getStorageAdapter();
      if (adapter.deleteScheduledFunction) await adapter.deleteScheduledFunction(id);
      await vfs.noteProjectEdit(projectId);
    },
    async toggle(id, enabled) {
      const adapter = vfs.getStorageAdapter();
      if (adapter.getScheduledFunction && adapter.updateScheduledFunction) {
        const existing = await adapter.getScheduledFunction(id);
        if (existing) {
          await adapter.updateScheduledFunction({ ...existing, enabled, updatedAt: new Date() });
          if (enabled && !existing.enabled) track('backend_feature_enabled', { kind: 'scheduled' });
        }
      }
      await vfs.noteProjectEdit(projectId);
    },
  };
}

function GeneralTab({ project, onProjectUpdate }: { project: Project; onProjectUpdate: (project: Project) => void }) {
  const t = useTranslations('backend');
  const runtimeDescriptions = useRuntimeDescriptions();
  const tc = useTranslations('common');
  const [editingEntryPoint, setEditingEntryPoint] = useState(
    project.settings?.previewEntryPoint || '/index.html'
  );
  const [promptOverwriteConfirm, setPromptOverwriteConfirm] = useState<{
    runtime: ProjectRuntime;
    label: string;
  } | null>(null);

  const updatePromptForRuntime = async (runtime: ProjectRuntime) => {
    try {
      const { getDomainPrompt, isDefaultDomainPrompt } = await import('@/lib/llm/prompts');
      const newPrompt = getDomainPrompt(runtime);

      let currentContent: string | null = null;
      try {
        const file = await vfs.readFile(project.id, '/.PROMPT.md');
        if (file && typeof file.content === 'string') currentContent = file.content;
      } catch { /* doesn't exist */ }

      if (currentContent === null) {
        // No .PROMPT.md — create it
        await vfs.createFile(project.id, '/.PROMPT.md', newPrompt);
      } else if (isDefaultDomainPrompt(currentContent)) {
        // Default prompt — silently replace
        await vfs.updateFile(project.id, '/.PROMPT.md', newPrompt);
      } else {
        // Custom prompt — ask user
        const label = getProjectRuntimes().find(r => r.value === runtime)?.label || runtime;
        setPromptOverwriteConfirm({ runtime, label });
        return;
      }
      window.dispatchEvent(new CustomEvent('filesChanged', { detail: { projectId: project.id } }));
    } catch (err) {
      logger.error('Failed to update .PROMPT.md:', err);
    }
  };

  const confirmPromptOverwrite = async () => {
    if (!promptOverwriteConfirm) return;
    try {
      const { getDomainPrompt } = await import('@/lib/llm/prompts');
      const newPrompt = getDomainPrompt(promptOverwriteConfirm.runtime);
      await vfs.updateFile(project.id, '/.PROMPT.md', newPrompt);
      window.dispatchEvent(new CustomEvent('filesChanged', { detail: { projectId: project.id } }));
      toast.success(t('promptUpdated'));
    } catch (err) {
      logger.error('Failed to overwrite .PROMPT.md:', err);
      toast.error(t('promptUpdateFailed'));
    } finally {
      setPromptOverwriteConfirm(null);
    }
  };

  const handleRuntimeChange = async (value: ProjectRuntime) => {
    try {
      const previousRuntime = project.settings?.runtime || 'handlebars';
      const proj = await vfs.getProject(project.id);
      proj.settings = { ...proj.settings, runtime: value };
      await vfs.updateProject(proj);
      // Project settings are stored server-side; opened from the gallery there is no save
      // that would otherwise push this.
      vfs.scheduleAutoSync(proj.id);
      onProjectUpdate(proj);
      const label = getProjectRuntimes().find(r => r.value === value)?.label || value;
      toast.success(t('runtimeChanged', { label }));
      track('runtime_switch', { from: previousRuntime, to: value });
      await updatePromptForRuntime(value);
    } catch (err) {
      logger.error('Failed to update runtime:', err);
      toast.error(t('runtimeUpdateFailed'));
    }
  };

  const handleEntryPointCommit = async () => {
    const trimmed = editingEntryPoint.trim();
    const current = project.settings?.previewEntryPoint || '/index.html';
    if (trimmed === current) return;
    try {
      const proj = await vfs.getProject(project.id);
      proj.settings = { ...proj.settings, previewEntryPoint: trimmed };
      await vfs.updateProject(proj);
      vfs.scheduleAutoSync(proj.id);
      onProjectUpdate(proj);
      toast.success(t('entryPointSetTo', { path: trimmed }));
    } catch (err) {
      logger.error('Failed to update entry point:', err);
      toast.error(t('entryPointUpdateFailed'));
    }
  };

  return (
    <div className="p-4 space-y-6">
      <div className="space-y-2">
        <Label htmlFor="runtime">{tc('labels.runtime')}</Label>
        <Select value={project.settings?.runtime || 'handlebars'} onValueChange={handleRuntimeChange}>
          <SelectTrigger id="runtime" className="w-full">
            <div className="truncate flex-1 text-left">
              {getProjectRuntimes().find(r => r.value === (project.settings?.runtime || 'handlebars'))?.label}
            </div>
          </SelectTrigger>
          <SelectContent>
            {getProjectRuntimes().map(rt => (
              <SelectItem key={rt.value} value={rt.value}>
                <div className="flex flex-col gap-0.5">
                  <div className="font-medium">{rt.label}</div>
                  <div className="text-xs text-muted-foreground">{runtimeDescriptions[rt.value] ?? rt.description}</div>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="entry-point">{t('previewEntryPoint')}</Label>
        <Input
          id="entry-point"
          value={editingEntryPoint}
          onChange={(e) => setEditingEntryPoint(e.target.value)}
          onBlur={handleEntryPointCommit}
          onKeyDown={(e) => { if (e.key === 'Enter') handleEntryPointCommit(); }}
          placeholder="/index.html"
        />
        <p className="text-xs text-muted-foreground">
          {t('entryPointHelp')}
        </p>
      </div>

      <div id="project-settings-suggestions" className="scroll-mt-4">
        <PromptSuggestionsEditor project={project} onProjectUpdate={onProjectUpdate} />
      </div>

      <Dialog open={!!promptOverwriteConfirm} onOpenChange={(open) => !open && setPromptOverwriteConfirm(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              {t('updatePromptTitle')}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t('updatePromptBody', { label: promptOverwriteConfirm?.label ?? '' })}
          </p>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="outline" size="sm" onClick={() => setPromptOverwriteConfirm(null)}>
              {t('keepCurrent')}
            </Button>
            <Button size="sm" onClick={confirmPromptOverwrite}>
              {t('replace')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The chat starters offered above the composer on an empty conversation.
 *
 * Edited here rather than only seeded by a template, because the template that made the project
 * stops being relevant the moment someone changes what the project is for. Order is meaningful:
 * the first three appear on the row and the rest go behind the overflow menu, which is why there
 * are move controls rather than an alphabetical list.
 */
/** A rule as edited. The id is for React and for editing; only the compiled glob is stored. */
interface PathRuleRow extends PathRule {
  id: string;
}

/**
 * The kind names for the closed selector. The options inside it read the same three keys, so
 * without this the trigger showed English next to a translated menu.
 */
function useRuleKindLabels(): Record<PathRule['kind'], string> {
  const t = useTranslations('backend');
  return useMemo(() => ({
    page: t('page'),
    directory: t('directory'),
    pattern: t('pattern'),
  }), [t]);
}

/**
 * A picked value that is no longer in the project still has to be selectable, or opening the editor
 * would silently swap it for the first page in the list.
 */
function withCurrent(options: string[], current: string): string[] {
  return current !== '' && !options.includes(current) ? [...options, current] : options;
}

/** Silent until there is a pattern to count, so an empty field does not read as "matches nothing". */
function PatternMatchCount({ patterns, pagePaths }: { patterns: string[]; pagePaths: string[] }) {
  const t = useTranslations('backend');
  const usable = patterns.map((p) => p.trim()).filter((p) => p !== '');
  if (usable.length === 0 || pagePaths.length === 0) return null;

  const matched = pagePaths.filter((page) => usable.some((p) => matchesPathPattern(p, page))).length;
  return (
    <p className="text-[11px] text-muted-foreground">
      {t('patternMatches', { matched, total: pagePaths.length })}
    </p>
  );
}

function PromptSuggestionsEditor({
  project,
  onProjectUpdate,
}: {
  project: Project;
  onProjectUpdate: (project: Project) => void;
}) {
  const tc = useTranslations('common');
  const t = useTranslations('backend');
  const ruleKindLabels = useRuleKindLabels();
  const [draft, setDraft] = useState<PromptSuggestion[]>(
    () => project.settings?.promptSuggestions ?? []
  );
  const [saving, setSaving] = useState(false);
  // The rows as edited, kept while the toggle is off so turning it back on restores them.
  const [ruleRows, setRuleRows] = useState<Record<string, PathRuleRow[]>>({});
  const [pagePaths, setPagePaths] = useState<string[]>([]);

  const stored = JSON.stringify(project.settings?.promptSuggestions ?? []);
  const dirty = JSON.stringify(usablePromptSuggestions(draft)) !== stored;

  // The draft initializer only runs on mount. Without this, a panel that stays mounted while the
  // project reloads keeps showing the draft it started with, so a saved suggestion looks lost.
  useEffect(() => {
    setDraft(project.settings?.promptSuggestions ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, stored]);

  useEffect(() => {
    // Cancelled on a project change so a slow answer for the previous one cannot land after a
    // newer one and describe the wrong project's pages.
    let cancelled = false;

    vfs.listFiles(project.id)
      .then((files) => {
        if (cancelled) return;
        setPagePaths(files.filter((f) => f.path.endsWith('.html')).map((f) => f.path));
      })
      .catch(() => {
        // The match count is supplementary; with no pages it renders nothing rather than a wrong
        // number.
        if (!cancelled) setPagePaths([]);
      });

    return () => { cancelled = true; };
  }, [project.id]);

  const pagesKey = pagePaths.join('|');
  const directories = useMemo(() => pageDirectories(pagePaths), [pagesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each rule's kind is worked out from its stored glob, so this has to run again when the page
  // list arrives as well as when the project changes: until it lands, a stored page path cannot be
  // told apart from a typed one. Not keyed on `draft`, since re-seeding on every keystroke would
  // discard the row being edited.
  useEffect(() => {
    const seeded: Record<string, PathRuleRow[]> = {};
    for (const suggestion of project.settings?.promptSuggestions ?? []) {
      if (!suggestion.paths) continue;
      seeded[suggestion.id] = suggestion.paths.map((pattern) => ({
        id: crypto.randomUUID(),
        ...patternToRule(pattern, pagePaths),
      }));
    }
    setRuleRows(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, stored, pagesKey]);

  const update = (id: string, patch: Partial<PromptSuggestion>) =>
    setDraft(rows => rows.map(row => (row.id === id ? { ...row, ...patch } : row)));

  const move = (index: number, delta: number) =>
    setDraft(rows => {
      const next = [...rows];
      const target = index + delta;
      if (target < 0 || target >= next.length) return rows;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const blankRule = (): PathRuleRow => ({
    id: crypto.randomUUID(),
    kind: pagePaths.length > 0 ? 'page' : 'pattern',
    value: '',
  });

  const setRules = (suggestionId: string, rows: PathRuleRow[]) => {
    setRuleRows((all) => ({ ...all, [suggestionId]: rows }));
    update(suggestionId, { paths: rows.map(ruleToPattern) });
  };

  const editRule = (suggestionId: string, rowId: string, patch: Partial<PathRuleRow>) =>
    setRules(
      suggestionId,
      (ruleRows[suggestionId] ?? []).map((row) => (row.id === rowId ? { ...row, ...patch } : row))
    );

  const save = async () => {
    setSaving(true);
    try {
      // Cleaned on the way out, so a half-typed row never reaches storage and takes up one of the
      // three inline slots as an invisible button.
      const cleaned = usablePromptSuggestions(draft);
      const proj = await vfs.getProject(project.id);
      proj.settings = { ...proj.settings, promptSuggestions: cleaned };
      await vfs.updateProject(proj);
      vfs.scheduleAutoSync(proj.id);
      // The chat panel reads these from the workspace store, which is loaded once when the project
      // opens. Without this the save reaches storage but not the row above the composer, so an
      // edited suggestion only appeared after reopening the project.
      useWorkspaceStore.getState().updateProjectSettings({ promptSuggestions: cleaned });
      onProjectUpdate(proj);
      setDraft(cleaned);
      toast.success(cleaned.length === 0 ? t('suggestionsCleared') : t('suggestionsSaved'));
    } catch (err) {
      logger.error('Failed to save prompt suggestions:', err);
      toast.error(t('saveSuggestionsFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <Label>{t('chatSuggestions')}</Label>
      <p className="text-xs text-muted-foreground">
        {t('suggestionsHint', { count: INLINE_SUGGESTION_COUNT })}
      </p>

      <div className="space-y-3 pt-1">
        {draft.map((suggestion, index) => (
          <div key={suggestion.id} className="rounded-md border border-border p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Input
                value={suggestion.label}
                onChange={(e) => update(suggestion.id, { label: e.target.value })}
                placeholder={t('buttonText')}
                aria-label={t('ariaSuggestionText', { n: index + 1 })}
                className="flex-1"
              />
              <Button
                variant="ghost" size="sm" aria-label={t('moveUp')}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost" size="sm" aria-label={t('moveDown')}
                disabled={index === draft.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost" size="sm" aria-label={t('removeSuggestion')}
                onClick={() => setDraft(rows => rows.filter(row => row.id !== suggestion.id))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            <textarea
              value={suggestion.prompt}
              onChange={(e) => update(suggestion.id, { prompt: e.target.value })}
              placeholder={t('suggestionPlaceholder')}
              aria-label={t('ariaSuggestionPrompt', { n: index + 1 })}
              rows={3}
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm resize-y"
            />

            <div className="border-t border-border/60 pt-2 space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor={`scoped-${suggestion.id}`} className="text-xs font-normal">
                  {t('onlyCertainPages')}
                </Label>
                <InfoTip>{t('scopeHelp')}</InfoTip>
                <Switch
                  id={`scoped-${suggestion.id}`}
                  className="ml-auto"
                  checked={suggestion.paths !== undefined}
                  onCheckedChange={(on) => {
                    // Turning it off keeps the rows rather than clearing them, so a mis-click is
                    // not destructive. `usablePromptSuggestions` writes `paths` only while the
                    // toggle is on, so an off row saves as unscoped either way.
                    if (!on) {
                      update(suggestion.id, { paths: undefined });
                      return;
                    }
                    const kept = ruleRows[suggestion.id] ?? [];
                    setRules(suggestion.id, kept.length > 0 ? kept : [blankRule()]);
                  }}
                />
              </div>

              {suggestion.paths !== undefined && (
                <div className="border-l-2 border-primary/40 pl-3 space-y-1.5">
                  {(ruleRows[suggestion.id] ?? []).map((row, ruleIndex) => (
                    <div key={row.id} className="flex items-center gap-1.5">
                      <Select
                        value={row.kind}
                        onValueChange={(kind) =>
                          editRule(suggestion.id, row.id, {
                            kind: kind as PathRule['kind'],
                            // Moving to Pattern keeps the glob the picker built, so nothing chosen
                            // is lost. The other direction has nothing to map to, so it clears.
                            value: kind === 'pattern' ? ruleToPattern(row) : '',
                          })
                        }
                      >
                        <SelectTrigger
                          size="sm"
                          className="w-[112px] shrink-0"
                          aria-label={t('ariaRuleType', { n: index + 1, rule: ruleIndex + 1 })}
                        >
                          <span className="text-xs">{ruleKindLabels[row.kind]}</span>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="page" disabled={pagePaths.length === 0}>{t('page')}</SelectItem>
                          <SelectItem value="directory" disabled={directories.length === 0}>{t('directory')}</SelectItem>
                          <SelectItem value="pattern">{t('pattern')}</SelectItem>
                        </SelectContent>
                      </Select>

                      {row.kind === 'pattern' ? (
                        <Input
                          value={row.value}
                          onChange={(e) => editRule(suggestion.id, row.id, { value: e.target.value })}
                          placeholder="/articles/*.html"
                          aria-label={t('ariaRulePattern', { n: index + 1, rule: ruleIndex + 1 })}
                          className="flex-1 min-w-0 h-8 text-xs font-mono"
                        />
                      ) : (
                        <Select
                          value={row.value}
                          onValueChange={(value) => editRule(suggestion.id, row.id, { value })}
                        >
                          <SelectTrigger
                            size="sm"
                            className="flex-1 min-w-0"
                            aria-label={t(row.kind === 'page' ? 'ariaRulePage' : 'ariaRuleDirectory', { n: index + 1, rule: ruleIndex + 1 })}
                          >
                            {row.value === '' ? (
                              <span className="text-xs text-muted-foreground">
                                {row.kind === 'page' ? t('choosePage') : t('chooseDirectory')}
                              </span>
                            ) : (
                              <span className="text-xs font-mono truncate">{row.value}</span>
                            )}
                          </SelectTrigger>
                          <SelectContent>
                            {withCurrent(row.kind === 'page' ? pagePaths : directories, row.value).map((option) => (
                              <SelectItem key={option} value={option} className="text-xs font-mono">
                                {option}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}

                      <Button
                        variant="ghost" size="sm"
                        aria-label={t('ariaRemoveRule', { n: index + 1, rule: ruleIndex + 1 })}
                        onClick={() =>
                          setRules(suggestion.id, (ruleRows[suggestion.id] ?? []).filter((r) => r.id !== row.id))
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost" size="sm" className="text-xs"
                      onClick={() =>
                        setRules(suggestion.id, [...(ruleRows[suggestion.id] ?? []), blankRule()])
                      }
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      {t('addPageRule')}
                    </Button>
                    {pagePaths.length === 0 && (
                      <span className="text-[11px] text-muted-foreground">
                        {t('noPagesYet')}
                      </span>
                    )}
                  </div>

                  <PatternMatchCount patterns={suggestion.paths ?? []} pagePaths={pagePaths} />
                </div>
              )}
            </div>
          </div>
        ))}

        {draft.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            {t('noSuggestions')}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button
          variant="outline" size="sm"
          onClick={() => setDraft(rows => [...rows, newPromptSuggestion()])}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          {t('addSuggestion')}
        </Button>
        <Button size="sm" onClick={save} disabled={!dirty || saving}>
          {saving ? tc('actions.saving') : tc('actions.save')}
        </Button>
      </div>
    </div>
  );
}

interface TabDef {
  value: string;
  icon: React.ReactNode;
  label: string;
}

/**
 * Renders the settings tabs as a normal tab row, collapsing to a Select dropdown when the row
 * would not fit the available width (measured with a ResizeObserver against a hidden natural-width
 * copy of the tabs). Must be rendered inside a <Tabs> — both branches drive the same active value.
 */
function ResponsiveTabBar({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: TabDef[];
  activeTab: string;
  onChange: (v: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const c = containerRef.current;
      const m = measureRef.current;
      if (!c || !m) return;
      // +8px buffer for rounding / the tab row's own gaps
      setCollapsed(m.scrollWidth + 8 > c.clientWidth);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [tabs]);

  const active = tabs.find((t) => t.value === activeTab) ?? tabs[0];

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Hidden measurer — natural width of the tabs at their content size. */}
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 flex whitespace-nowrap"
      >
        {tabs.map((t) => (
          <span key={t.value} className="flex items-center gap-1 px-3 py-1.5 text-xs">
            {t.icon}
            {t.label}
          </span>
        ))}
      </div>

      {collapsed ? (
        <Select value={activeTab} onValueChange={onChange}>
          <SelectTrigger className="w-full">
            <span className="flex items-center gap-1.5 text-xs">
              {active?.icon}
              {active?.label}
            </span>
          </SelectTrigger>
          <SelectContent>
            {tabs.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                <span className="flex items-center gap-1.5">
                  {t.icon}
                  {t.label}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <TabsList className="flex w-full">
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="flex-1 flex items-center gap-1 text-xs">
              {t.icon}
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      )}
    </div>
  );
}

export function ProjectSettingsPanel({ project, onProjectUpdate, enabled, workspaceId }: ProjectSettingsPanelProps) {
  const tdn = useTranslations('deploymentDetail.nav');
  const tc = useTranslations('common');
  const t = useTranslations('backend');
  const [activeTab, setActiveTab] = useState('general');
  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';

  const functionsProvider = useMemo(() => createFunctionsProvider(project.id), [project.id]);
  const serverFunctionsProvider = useMemo(() => createServerFunctionsProvider(project.id), [project.id]);
  const secretsProvider = useMemo(() => createSecretsProvider(project.id), [project.id]);
  const scheduledFunctionsProvider = useMemo(() => createScheduledFunctionsProvider(project.id), [project.id]);

  const hadDbSchemaRef = useRef(!!project.settings?.databaseSchema);
  useEffect(() => {
    let cancelled = false;
    getProjectSchema(project.id).then(schema => {
      if (!cancelled && schema) hadDbSchemaRef.current = true;
    });
    return () => { cancelled = true; };
  }, [project.id]);

  const tabs: TabDef[] = [
    { value: 'general', icon: <Settings2 className="h-3 w-3" />, label: tc('labels.project') },
    { value: 'functions', icon: <Code2 className="h-3 w-3" />, label: tdn('functions') },
    { value: 'helpers', icon: <Wrench className="h-3 w-3" />, label: tdn('helpers') },
    { value: 'secrets', icon: <Key className="h-3 w-3" />, label: tdn('secrets') },
    { value: 'schedules', icon: <Clock className="h-3 w-3" />, label: tdn('schedules') },
    { value: 'schema', icon: <Database className="h-3 w-3" />, label: tdn('schema') },
  ];

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
          <ResponsiveTabBar tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

          <div className="flex-1 overflow-hidden mt-3 rounded-lg border border-border bg-muted/20">
            <TabsContent value="general" className="h-full m-0 overflow-auto">
              <GeneralTab project={project} onProjectUpdate={onProjectUpdate} />
            </TabsContent>

            {!isServerMode ? (
              /* Browser mode: backend tabs show lock screen */
              <>
                {['functions', 'helpers', 'secrets', 'schedules', 'schema'].map(tab => (
                  <TabsContent key={tab} value={tab} className="h-full m-0">
                    <div className="h-full flex items-center justify-center p-8">
                      <div className="text-center max-w-sm">
                        <Lock className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
                        <h4 className="font-medium mb-2">{t('serverModeRequired')}</h4>
                        <p className="text-sm text-muted-foreground mb-4">
                          {t('serverModeExplain')}
                        </p>
                        <a
                          href={REPO_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-primary hover:underline"
                        >
                          {t('viewSetupGuide')}
                        </a>
                      </div>
                    </div>
                  </TabsContent>
                ))}
              </>
            ) : !enabled ? (
              /* Server mode but backend disabled */
              <>
                {['functions', 'helpers', 'secrets', 'schedules', 'schema'].map(tab => (
                  <TabsContent key={tab} value={tab} className="h-full m-0">
                    <div className="h-full flex items-center justify-center">
                      <div className="text-center max-w-xs">
                        <PowerOff className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                        <p className="text-sm text-muted-foreground">
                          {t('disabledExplain')}
                        </p>
                      </div>
                    </div>
                  </TabsContent>
                ))}
              </>
            ) : (
              /* Server mode, backend enabled */
              <>
                <TabsContent value="functions" className="h-full m-0">
                  <FunctionsManager dataProvider={functionsProvider} hideRuntimeFeatures />
                </TabsContent>

                <TabsContent value="helpers" className="h-full m-0">
                  <ServerFunctionsManager dataProvider={serverFunctionsProvider} />
                </TabsContent>

                <TabsContent value="secrets" className="h-full m-0">
                  <SecretsManager dataProvider={secretsProvider} />
                </TabsContent>

                <TabsContent value="schedules" className="h-full m-0">
                  <ScheduledFunctionsManager dataProvider={scheduledFunctionsProvider} />
                </TabsContent>

                <TabsContent value="schema" className="h-full m-0">
                  <SchemaEditor
                    projectId={project.id}
                    enabled={enabled}
                    onSchemaChange={() => {
                      if (!hadDbSchemaRef.current) {
                        hadDbSchemaRef.current = true;
                        track('backend_feature_enabled', { kind: 'db' });
                      }
                      vfs.refreshServerContext();
                    }}
                    workspaceId={workspaceId}
                  />
                </TabsContent>
              </>
            )}
          </div>
        </Tabs>
      </div>

    </div>
  );
}

interface ProjectSettingsModalProps {
  project: Project;
  isOpen: boolean;
  onClose: () => void;
  onProjectUpdate: (project: Project) => void;
  enabled: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  workspaceId?: string;
}

export function ProjectSettingsModal({ project, isOpen, onClose, onProjectUpdate, enabled, onToggleEnabled, workspaceId }: ProjectSettingsModalProps) {
  const tc = useTranslations('common');
  const t = useTranslations('backend');
  const isServerMode = process.env.NEXT_PUBLIC_SERVER_MODE === 'true';
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const requestedSection = useWorkspaceStore(s => s.projectSettingsSection);

  // Runs after the dialog has painted, since the target does not exist until then. The request is
  // cleared once used, so opening the dialog from anywhere else does not jump to it again.
  useEffect(() => {
    if (!isOpen || !requestedSection) return;
    const id = requestAnimationFrame(() => {
      document.getElementById(requestedSection)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      useWorkspaceStore.getState().clearProjectSettingsSection();
    });
    return () => cancelAnimationFrame(id);
  }, [isOpen, requestedSection]);

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-3xl h-[90vh] flex flex-col">
          <DialogHeader>
            <div className="flex items-center justify-between pr-6">
              <div>
                <DialogTitle className="flex items-center gap-2">
                  <Settings className="h-4 w-4" />
                  {tc('terms.settings')}
                </DialogTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  {project.name}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {isServerMode && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{enabled ? t('backendEnabled') : t('backendDisabled')}</span>
                    <Switch checked={enabled} onCheckedChange={onToggleEnabled} />
                  </div>
                )}
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                  onClick={() => setShowSettingsModal(true)}
                >
                  {t('manageSettings')}
                  <span>&rsaquo;</span>
                </button>
              </div>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            <ProjectSettingsPanel project={project} onProjectUpdate={onProjectUpdate} enabled={enabled} workspaceId={workspaceId} />
          </div>
        </DialogContent>
      </Dialog>

      <UnifiedSettingsModal
        open={showSettingsModal}
        onOpenChange={setShowSettingsModal}
      />
    </>
  );
}
