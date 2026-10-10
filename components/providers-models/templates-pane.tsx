'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useModelTemplateCopy } from '@/lib/i18n/use-model-template-copy';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { configManager } from '@/lib/config/storage';
import { trackAgentProviderChange } from '@/lib/telemetry/provider-selection';
import { getProvider } from '@/lib/llm/providers/registry';
import { track } from '@/lib/telemetry';
import { toast } from 'sonner';
import { ServerDeleteRefused } from '@/lib/vfs/auto-sync';
import type { ModelTemplate, ModelRef } from '@/lib/llm/models/assignment';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true when the provider for the agent model is reachable. */
function isAgentProviderConnected(template: ModelTemplate): boolean {
  const provider = template.assignment.agent.provider;
  return !!configManager.getProviderApiKey(provider) || !!configManager.getCachedModels(provider);
}

/** The keys {@link slotLabel} reads. */
type SlotLabelKey = 'slotNone' | 'slotReuseAgent' | 'slotBrowser';

/** Human-readable label for a ModelRef slot value. */
export function slotLabel(t: (key: SlotLabelKey) => string, value: ModelRef | 'agent' | 'browser' | null): string {
  if (value === null) return t('slotNone');
  if (value === 'agent') return t('slotReuseAgent');
  if (value === 'browser') return t('slotBrowser');
  // ModelRef
  const parts = value.model.split('/');
  const shortModel = parts[parts.length - 1] ?? value.model;
  return shortModel;
}

/** Provider name from provider id (best-effort). */
function providerName(providerId: string): string {
  try {
    return getProvider(providerId as Parameters<typeof getProvider>[0]).name;
  } catch {
    return providerId;
  }
}

// ---------------------------------------------------------------------------
// TemplateCard
// ---------------------------------------------------------------------------

interface TemplateCardProps {
  template: ModelTemplate;
  isActive: boolean;
  isRenaming: boolean;
  onApply: () => void;
  onRenameStart: () => void;
  onRenameCommit: (name: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  canDelete: boolean;
}

function TemplateCard({
  template,
  isActive,
  isRenaming,
  onApply,
  onRenameStart,
  onRenameCommit,
  onDuplicate,
  onDelete,
  canDelete,
}: TemplateCardProps) {
  const tc = useTranslations('common');
  const t = useTranslations('connections');
  const copy = useModelTemplateCopy();
  const { assignment } = template;
  const agentConnected = isAgentProviderConnected(template);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  function handleRenameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      onRenameCommit(e.currentTarget.value);
    } else if (e.key === 'Escape') {
      onRenameCommit(template.name); // cancel = restore original name
    }
  }

  function handleRenameBlur(e: React.FocusEvent<HTMLInputElement>) {
    onRenameCommit(e.currentTarget.value);
  }

  return (
    <div
      className={cn(
        'bg-card border border-border rounded-lg p-[13px_14px] transition-colors',
        isActive && 'border-primary/40',
      )}
    >
      {/* Header row: name + Active badge */}
      <div className="flex items-center gap-2 mb-[9px]">
        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            defaultValue={template.name}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameBlur}
            className={cn(
              'flex-1 font-semibold text-[13px] px-2 py-[3px] rounded-sm',
              'bg-background border border-primary/40 text-foreground',
              'outline-none',
            )}
          />
        ) : (
          <span className="flex-1 font-semibold text-[13px] text-foreground truncate">
            {copy(template).name}
          </span>
        )}
        {isActive && (
          <span className="shrink-0 text-[10px] font-semibold text-primary bg-primary/15 border border-primary/40 px-[7px] py-[1px] rounded-sm">
            {tc('labels.active')}
          </span>
        )}
      </div>

      {/* Description (built-in presets explain they update over time) */}
      {copy(template).description && (
        <p className="text-xs text-muted-foreground mb-2 leading-relaxed">
          {copy(template).description}
        </p>
      )}

      {/* Summary rows */}
      <div className="flex flex-col gap-0.5 mb-1">
        {/* Agent row */}
        <div className="flex justify-between gap-2 text-xs py-[2px]">
          <span className="text-muted-foreground">{t('agent')}</span>
          <span
            className={cn(
              'font-medium text-right',
              !agentConnected ? 'text-amber-400' : 'text-muted-foreground',
            )}
          >
            {slotLabel(t, assignment.agent)}
            {!agentConnected && (
              <span className="ml-1 inline-flex items-center gap-1">
                <AlertTriangle className="inline h-[10px] w-[10px] text-amber-400" />
                <span className="text-amber-400">{t('needsProvider', { provider: providerName(assignment.agent.provider) })}</span>
              </span>
            )}
          </span>
        </div>

        {/* Image gen row */}
        <div className="flex justify-between gap-2 text-xs py-[2px]">
          <span className="text-muted-foreground">{tc('labels.imageGen')}</span>
          <span className="text-muted-foreground font-medium text-right">
            {slotLabel(t, assignment.imageGen)}
          </span>
        </div>

        {/* Voice in row */}
        <div className="flex justify-between gap-2 text-xs py-[2px]">
          <span className="text-muted-foreground">{tc('labels.voiceIn')}</span>
          <span className="text-muted-foreground font-medium text-right">
            {assignment.voiceInput === null ? t('slotOff') : slotLabel(t, assignment.voiceInput)}
          </span>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-[6px] mt-[10px] pt-[10px] border-t border-border">
        <button
          type="button"
          disabled={isActive}
          onClick={onApply}
          className={cn(
            'px-[9px] py-[5px] rounded-md text-xs font-medium transition-colors border cursor-pointer',
            isActive
              ? 'bg-primary/15 border-primary/40 text-primary opacity-60 cursor-not-allowed'
              : 'bg-card border-border text-foreground hover:bg-muted hover:border-muted-foreground/30',
          )}
        >
          {isActive ? t('applied') : t('apply')}
        </button>

        {!template.builtin && (
          <button
            type="button"
            onClick={onRenameStart}
            className={cn(
              'px-[9px] py-[5px] rounded-md text-xs font-medium transition-colors border cursor-pointer',
              'bg-transparent border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {tc('actions.rename')}
          </button>
        )}

        <button
          type="button"
          onClick={onDuplicate}
          className={cn(
            'px-[9px] py-[5px] rounded-md text-xs font-medium transition-colors border cursor-pointer',
            'bg-transparent border-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {tc('actions.duplicate')}
        </button>

        {/* Delete: hidden for builtin, and disabled when it would leave zero templates or delete the last/active one */}
        {!template.builtin && (
          <button
            type="button"
            disabled={!canDelete}
            onClick={onDelete}
            className={cn(
              'px-[9px] py-[5px] rounded-md text-xs font-medium transition-colors border cursor-pointer',
              canDelete
                ? 'bg-transparent border-transparent text-muted-foreground hover:bg-destructive/10 hover:border-destructive/30 hover:text-destructive'
                : 'bg-transparent border-transparent text-muted-foreground/50 cursor-not-allowed',
            )}
          >
            {tc('actions.delete')}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TemplatesPane
// ---------------------------------------------------------------------------

export function TemplatesPane() {
  const t = useTranslations('connections');
  // version counter to force re-render after any mutation
  const [version, setVersion] = useState(0);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // Read current state on every render (version gates re-reads)
  const templates = configManager.getModelTemplates();
  const activeId = configManager.getDefaultTemplateId();

  // Sorted: builtin first, then alphabetical
  const sortedTemplates = Object.values(templates).sort((a, b) => {
    if (a.builtin && !b.builtin) return -1;
    if (!a.builtin && b.builtin) return 1;
    return a.name.localeCompare(b.name);
  });

  function handleApply(id: string) {
    const before = configManager.getActiveAssignment();
    configManager.setDefaultTemplateId(id);
    trackAgentProviderChange(before, configManager.getActiveAssignment());
    refresh();
  }

  function handleRenameStart(id: string) {
    setRenamingId(id);
  }

  function handleRenameCommit(template: ModelTemplate, newName: string) {
    const trimmed = newName.trim();
    if (trimmed && trimmed !== template.name) {
      configManager.saveModelTemplate({ ...template, name: trimmed });
    }
    setRenamingId(null);
    refresh();
  }

  function handleDuplicate(src: ModelTemplate) {
    const clone: ModelTemplate = {
      id: `t${Date.now()}`,
      name: `${src.name} copy`,
      builtin: false,
      assignment: structuredClone(src.assignment),
    };
    configManager.saveModelTemplate(clone);
    track('model_template_created');
    refresh();
  }

  async function handleDelete(id: string) {
    try {
      await configManager.deleteModelTemplate(id);
    } catch (error) {
      toast.error(error instanceof ServerDeleteRefused ? error.message : t('deleteTemplateFailed'));
      return;
    }
    track('model_template_deleted');

    // If we deleted the active template, fall back to any remaining template
    if (id === activeId) {
      const remaining = Object.keys(configManager.getModelTemplates());
      if (remaining.length > 0) {
        configManager.setDefaultTemplateId(remaining[0]);
      }
    }

    refresh();
  }

  if (sortedTemplates.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-6">
        {t('noSavedTemplates')}
      </div>
    );
  }

  return (
    <div className="pb-8">
      {/* Section header */}
      <div className="mb-[14px]">
        <div className="flex items-baseline gap-[10px] mb-1">
          <span className="text-xs font-semibold tracking-[0.09em] uppercase text-muted-foreground">
            {t('savedTemplates')}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('savedTemplatesHint')}
        </p>
      </div>

      {/* Template grid */}
      <div
        className="grid gap-[11px]"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(224px, 1fr))' }}
      >
        {sortedTemplates.map((t) => {
          // A non-builtin template can be deleted when deleting it would not leave
          // zero total templates. Builtin templates are always excluded from deletion
          // via the UI (Delete button is hidden). For non-builtins, allow delete
          // whenever at least one other template (builtin OR non-builtin) will remain.
          const totalAfterDelete = sortedTemplates.length - 1;
          const canDelete = !t.builtin && totalAfterDelete > 0;

          return (
            <TemplateCard
              key={`${t.id}-${version}`}
              template={t}
              isActive={t.id === activeId}
              isRenaming={renamingId === t.id}
              onApply={() => handleApply(t.id)}
              onRenameStart={() => handleRenameStart(t.id)}
              onRenameCommit={(name) => handleRenameCommit(t, name)}
              onDuplicate={() => handleDuplicate(t)}
              onDelete={() => handleDelete(t.id)}
              canDelete={canDelete}
            />
          );
        })}
      </div>
    </div>
  );
}
