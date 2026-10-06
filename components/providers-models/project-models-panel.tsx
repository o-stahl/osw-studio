'use client';

import React, { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { isFreeModels } from '@/lib/llm/suggestions/free-models';
import { useModelTemplateCopy } from '@/lib/i18n/use-model-template-copy';
import { Image as ImageIcon, Mic, Brain, ChevronRight, ChevronDown, Lock, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { configManager } from '@/lib/config/storage';
import { trackAgentProviderChange } from '@/lib/telemetry/provider-selection';
import type { ModelRef, ModelAssignment } from '@/lib/llm/models/assignment';
import { getActiveTemplate, resolveActiveAssignment } from '@/lib/llm/models/template-store';
import { loadProviderModels } from '@/lib/llm/models/model-catalog';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { ModelPicker } from './model-picker';
import type { ModelPickValue } from './model-picker';
import { modelRefLabel } from './format';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DrawerSlot = 'agent' | 'imageGen' | 'voiceInput';

interface ProjectModelsPanelProps {
  onManageSettings: () => void;
  /** When set (mobile dialog), the panel renders a footer "Done" row. */
  onDone?: () => void;
}

// ---------------------------------------------------------------------------
// Hook: enrich a ModelRef with a friendly display name (best-effort async)
// ---------------------------------------------------------------------------

function useEnrichedName(ref: ModelRef | null): string {
  const tm = useTranslations('models');
  const [name, setName] = useState<string>(() => (ref ? modelRefLabel(ref) : ''));

  useEffect(() => {
    if (!ref) { setName(''); return; }
    // Immediately show the short id while we wait
    setName(modelRefLabel(ref));
    let cancelled = false;
    loadProviderModels(ref.provider).then((models) => {
      if (cancelled) return;
      const found = models.find((m) => m.id === ref.model);
      if (found) setName(found.name);
    }).catch(() => { /* best-effort */ });
    return () => { cancelled = true; };
  }, [ref?.provider, ref?.model]); // eslint-disable-line react-hooks/exhaustive-deps

  return ref && isFreeModels(ref.model) ? tm('freeModels') : name;
}

// ---------------------------------------------------------------------------
// Model display value for a row (agent / imageGen / voiceInput)
// ---------------------------------------------------------------------------

interface SlotValueDisplayProps {
  slot: DrawerSlot;
  value: ModelRef | 'agent' | 'browser' | null;
  agentRef: ModelRef;
}

function SlotValueDisplay({ slot, value, agentRef }: SlotValueDisplayProps) {
  // Above the early return below, so the hook order never changes between renders.
  const tm = useTranslations('models');
  // For agent slot the value is always a ModelRef
  const directRef: ModelRef | null =
    slot === 'agent'
      ? (value as ModelRef)
      : value !== null && value !== 'agent' && value !== 'browser'
        ? (value as ModelRef)
        : null;

  const enrichedName = useEnrichedName(directRef);
  const agentEnrichedName = useEnrichedName(
    slot !== 'agent' && value === 'agent' ? agentRef : null,
  );

  if (slot === 'agent') {
    const ref = value as ModelRef;
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-sm tracking-[-0.01em] text-foreground">
          {enrichedName || modelRefLabel(ref)}
        </span>
        <span className="text-xs font-mono text-muted-foreground">{ref.provider}</span>
      </div>
    );
  }

  if (value === null) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span className="w-[7px] h-[7px] rounded-full bg-muted-foreground/40 flex-shrink-0" />
        {slot === 'voiceInput' ? tm('offNoMic') : tm('off')}
      </div>
    );
  }

  if (value === 'agent') {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-sm tracking-[-0.01em] text-foreground">
          {agentEnrichedName || modelRefLabel(agentRef)}
        </span>
        <span className="text-xs text-muted-foreground">— same as agent</span>
      </div>
    );
  }

  if (value === 'browser') {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold text-sm tracking-[-0.01em] text-foreground">
          {tm('browserOnDevice')}
        </span>
      </div>
    );
  }

  // Regular ModelRef
  const ref = value as ModelRef;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="font-semibold text-sm tracking-[-0.01em] text-foreground">
        {enrichedName || modelRefLabel(ref)}
      </span>
      <span className="text-xs font-mono text-muted-foreground">{ref.provider}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline collapsible section
// ---------------------------------------------------------------------------

interface SectionProps {
  icon: React.ReactNode;
  label: string;
  expanded: boolean;
  onToggle: () => void;
  slot: DrawerSlot;
  value: ModelRef | 'agent' | 'browser' | null;
  agentRef: ModelRef;
  pickerValue: ModelPickValue;
  onPick: (v: ModelPickValue) => void;
}

function Section({
  icon,
  label,
  expanded,
  onToggle,
  slot,
  value,
  agentRef,
  pickerValue,
  onPick,
}: SectionProps) {
  return (
    <div className="rounded-lg border border-border bg-muted">
      {/* Clickable header */}
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          // Padding is constant in both states so toggling doesn't shift the header;
          // the bottom divider only appears when the picker is shown below.
          'w-full flex items-center gap-3 px-[10px] py-2 text-left cursor-pointer',
          expanded && 'border-b border-border',
        )}
      >
        <div className="flex-1 min-w-0">
          {/* Label row */}
          <div className="flex items-center gap-[7px]">
            <span className="text-[10px] font-semibold tracking-[0.07em] uppercase text-muted-foreground flex items-center gap-[5px]">
              <span className="text-muted-foreground">{icon}</span>
              {label}
            </span>
          </div>
          {/* Current model value */}
          <SlotValueDisplay slot={slot} value={value} agentRef={agentRef} />
        </div>
        <ChevronDown
          size={18}
          className={cn(
            'flex-shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {/* Inline picker — rendered only when expanded */}
      {expanded && (
        <ModelPicker
          slot={slot}
          currentValue={pickerValue}
          onPick={onPick}
          inline
          agentRef={agentRef}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function ProjectModelsPanel({ onManageSettings, onDone }: ProjectModelsPanelProps) {
  const tc = useTranslations('common');
  const tm = useTranslations('models');
  const copy = useModelTemplateCopy();
  const tcn = useTranslations('connections');
  const tt = useTranslations('tooltips');
  // Re-resolve whenever the global model config changes. The root-mounted useModelConfigSignal
  // listens to the `modelConfigChanged` window event (dispatched by configManager writes) and
  // bumps this counter, which re-renders this panel so the display stays in sync.
  useWorkspaceStore(s => s.modelConfigVersion);

  // ---- Resolve the active TEMPLATE (name, builtin flag, saved assignment for the
  // dirty diff) and the WORKING selection (what's actually effective right now). ----
  // getActiveTemplate() self-heals: it runs migrateModels() when the active id is
  // missing, so the "Default" template is always seeded before we read it.
  const active = getActiveTemplate();
  // The displayed per-slot values reflect the WORKING selection, not the template's
  // saved assignment. resolveActiveAssignment() returns the persisted working selection
  // (or the active template's assignment when unset). Both recompute on modelConfigVersion.
  const working = resolveActiveAssignment();
  const effective = working;

  const isBuiltin = !!active.builtin;
  // Working selection differs from the loaded template's saved assignment.
  const isDirty = JSON.stringify(working) !== JSON.stringify(active.assignment);

  // ---- Templates list for the selector ----
  const templates = configManager.getModelTemplates();
  const sortedTemplates = Object.values(templates).sort((a, b) => {
    if (a.builtin && !b.builtin) return -1;
    if (!a.builtin && b.builtin) return 1;
    return a.name.localeCompare(b.name);
  });

  // ---- Accordion: at most one section open (agent by default; all may be closed) ----
  const [openSlot, setOpenSlot] = useState<DrawerSlot | null>('agent');
  const toggleSlot = (s: DrawerSlot) => setOpenSlot((prev) => (prev === s ? null : s));

  // ---- Template selector: switch the global active template ----
  // setDefaultTemplateId also loads the template's assignment into the working
  // selection (WT1), so switching clears dirty and re-renders via the dispatch.
  function handleTemplateSelect(id: string) {
    const before = configManager.getActiveAssignment();
    configManager.setDefaultTemplateId(id);
    trackAgentProviderChange(before, configManager.getActiveAssignment());
  }

  // Apply a slot edit to the WORKING selection. Immediate, global and reactive
  // (the dispatch bumps modelConfigVersion). This does NOT touch any template and
  // does NOT fork built-ins. The working selection simply diverges until the user
  // Saves it into the loaded template or Resets it back.
  function writeSlot(mutate: (a: ModelAssignment) => ModelAssignment) {
    const before = configManager.getActiveAssignment();
    const after = mutate(before);
    configManager.setActiveAssignment(after);
    trackAgentProviderChange(before, after);
  }

  // Persist the working selection into the loaded (editable) template. Built-ins are
  // read-only, and there's nothing to save when the working selection matches.
  function handleSave() {
    if (isBuiltin || !isDirty) return;
    configManager.saveModelTemplate({ ...active, assignment: working });
  }

  // Revert the working selection back to the loaded template's saved assignment.
  function handleReset() {
    configManager.setActiveAssignment(active.assignment);
  }

  // ---- Picker onPick (takes slot explicitly) ----
  function handlePick(slot: DrawerSlot, value: ModelPickValue) {
    if (slot === 'agent') {
      if (value && typeof value === 'object') {
        const ref = value;
        writeSlot((a) => ({ ...a, agent: ref }));
      }
    } else if (slot === 'imageGen') {
      const v = value === 'browser' ? null : (value as ModelAssignment['imageGen']);
      writeSlot((a) => ({ ...a, imageGen: v }));
    } else if (slot === 'voiceInput') {
      const v = value as ModelAssignment['voiceInput'];
      writeSlot((a) => ({ ...a, voiceInput: v }));
    }
  }

  // ---- Per-slot picker current value ----
  function pickerCurrentValue(slot: DrawerSlot): ModelPickValue {
    if (slot === 'agent') return effective.agent;
    if (slot === 'imageGen') return effective.imageGen;
    if (slot === 'voiceInput') return effective.voiceInput;
    return null;
  }

  return (
    <div className="flex flex-col min-h-0">
      {/* ---- Header: label + template selector + save/reset ---- */}
      <div className="flex-shrink-0 p-3 border-b border-border">
        <div className="flex items-center gap-2.5">
          <p className="text-xs font-semibold tracking-[0.08em] uppercase text-muted-foreground shrink-0">
            {tc('terms.models')}
          </p>
          <Select value={active.id} onValueChange={handleTemplateSelect}>
            <SelectTrigger size="sm" className="rounded-full gap-1.5 text-[13px] font-medium text-foreground min-w-0 max-w-[220px]">
              {/* SelectValue mirrors the selected option's content (incl. its lock for built-ins),
                  so the trigger must not render its own lock or it shows twice. */}
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sortedTemplates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  <span className="flex items-center gap-1.5">
                    {t.builtin && <Lock size={12} className="text-muted-foreground shrink-0" />}
                    {copy(t).name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex-1" />

          {/* Reset: revert working selection to the loaded template. */}
          {isDirty && (
            <button
              type="button"
              onClick={handleReset}
              className={cn(
                'flex items-center gap-1 text-[11px] font-medium shrink-0',
                'text-muted-foreground hover:text-foreground',
                'bg-transparent border-none cursor-pointer transition-colors',
              )}
            >
              <RotateCcw size={12} strokeWidth={2} />
              {tc('actions.reset')}
            </button>
          )}

          {/* Save: persist working selection into the loaded template. Disabled with a
              tooltip for built-ins (read-only) and when there's nothing to save. */}
          {isBuiltin ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="shrink-0" tabIndex={0}>
                  <Button variant="default" size="sm" disabled className="h-7 text-xs pointer-events-none">
                    {tc('actions.save')}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">
                {tt('builtInTemplatesLocked')}
              </TooltipContent>
            </Tooltip>
          ) : (
            <Button
              variant="default"
              size="sm"
              disabled={!isDirty}
              onClick={handleSave}
              className="h-7 text-xs shrink-0"
            >
              {tc('actions.save')}
            </Button>
          )}
        </div>
      </div>

      {/* ---- Body: inline collapsible sections ---- */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        <div className="space-y-2">
          <Section
            icon={<Brain size={11} strokeWidth={2} />}
            label={tcn('agent')}
            expanded={openSlot === 'agent'}
            onToggle={() => toggleSlot('agent')}
            slot="agent"
            value={effective.agent}
            agentRef={effective.agent}
            pickerValue={pickerCurrentValue('agent')}
            onPick={(v) => handlePick('agent', v)}
          />
          <Section
            icon={<ImageIcon size={11} strokeWidth={2} />}
            label={tc('labels.imageGeneration')}
            expanded={openSlot === 'imageGen'}
            onToggle={() => toggleSlot('imageGen')}
            slot="imageGen"
            value={effective.imageGen}
            agentRef={effective.agent}
            pickerValue={pickerCurrentValue('imageGen')}
            onPick={(v) => handlePick('imageGen', v)}
          />
          <Section
            icon={<Mic size={11} strokeWidth={2} />}
            label={tc('labels.voiceInput')}
            expanded={openSlot === 'voiceInput'}
            onToggle={() => toggleSlot('voiceInput')}
            slot="voiceInput"
            value={effective.voiceInput}
            agentRef={effective.agent}
            pickerValue={pickerCurrentValue('voiceInput')}
            onPick={(v) => handlePick('voiceInput', v)}
          />
        </div>
      </div>

      {/* ---- Footer ---- */}
      <div className="flex-shrink-0 border-t border-border px-[18px] py-[10px] space-y-[6px]">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {tm.rich('appliesToAll', { b: (chunks) => <strong className="text-muted-foreground font-semibold">{chunks}</strong> })}
        </p>
        <button
          type="button"
          onClick={onManageSettings}
          className={cn(
            'inline-flex items-center gap-[6px]',
            'text-xs font-medium text-foreground',
            'bg-transparent border-none cursor-pointer transition-colors',
            'hover:text-primary',
          )}
        >
          {tm('manageProvidersTemplates')}
          <ChevronRight size={13} strokeWidth={2} />
        </button>

        {/* Mobile action row: Done */}
        {onDone && (
          <div className="flex items-center gap-2 pt-1.5">
            <Button variant="default" size="sm" className="flex-1" onClick={onDone}>
              {tc('actions.done')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
