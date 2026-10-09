'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { isFreeModels } from '@/lib/llm/suggestions/free-models';
import { Search, Loader2, Link, MonitorSpeaker, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { configManager } from '@/lib/config/storage';
import { getProvider, getProviderArchetype } from '@/lib/llm/providers/registry';
import { getConnectedProviders } from '@/lib/llm/providers/connection-status';
import { modelsForSlot, matchesSlot, loadProviderModels, SlotModelEntry, SlotKind } from '@/lib/llm/models/model-catalog';
import { fmtCtx, fmtPrice } from './format';
import { formatModelPrice } from '@/lib/llm/models-api';
import type { ModelRef } from '@/lib/llm/models/assignment';
import type { ProviderId, ProviderModel } from '@/lib/llm/providers/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ModelPickValue = ModelRef | 'agent' | 'browser' | null;

export interface ModelPickerProps {
  slot: SlotKind;
  currentValue: ModelPickValue;
  onPick: (value: ModelPickValue) => void;
  inline?: boolean;
  /** The project's agent model — used to decide whether "reuse agent" is offered. */
  agentRef?: ModelRef;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get a short vendor label from the provider ID or model ID. */
function vendorLabel(provider: ProviderId, modelId: string): string {
  // For aggregator routes, derive from model id prefix
  if (provider === 'openrouter') {
    const parts = modelId.split('/');
    if (parts.length >= 2) return parts[0];
  }
  const map: Partial<Record<ProviderId, string>> = {
    openai: 'OpenAI',
    'openai-codex': 'Codex',
    anthropic: 'Anthropic',
    groq: 'Groq',
    gemini: 'Google',
    huggingface: 'HuggingFace',
    ollama: 'Ollama',
    lmstudio: 'LM Studio',
    sambanova: 'SambaNova',
    zhipu: 'Zhipu',
    minimax: 'MiniMax',
    llamacpp: 'llama.cpp',
    meshllm: 'MeshLLM',
    pollinations: 'Pollinations',
    vercel: 'Vercel',
  };
  if (map[provider]) return map[provider] as string;
  // Custom providers: use the configured name.
  try {
    return getProvider(provider).name;
  } catch {
    return provider;
  }
}

/** Text colour for the vendor column (no badge background). */
function vendorTextColor(provider: ProviderId, modelId: string): string {
  const lc = modelId.toLowerCase();
  if (provider === 'anthropic' || lc.includes('claude')) return 'text-orange-400';
  if (provider === 'openai' || lc.includes('gpt')) return 'text-green-400';
  if (provider === 'gemini' || lc.includes('gemini')) return 'text-teal-400';
  if (lc.includes('deepseek')) return 'text-violet-400';
  if (lc.includes('qwen')) return 'text-blue-400';
  if (provider === 'groq') return 'text-amber-400';
  return 'text-muted-foreground';
}

/** Strip a redundant "Vendor: " prefix from a model name when it matches the
 *  vendor shown in its own column (e.g. "Anthropic: Claude…" → "Claude…"). */
function stripVendorPrefix(name: string, vendor: string): string {
  const idx = name.indexOf(': ');
  if (idx <= 0) return name;
  const norm = (s: string) => s.toLowerCase().replace(/[\s.]/g, '');
  return norm(name.slice(0, idx)) === norm(vendor) ? name.slice(idx + 2) : name;
}

/** True when the model's vendor differs from its serving connection (e.g. an
 *  "anthropic/…" model on OpenRouter). Direct providers name their own vendor,
 *  so there's no separate developer to show. */
function isDistinctVendor(provider: ProviderId, model: ProviderModel): boolean {
  // Custom providers are their own vendor.
  if (getProviderArchetype(provider) === 'custom') return false;
  return getProvider(provider).name.toLowerCase() !== vendorLabel(provider, model.id).toLowerCase();
}

/** True if the ModelPickValue matches a SlotModelEntry. */
function entrySelected(entry: SlotModelEntry, current: ModelPickValue): boolean {
  if (!current || typeof current !== 'object') return false;
  return current.provider === entry.provider && current.model === entry.model.id;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** A sticky-headed group in the model list (a connection, or "Quick options").
 *  When collapsible, the header toggles the group's rows. */
function ListGroup({
  label,
  count,
  collapsible,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  count?: number;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  const t = useTranslations('models');
  const headerClass = 'sticky top-0 z-10 flex items-center justify-between px-2 py-1 bg-muted border-b border-border w-full text-left';
  const headerInner = (
    <>
      <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        {collapsible && (
          collapsed
            ? <ChevronRight size={11} className="shrink-0" />
            : <ChevronDown size={11} className="shrink-0" />
        )}
        {label}
      </span>
      {count !== undefined && (
        <span className="text-[10px] text-muted-foreground tabular-nums">{t('modelCount', { count })}</span>
      )}
    </>
  );
  return (
    <div>
      {collapsible ? (
        <button type="button" onClick={onToggle} className={cn(headerClass, 'cursor-pointer hover:bg-muted/80 transition-colors')}>
          {headerInner}
        </button>
      ) : (
        <div className={headerClass}>{headerInner}</div>
      )}
      {!collapsed && <div className="flex flex-col gap-0.5 py-0.5">{children}</div>}
    </div>
  );
}

interface QuickRowProps {
  selected: boolean;
  icon: React.ReactNode;
  label: React.ReactNode;
  meta: string;
  onClick: () => void;
  disabled?: boolean;
}
function QuickRow({ selected, icon, label, meta, onClick, disabled }: QuickRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'w-full flex items-center gap-2.5 px-2 py-1 text-left border',
        'transition-colors duration-100',
        disabled
          ? 'opacity-40 cursor-not-allowed bg-popover border-transparent'
          : selected
          ? 'bg-primary/15 border-primary/40 cursor-pointer'
          : 'bg-popover border-transparent hover:bg-accent cursor-pointer',
      )}
    >
      <span className="shrink-0 flex items-center text-muted-foreground">{icon}</span>
      <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-foreground">{label}</span>
      {meta && (
        <span className="shrink-0 max-w-[180px] truncate text-xs text-muted-foreground">{meta}</span>
      )}
    </button>
  );
}

interface ModelRowProps {
  entry: SlotModelEntry;
  selected: boolean;
  /** The group reserves a developer column (so it stays aligned and doesn't jump). */
  showDeveloper: boolean;
  onClick: () => void;
}
function ModelRow({ entry: { provider, model }, selected, showDeveloper, onClick }: ModelRowProps) {
  const tm = useTranslations('models');
  // "Free models" is a selection, not a model: no size or price of its own, and its developer is
  // whichever free model it lands on, so the column says it varies rather than staying blank.
  const rotating = isFreeModels(model.id);
  const ctx = rotating ? '' : fmtCtx(model.contextLength);
  const price = rotating ? '' : fmtPrice(tm, model, formatModelPrice);
  const vendor = vendorLabel(provider, model.id);
  const distinct = !rotating && isDistinctVendor(provider, model);
  const name = rotating ? tm('freeModels') : distinct ? stripVendorPrefix(model.name, vendor) : model.name;
  const meta = rotating ? tm('freeModelsDesc') : [ctx, price].filter(Boolean).join(' · ');

  const developerColor = distinct
    ? vendorTextColor(provider, model.id)
    : 'text-muted-foreground/50';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left cursor-pointer border px-2 py-1.5 md:py-1',
        'transition-colors duration-100',
        selected
          ? 'bg-primary/15 border-primary/40'
          : 'bg-popover border-transparent hover:bg-accent',
      )}
    >
      {/* Mobile: stacked — model name on its own line, metadata below it */}
      <div className="flex flex-col gap-0.5 min-w-0 md:hidden">
        <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
        <span className="flex items-center gap-2 min-w-0 text-xs text-muted-foreground">
          {showDeveloper && (distinct || rotating) && (
            <span className={cn('min-w-0 truncate', developerColor)}>{rotating ? tm('freeModelsDeveloper') : vendor}</span>
          )}
          {meta && <span className="shrink-0 tabular-nums whitespace-nowrap">{meta}</span>}
        </span>
      </div>

      {/* Desktop: single-row table — developer | name | modality | ctx·price */}
      <div className="hidden md:flex md:items-center md:gap-2.5">
        {showDeveloper && (
          <span className={cn('w-[64px] shrink-0 truncate text-xs', developerColor)}>
            {rotating ? tm('freeModelsDeveloper') : distinct ? vendor : ''}
          </span>
        )}
        <span className={cn('min-w-0 truncate text-[13px] font-medium text-foreground', rotating ? 'shrink-0' : 'flex-1')}>
          {name}
        </span>
        {/* "Free models" carries a sentence, not figures: it gives way to the name. */}
        {meta && (
          <span className={cn('text-xs text-muted-foreground whitespace-nowrap', rotating ? 'flex-1 min-w-0 truncate text-right' : 'shrink-0 tabular-nums')}>
            {meta}
          </span>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Body component for the "pick" mode of the drawer.
 *
 * - Loads models via modelsForSlot using connected providers
 * - Search filters by model name or vendor label
 * - "Show all models" toggle bypasses modality filtering
 * - Quick options section (imageGen: reuse agent / off; voiceInput: browser / off)
 * - Model rows with name, vendor tag, context + price meta
 */
export function ModelPicker({ slot, currentValue, onPick, inline = false, agentRef }: ModelPickerProps) {
  const t = useTranslations('models');
  const [entries, setEntries] = useState<SlotModelEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');

  // Collapsed provider groups, persisted across sessions. An active search
  // overrides collapse so matches are never hidden.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(configManager.getCollapsedModelGroups()),
  );
  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      const willCollapse = !next.has(groupId);
      if (willCollapse) next.add(groupId); else next.delete(groupId);
      configManager.setModelGroupCollapsed(groupId, willCollapse);
      return next;
    });
  }, []);

  // Whether the agent model can serve this slot (drives the "reuse agent" option).
  // Only meaningful for imageGen/voiceInput. Defaults to false until resolved so
  // we never briefly offer reuse for a model that can't support it.
  const [agentCanReuse, setAgentCanReuse] = useState(false);
  useEffect(() => {
    if (!agentRef || slot === 'agent') { setAgentCanReuse(false); return; }
    let cancelled = false;
    loadProviderModels(agentRef.provider).then((models) => {
      if (cancelled) return;
      const found = models.find((m) => m.id === agentRef.model);
      setAgentCanReuse(!!found && matchesSlot(slot, found));
    }).catch(() => { if (!cancelled) setAgentCanReuse(false); });
    return () => { cancelled = true; };
  }, [slot, agentRef?.provider, agentRef?.model]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load models — re-fires when showAll toggles
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const connected = getConnectedProviders();
      const results = await modelsForSlot(slot, connected, { all: showAll });
      setEntries(results);
    } finally {
      setLoading(false);
    }
  }, [slot, showAll]);

  useEffect(() => {
    load();
  }, [load]);

  // Filter by search query
  const filtered = useMemo(() => {
    if (!query.trim()) return entries;
    const q = query.toLowerCase();
    return entries.filter((e) => {
      const name = e.model.name.toLowerCase();
      const id = e.model.id.toLowerCase();
      const vendor = vendorLabel(e.provider, e.model.id).toLowerCase();
      return name.includes(q) || id.includes(q) || vendor.includes(q);
    });
  }, [entries, query]);

  // Group consecutive entries by provider/connection (the catalog already
  // returns each provider's models contiguously). Drives the sticky headers.
  const groups = useMemo(() => {
    const out: { provider: ProviderId; entries: SlotModelEntry[] }[] = [];
    for (const e of filtered) {
      const last = out[out.length - 1];
      if (last && last.provider === e.provider) last.entries.push(e);
      else out.push({ provider: e.provider, entries: [e] });
    }
    return out;
  }, [filtered]);

  // Quick options for imageGen / voiceInput slots
  const hasQuickOptions = slot === 'imageGen' || slot === 'voiceInput';

  const handleToggleShowAll = () => setShowAll((v) => !v);

  return (
    <div className={cn(inline ? 'px-0 h-[240px] flex flex-col' : 'px-[18px] pb-[18px]')}>
      {/* Search box */}
      <div className={cn('relative shrink-0', inline ? 'mb-1.5' : 'mt-4')}>
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
        />
        <input
          type="text"
          placeholder={t('searchModels')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={cn(
            'w-full pl-[38px] pr-3 py-[11px]',
            // Boxed input (full border) so the focus ring shows on all sides.
            inline ? 'bg-popover border border-border rounded-md' : 'bg-transparent border border-border rounded-md',
            'text-sm text-foreground placeholder:text-muted-foreground',
            'outline-none focus:border-ring',
            'transition-colors',
          )}
        />
      </div>

      {/* List — fixed-height scroll area so every accordion section is the same
          height. Quick options ride along as the first sticky group. */}
      <div className={cn(inline ? 'flex-1 min-h-0 overflow-y-auto' : 'mt-2')}>
        {loading ? (
          <div className="py-8 flex items-center justify-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            {t('loadingModels')}
          </div>
        ) : (
          <>
            {hasQuickOptions && (
              <ListGroup label={t('quickOptions')}>
                {slot === 'imageGen' && (
                  <QuickRow
                    selected={currentValue === 'agent'}
                    icon={<Link size={13} strokeWidth={2} />}
                    label={t('reuseAgentModel')}
                    meta={t('usesAgentModel')}
                    onClick={() => onPick('agent')}
                    disabled={!agentCanReuse}
                  />
                )}
                {slot === 'voiceInput' && (
                  <>
                    <QuickRow
                      selected={currentValue === 'agent'}
                      icon={<Link size={13} strokeWidth={2} />}
                      label={t('reuseAgentModel')}
                      meta={t('sendsRecordingAsAudio')}
                      onClick={() => onPick('agent')}
                      disabled={!agentCanReuse}
                    />
                    <QuickRow
                      selected={currentValue === 'browser'}
                      icon={<MonitorSpeaker size={13} strokeWidth={2} />}
                      label={t('browserOnDevice')}
                      meta={t('browserVoiceMeta')}
                      onClick={() => onPick('browser')}
                    />
                  </>
                )}
                <QuickRow
                  selected={currentValue === null}
                  icon={
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M8 12h8" />
                    </svg>
                  }
                  label={t('off')}
                  meta={slot === 'imageGen' ? t('disableImageGen') : t('turnOffVoice')}
                  onClick={() => onPick(null)}
                />
              </ListGroup>
            )}

            {groups.map((g) => {
              // Reserve the developer column for the whole group only when this
              // connection supplies vendor info (aggregators like OpenRouter).
              const showDeveloper = g.entries.some((e) => isDistinctVendor(e.provider, e.model));
              return (
                <ListGroup
                  key={g.provider}
                  label={getProvider(g.provider).name}
                  count={g.entries.length}
                  collapsible
                  collapsed={!query.trim() && collapsedGroups.has(g.provider)}
                  onToggle={() => toggleGroup(g.provider)}
                >
                  {g.entries.map((entry) => (
                    <ModelRow
                      key={`${entry.provider}::${entry.model.id}`}
                      entry={entry}
                      selected={entrySelected(entry, currentValue)}
                      showDeveloper={showDeveloper}
                      onClick={() => onPick({ provider: entry.provider, model: entry.model.id })}
                    />
                  ))}
                </ListGroup>
              );
            })}

            {groups.length === 0 && !hasQuickOptions && (
              <div className="py-8 text-center text-[13px] text-muted-foreground px-4">
                {query
                  ? t('noModelsMatch')
                  : t('noModelsFitSlot')}
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer: count + show all toggle. In the inline card it gets a top
          border so it reads as the section's footer; the drawer keeps a margin. */}
      <div
        className={cn(
          'flex items-center justify-between text-xs text-muted-foreground',
          inline ? 'shrink-0 p-2 border-t border-border' : 'mt-3',
        )}
      >
        {loading ? (
          <span className="flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" />
            {t('loadingEllipsis')}
          </span>
        ) : (
          <span>
            {t('modelsFitSlot', { count: filtered.length, showAll: showAll ? 'yes' : 'no' })}
          </span>
        )}

        <button
          type="button"
          onClick={handleToggleShowAll}
          className="flex items-center gap-2 cursor-pointer select-none"
        >
          {/* Mini toggle pill */}
          <span
            className={cn(
              'relative inline-flex items-center w-8 h-[19px] rounded-full border flex-shrink-0 transition-colors duration-150',
              showAll
                ? 'bg-primary border-primary'
                : 'bg-muted-foreground/30 border-border',
            )}
          >
            <span
              className={cn(
                'absolute block w-[13px] h-[13px] rounded-full transition-transform duration-150',
                showAll
                  ? 'translate-x-[17px] bg-white'
                  : 'translate-x-[2px] bg-muted-foreground',
              )}
            />
          </span>
          {t('showAllModels')}
        </button>
      </div>
    </div>
  );
}
