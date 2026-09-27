
import { ProviderId, ProviderConfig, ProviderModel, CodexAuthData, HFAuthData } from '@/lib/llm/providers/types';
import { getDefaultModel } from '@/lib/llm/providers/registry';
import {
  getCustomProviders,
  setCustomProviders,
  saveCustomProvider as saveCustomProviderConfig,
  removeCustomProvider as removeCustomProviderConfig,
  generateCustomProviderId as generateCustomProviderIdHelper,
  buildCustomProviderConfig as buildCustomProviderConfigHelper,
} from '@/lib/llm/providers/custom-providers';
import { UsageInfo } from '@/lib/llm/types';
import type { ModelTemplate, ModelAssignment } from '@/lib/llm/models/assignment';
import type { WebSearchProviderId } from '@/lib/web-search/types';
import { BUILT_IN_MODEL_TEMPLATES, isBuiltInTemplateId } from '@/lib/llm/models/registry';
import { logger } from '@/lib/utils';
import type { PermissionMode, GateDecision } from '@/lib/llm/permissions';

export interface SessionCost {
  sessionId: string;
  startTime: Date;
  totalCost: number;
  messageCount: number;
  providerBreakdown: Record<string, {
    cost: number;
    tokenUsage: {
      input: number;
      output: number;
    };
    requestCount: number;
  }>;
}

export interface CostSettings {
  showCosts?: boolean;
  dailyLimit?: number;
  projectLimit?: number;
  warningThreshold?: number;
}

interface ModelCacheEntry {
  models: ProviderModel[];
  timestamp: string;
  expiresAt: string;
}

export interface ProviderPricingEntry {
  input: number;
  output: number;
  reasoning?: number;
}

export interface AppSettings {
  openRouterApiKey?: string;
  defaultModel?: string;
  selectedProvider?: ProviderId;
  providerKeys?: Partial<Record<ProviderId, string>>;
  providerModels?: Partial<Record<ProviderId, string>>;
  theme?: 'light' | 'dark' | 'system';
  locale?: 'ko' | 'en';
  costSettings?: CostSettings;
  currentSession?: SessionCost;
  lifetimeCosts?: {
    total: number;
    byProvider: Record<string, number>;
    lastReset?: Date;
  };
  hasSeenAboutModal?: boolean;
  hasSeenGuidedTour?: boolean;
  /** When true, the large-file-write pacing notice is permanently dismissed. */
  pacingNoticeDismissed?: boolean;
  /** Per-listing table/grid choice, keyed by page id (projects, templates, skills…). */
  listViewModes?: Record<string, 'table' | 'grid'>;
  modelCache?: Partial<Record<ProviderId, ModelCacheEntry>>;
  modelPricing?: Partial<Record<ProviderId, Record<string, ProviderPricingEntry>>>;
  reasoningEnabled?: Record<string, boolean>;  // Per-model reasoning toggle (model ID -> enabled)
  /** Per-provider auto-compaction toggle. Default: true (enabled). */
  compactionEnabled?: Partial<Record<ProviderId, boolean>>;
  /** Per-provider compaction limit override (tokens). Empty = automatic. */
  compactionLimits?: Partial<Record<ProviderId, number>>;
  /** Context length (tokens) a local provider is loaded with. Empty = default. */
  localContextLengths?: Partial<Record<ProviderId, number>>;
  codexAuth?: CodexAuthData;
  hfAuth?: HFAuthData;
  telemetryOptIn?: boolean;
  /** When true, emit llm_request and stream_raw_chunk debug events (ephemeral, not persisted). */
  debugStreamEnabled?: boolean;
  modelTemplates?: Record<string, ModelTemplate>;
  defaultTemplateId?: string;
  /** Global working/effective model selection. Unset falls back to the active template's assignment. */
  activeAssignment?: ModelAssignment;
  permissionMode?: 'auto' | 'ask' | 'custom';
  permissionOverrides?: Record<string, 'ask' | 'allow'>;
  webSearch?: {
    provider?: WebSearchProviderId;
    keys?: Partial<Record<'tavily' | 'firecrawl' | 'brave', string>>;
    searxngUrl?: string;
  };
  /** Provider group ids collapsed in the model picker. */
  modelPickerCollapsed?: string[];
  /** Intent group ids collapsed in the template picker. */
  templatePickerCollapsed?: string[];
}

/**
 * Rehydrate a stored model template: dates round-trip through JSON as strings,
 * so convert them back to Date, and force builtin:false (only registry ids are
 * read-only built-ins).
 */
function hydrateDate(value: Date | string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return isNaN(d.getTime()) ? undefined : d;
}

function hydrateModelTemplate(t: ModelTemplate): ModelTemplate {
  return {
    ...t,
    builtin: false,
    updatedAt: hydrateDate(t.updatedAt),
    lastSyncedAt: hydrateDate(t.lastSyncedAt),
    serverUpdatedAt: hydrateDate(t.serverUpdatedAt),
  };
}

class ConfigManager {
  private readonly STORAGE_KEY = 'osw-studio-settings';

  getSettings(): AppSettings {
    if (typeof window === 'undefined') {
      return {};
    }
    const stored = localStorage.getItem(this.STORAGE_KEY);
    if (!stored) return {};
    
    const settings = JSON.parse(stored);
    
    if ('autoSave' in settings || 'autoSaveInterval' in settings) {
      delete settings.autoSave;
      delete settings.autoSaveInterval;
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settings));
    }
    
    return settings;
  }

  setSetting<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ): void {
    if (typeof window === 'undefined') {
      return;
    }
    const settings = this.getSettings();
    settings[key] = value;
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settings));
  }

  /** The saved table/grid choice for a listing page, or null when the user has not picked one. */
  getListViewMode(page: string): 'table' | 'grid' | null {
    return this.getSettings().listViewModes?.[page] ?? null;
  }

  setListViewMode(page: string, mode: 'table' | 'grid'): void {
    this.setSetting('listViewModes', { ...this.getSettings().listViewModes, [page]: mode });
  }

  hasSeenTour(): boolean {
    return Boolean(this.getSettings().hasSeenGuidedTour);
  }

  setHasSeenTour(seen: boolean): void {
    this.setSetting('hasSeenGuidedTour', seen);
  }

  hasDismissedPacingNotice(): boolean {
    return this.getSettings().pacingNoticeDismissed === true;
  }

  setPacingNoticeDismissed(): void {
    this.setSetting('pacingNoticeDismissed', true);
  }

  getApiKey(): string | null {
    const provider = this.getSelectedProvider();
    if (provider) {
      return this.getProviderApiKey(provider);
    }
    return this.getSettings().openRouterApiKey || null;
  }

  setApiKey(key: string): void {
    const provider = this.getSelectedProvider();
    if (provider) {
      this.setProviderApiKey(provider, key);
    }
    this.setSetting('openRouterApiKey', key);
  }

  getDefaultModel(): string {
    const provider = this.getSelectedProvider();
    if (provider) {
      return this.getProviderModel(provider) || this.getProviderDefaultModel(provider);
    }
    return this.getSettings().defaultModel || 'deepseek/deepseek-chat';
  }

  setDefaultModel(model: string): void {
    const provider = this.getSelectedProvider();
    if (provider) {
      this.setProviderModel(provider, model);
    }
    this.setSetting('defaultModel', model);
  }

  getSelectedProvider(): ProviderId {
    return this.getSettings().selectedProvider
      || (process.env.NEXT_PUBLIC_DEFAULT_PROVIDER as ProviderId)
      || 'openrouter';
  }

  setSelectedProvider(provider: ProviderId): void {
    this.setSetting('selectedProvider', provider);
    this.emitModelConfigChanged();
  }

  getProviderApiKey(provider: ProviderId): string | null {
    // An expired HuggingFace sign-in is dropped here, at the one place every request path reads
    // the key, rather than sent to be refused. With the auth gone, Settings stops reading
    // "Connected" and the chat footer's sign-in button appears on its own.
    if (provider === 'huggingface' && this.isHFAuthExpired()) {
      this.clearHFAuth();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('apiKeyUpdated', { detail: { provider: 'huggingface', hasKey: false } }));
      }
      return null;
    }
    const settings = this.getSettings();
    if (settings.providerKeys?.[provider]) {
      return settings.providerKeys[provider];
    }
    if (provider === 'openrouter' && settings.openRouterApiKey) {
      return settings.openRouterApiKey;
    }
    return null;
  }

  setProviderApiKey(provider: ProviderId, key: string): void {
    const settings = this.getSettings();
    const providerKeys = settings.providerKeys || {};
    providerKeys[provider] = key;
    this.setSetting('providerKeys', providerKeys);
    
    if (provider === 'openrouter') {
      this.setSetting('openRouterApiKey', key);
    }
  }

  getProviderModel(provider: ProviderId): string | null {
    const settings = this.getSettings();
    if (settings.providerModels?.[provider]) {
      return settings.providerModels[provider];
    }
    if (provider === 'openrouter' && settings.defaultModel) {
      return settings.defaultModel;
    }
    return null;
  }

  setProviderModel(provider: ProviderId, model: string): void {
    const settings = this.getSettings();
    const providerModels = settings.providerModels || {};
    providerModels[provider] = model;
    this.setSetting('providerModels', providerModels);
    
    if (provider === 'openrouter') {
      this.setSetting('defaultModel', model);
    }
    this.emitModelConfigChanged();
  }

  getModelPricing(provider: ProviderId, model: string): ProviderPricingEntry | null {
    const settings = this.getSettings();
    const providerPricing = settings.modelPricing?.[provider];
    if (!providerPricing) {
      return null;
    }

    return (
      providerPricing[model] ||
      providerPricing[`${provider}/${model}`] ||
      (model.includes('/') ? providerPricing[model.split('/').pop() ?? ''] : null)
    ) || null;
  }

  setProviderPricing(provider: ProviderId, pricingMap: Record<string, ProviderPricingEntry>): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (!pricingMap || Object.keys(pricingMap).length === 0) {
      return;
    }

    const settings = this.getSettings();
    const modelPricing = { ...(settings.modelPricing || {}) };
    const providerPricing = { ...(modelPricing[provider] || {}) };

    for (const [model, pricing] of Object.entries(pricingMap)) {
      providerPricing[model] = pricing;
    }

    modelPricing[provider] = providerPricing;
    this.setSetting('modelPricing', modelPricing);
  }

  private getProviderDefaultModel(provider: ProviderId): string {
    return getDefaultModel(provider);
  }

  getTheme(): 'light' | 'dark' | 'system' {
    return this.getSettings().theme || 'dark';
  }

  setTheme(theme: 'light' | 'dark' | 'system'): void {
    this.setSetting('theme', theme);
  }

  getLocale(): 'ko' | 'en' {
    return this.getSettings().locale || 'ko';
  }

  setLocale(locale: 'ko' | 'en'): void {
    this.setSetting('locale', locale);
  }

  clearSettings(): void {
    if (typeof window !== 'undefined') {
      localStorage.removeItem(this.STORAGE_KEY);
    }
  }

  getCostSettings(): CostSettings {
    return this.getSettings().costSettings || {
      showCosts: true,
      warningThreshold: 80
    };
  }

  setCostSettings(settings: CostSettings): void {
    this.setSetting('costSettings', settings);
    // Broadcast the change to reactive components
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('osw-studio-cost-settings-changed'));
    }
  }

  getCurrentSession(): SessionCost | null {
    const session = this.getSettings().currentSession;
    if (!session) {
      return null;
    }
    return {
      ...session,
      startTime: new Date(session.startTime)
    };
  }

  startNewSession(): SessionCost {
    const session: SessionCost = {
      sessionId: Date.now().toString(),
      startTime: new Date(),
      totalCost: 0,
      messageCount: 0,
      providerBreakdown: {}
    };
    this.setSetting('currentSession', session);
    return session;
  }

  updateSessionCost(usage: UsageInfo, cost: number): void {
    let session = this.getCurrentSession();
    if (!session) {
      session = this.startNewSession();
    }

    session.totalCost += cost;
    session.messageCount += 1;

    const provider = usage.provider || 'unknown';
    if (!session.providerBreakdown[provider]) {
      session.providerBreakdown[provider] = {
        cost: 0,
        tokenUsage: { input: 0, output: 0 },
        requestCount: 0
      };
    }

    session.providerBreakdown[provider].cost += cost;
    session.providerBreakdown[provider].tokenUsage.input += usage.promptTokens;
    session.providerBreakdown[provider].tokenUsage.output += usage.completionTokens;
    session.providerBreakdown[provider].requestCount += 1;

    const lifetimeCosts = this.getSettings().lifetimeCosts || {
      total: 0,
      byProvider: {}
    };
    lifetimeCosts.total += cost;
    lifetimeCosts.byProvider[provider] = (lifetimeCosts.byProvider[provider] || 0) + cost;

    this.setSetting('currentSession', session);
    this.setSetting('lifetimeCosts', lifetimeCosts);
  }

  getLifetimeCosts() {
    return this.getSettings().lifetimeCosts || {
      total: 0,
      byProvider: {}
    };
  }

  resetLifetimeCosts(): void {
    this.setSetting('lifetimeCosts', {
      total: 0,
      byProvider: {},
      lastReset: new Date()
    });
  }

  // Model cache management
  getCachedModels(provider: ProviderId): ModelCacheEntry | null {
    const settings = this.getSettings();
    const cache = settings.modelCache?.[provider];
    
    if (!cache) return null;
    
    // Check if cache is expired
    const now = new Date();
    const expiresAt = new Date(cache.expiresAt);
    
    if (now > expiresAt) {
      // Cache expired, remove it
      this.clearModelCache(provider);
      return null;
    }
    
    return cache;
  }

  setCachedModels(provider: ProviderId, models: ProviderModel[]): void {
    const settings = this.getSettings();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours
    
    const cache = settings.modelCache || {};
    cache[provider] = {
      models,
      timestamp: now.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
    
    this.setSetting('modelCache', cache);
  }

  clearModelCache(provider?: ProviderId): void {
    if (provider) {
      const settings = this.getSettings();
      const cache = settings.modelCache || {};
      delete cache[provider];
      this.setSetting('modelCache', cache);
    } else {
      // Clear all cache
      this.setSetting('modelCache', {});
    }
  }

  // Codex auth management
  getCodexAuth(): CodexAuthData | null {
    return this.getSettings().codexAuth || null;
  }

  setCodexAuth(auth: CodexAuthData): void {
    this.setSetting('codexAuth', auth);
    // Also write access_token into providerKeys so getProviderApiKey() works
    this.setProviderApiKey('openai-codex', auth.access_token);
  }

  clearCodexAuth(): void {
    const settings = this.getSettings();
    delete settings.codexAuth;
    if (typeof window !== 'undefined') {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settings));
    }
    // Also clear the provider key
    const providerKeys = settings.providerKeys || {};
    delete providerKeys['openai-codex'];
    this.setSetting('providerKeys', providerKeys);
  }

  isCodexTokenExpired(): boolean {
    const auth = this.getCodexAuth();
    if (!auth) return true;
    // Expired if within 60s of expiry
    return Date.now() / 1000 >= auth.expires_at - 60;
  }

  // HuggingFace auth management
  getHFAuth(): HFAuthData | null {
    return this.getSettings().hfAuth || null;
  }

  /**
   * Whether the stored HuggingFace OAuth token is past its expiry. Pasted tokens carry no
   * `expires_at` and never expire here; HF's own 401 is the only signal for those.
   */
  isHFAuthExpired(): boolean {
    const auth = this.getHFAuth();
    return !!auth?.expires_at && Date.now() >= auth.expires_at;
  }

  setHFAuth(auth: HFAuthData): void {
    this.setSetting('hfAuth', auth);
    // Also write access_token into providerKeys so getProviderApiKey() works
    this.setProviderApiKey('huggingface', auth.access_token);
  }

  clearHFAuth(): void {
    const settings = this.getSettings();
    delete settings.hfAuth;
    if (typeof window !== 'undefined') {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settings));
    }
    // Also clear the provider key
    const providerKeys = settings.providerKeys || {};
    delete providerKeys['huggingface'];
    this.setSetting('providerKeys', providerKeys);
  }

  getModelContextLengthFromCache(provider: ProviderId, modelId: string): number | undefined {
    const cache = this.getCachedModels(provider);
    if (!cache?.models) return undefined;
    const model = cache.models.find(m => m.id === modelId);
    return model?.contextLength;
  }

  isCompactionEnabled(provider: ProviderId): boolean {
    const settings = this.getSettings();
    return settings.compactionEnabled?.[provider] ?? true;
  }

  setCompactionEnabled(provider: ProviderId, enabled: boolean): void {
    const settings = this.getSettings();
    const map = { ...settings.compactionEnabled };
    if (enabled) {
      delete map[provider];
    } else {
      map[provider] = false;
    }
    this.setSetting('compactionEnabled', map);
  }

  getLocalContextLength(provider: ProviderId): number | undefined {
    return this.getSettings().localContextLengths?.[provider];
  }

  setLocalContextLength(provider: ProviderId, length: number | undefined): void {
    const lengths = { ...this.getSettings().localContextLengths };
    if (length === undefined) delete lengths[provider];
    else lengths[provider] = length;
    this.setSetting('localContextLengths', lengths);
  }

  getCompactionLimit(provider: ProviderId): number | undefined {
    const settings = this.getSettings();
    return settings.compactionLimits?.[provider];
  }

  setCompactionLimit(provider: ProviderId, limit: number | undefined): void {
    const settings = this.getSettings();
    const limits = { ...settings.compactionLimits };
    if (limit === undefined) {
      delete limits[provider];
    } else {
      limits[provider] = limit;
    }
    this.setSetting('compactionLimits', limits);
  }

  // Reasoning toggle management
  getReasoningEnabled(modelId: string): boolean {
    const settings = this.getSettings();
    return settings.reasoningEnabled?.[modelId] ?? false;
  }

  getDebugStreamEnabled(): boolean {
    const settings = this.getSettings();
    return settings.debugStreamEnabled ?? false;
  }

  setDebugStreamEnabled(enabled: boolean): void {
    this.setSetting('debugStreamEnabled', enabled);
  }

  setReasoningEnabled(modelId: string, enabled: boolean): void {
    const settings = this.getSettings();
    const reasoningEnabled = { ...(settings.reasoningEnabled || {}) };
    reasoningEnabled[modelId] = enabled;
    this.setSetting('reasoningEnabled', reasoningEnabled);

    // Broadcast the change
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('osw-studio-reasoning-changed', {
        detail: { modelId, enabled }
      }));
    }
  }

  migrateModels(): void {
    if (this.getSettings().modelTemplates) return; // idempotent
    const provider = this.getSelectedProvider();
    let model = this.getProviderModel(provider) || this.getDefaultModel();
    if (typeof window !== 'undefined') {
      if (localStorage.getItem(`osw-studio-use-separate-chat-model-${provider}`) === 'true') {
        model = localStorage.getItem(`osw-studio-code-model-${provider}`) || model;
      }
      const stale: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && /^osw-studio-(use-separate-chat-model|chat-model|code-model)-/.test(k)) stale.push(k);
      }
      stale.forEach((k) => localStorage.removeItem(k));
    }
    const def: ModelTemplate = {
      id: 'default', name: 'Default', builtin: false,
      assignment: {
        agent: { provider, model },
        imageGen: null, voiceInput: null,
        autoCompact: this.isCompactionEnabled(provider),
        compactLimit: this.getCompactionLimit(provider) ?? null,
      },
    };
    this.saveModelTemplate(def);
    this.setDefaultTemplateId('default');
  }

  // Model template management.
  // Built-in templates live in code (registry) and are merged in at read time —
  // never persisted. Built-in ids win over stored ones and cannot be saved or
  // deleted; "Save as" clones one into an editable (non-builtin) template.
  getModelTemplates(): Record<string, ModelTemplate> {
    const merged: Record<string, ModelTemplate> = {};
    const stored = this.getSettings().modelTemplates || {};
    for (const [id, t] of Object.entries(stored)) {
      // Only registry templates are read-only built-ins. Anything in storage is a
      // user template (incl. the migrated "Default") — force builtin:false so a
      // stale flag from an older build doesn't make it appear uneditable.
      if (!isBuiltInTemplateId(id)) merged[id] = hydrateModelTemplate(t);
    }
    for (const t of BUILT_IN_MODEL_TEMPLATES) merged[t.id] = t;
    return merged;
  }
  getModelTemplate(id: string): ModelTemplate | null { return this.getModelTemplates()[id] || null; }
  saveModelTemplate(t: ModelTemplate): void {
    if (isBuiltInTemplateId(t.id)) return; // built-ins are read-only
    const stored = this.getSettings().modelTemplates || {};
    // A content edit — stamp updatedAt so sync can detect local changes.
    const saved: ModelTemplate = { ...t, builtin: false, updatedAt: new Date() };
    this.setSetting('modelTemplates', { ...stored, [t.id]: saved });
    // If this IS the active template, an in-place edit must take effect on the effective
    // model: reload the working selection to match. Direct setSetting (no dispatch) keeps
    // exactly one modelConfigChanged below. Non-active templates leave working untouched.
    if (t.id === this.getDefaultTemplateId()) this.setSetting('activeAssignment', t.assignment);
    if (typeof window !== 'undefined') {
      import('@/lib/vfs/auto-sync').then(({ autoSyncModelTemplate }) => autoSyncModelTemplate(saved)).catch((e) => logger.debug('[ConfigManager] model-template auto-sync trigger failed', e));
      this.emitModelConfigChanged();
    }
  }
  deleteModelTemplate(id: string): void {
    if (isBuiltInTemplateId(id)) return; // built-ins cannot be deleted
    const all = { ...(this.getSettings().modelTemplates || {}) };
    delete all[id];
    this.setSetting('modelTemplates', all);
    if (typeof window !== 'undefined') {
      import('@/lib/vfs/auto-sync').then(({ autoDeleteModelTemplate }) => autoDeleteModelTemplate(id)).catch((e) => logger.debug('[ConfigManager] model-template auto-delete trigger failed', e));
    }
  }
  /** Store a template pulled from the server, preserving its server timestamp and marking it synced. */
  importModelTemplateFromServer(t: ModelTemplate): void {
    if (isBuiltInTemplateId(t.id)) return;
    const stored = this.getSettings().modelTemplates || {};
    const now = new Date();
    const serverUpdated = t.updatedAt ? new Date(t.updatedAt) : now;
    this.setSetting('modelTemplates', {
      ...stored,
      [t.id]: { ...t, builtin: false, updatedAt: serverUpdated, lastSyncedAt: now, serverUpdatedAt: serverUpdated },
    });
    // A sync pull can overwrite the active template's content; if it IS the active template,
    // reload the working selection so re-resolution reflects the synced change (otherwise the
    // dispatch below re-resolves against a stale working selection). Non-active: untouched.
    if (t.id === this.getDefaultTemplateId()) this.setSetting('activeAssignment', t.assignment);
    this.emitModelConfigChanged();
  }
  /** Record sync metadata after a push, without bumping updatedAt (not a content edit). */
  updateModelTemplateSyncMetadata(id: string, lastSyncedAt: Date, serverUpdatedAt: Date): void {
    const stored = this.getSettings().modelTemplates || {};
    const t = stored[id];
    if (!t) return;
    this.setSetting('modelTemplates', { ...stored, [id]: { ...t, lastSyncedAt, serverUpdatedAt } });
  }
  getDefaultTemplateId(): string { return this.getSettings().defaultTemplateId || 'default'; }
  setDefaultTemplateId(id: string): void {
    this.setSetting('defaultTemplateId', id);
    // Selecting a template loads it as the working selection, so switching templates
    // changes the effective model. Write directly (not via setActiveAssignment) to keep
    // exactly one modelConfigChanged dispatch per call.
    const t = this.getModelTemplate(id);
    if (t) this.setSetting('activeAssignment', t.assignment);
    this.emitModelConfigChanged();
  }

  /** The event every global model-config write emits so React consumers re-resolve. */
  private emitModelConfigChanged(): void {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('modelConfigChanged'));
  }

  /**
   * Resolve the active template: the one at defaultTemplateId, with a migrateModels()-then-retry
   * step and a default -> or-recommended degrade so a dangling id never throws for callers. Single
   * source of the fallback chain, shared by getActiveTemplate (template-store) and getActiveAssignment.
   */
  getActiveModelTemplate(): ModelTemplate {
    const id = this.getDefaultTemplateId();
    let t = this.getModelTemplate(id);
    if (!t) {
      this.migrateModels();
      t = this.getModelTemplate(id);
    }
    if (!t) t = this.getModelTemplate('default') ?? this.getModelTemplate('or-recommended');
    if (!t) throw new Error('No model template available (default and built-ins missing)');
    return t;
  }

  /**
   * The global working/effective model selection. Returns the persisted working selection if set,
   * else the active template's assignment. Never returns undefined. Returns a deep copy so callers
   * can't mutate stored state or the shared in-memory built-in template registry.
   */
  getActiveAssignment(): ModelAssignment {
    const stored = this.getSettings().activeAssignment;
    const assignment = stored ?? this.getActiveModelTemplate().assignment;
    return JSON.parse(JSON.stringify(assignment)) as ModelAssignment;
  }
  setActiveAssignment(a: ModelAssignment): void {
    this.setSetting('activeAssignment', a);
    this.emitModelConfigChanged();
  }

  // Permission mode and per-command overrides
  getPermissionMode(): PermissionMode {
    return this.getSettings().permissionMode ?? 'ask';
  }
  setPermissionMode(mode: PermissionMode): void {
    this.setSetting('permissionMode', mode);
  }
  getPermissionOverrides(): Record<string, GateDecision> {
    return this.getSettings().permissionOverrides ?? {};
  }
  setPermissionOverride(key: string, decision: GateDecision): void {
    const next = { ...this.getPermissionOverrides(), [key]: decision };
    this.setSetting('permissionOverrides', next);
  }
  setPermissionOverrides(map: Record<string, GateDecision>): void {
    this.setSetting('permissionOverrides', map);
  }

  // Web search provider configuration
  getWebSearchProvider(): WebSearchProviderId | null {
    return this.getSettings().webSearch?.provider ?? null;
  }
  setWebSearchProvider(p: WebSearchProviderId | null): void {
    const ws = { ...this.getSettings().webSearch };
    if (p === null) { delete ws.provider; } else { ws.provider = p; }
    this.setSetting('webSearch', ws);
  }
  getWebSearchKey(p: 'tavily' | 'firecrawl' | 'brave'): string | null {
    return this.getSettings().webSearch?.keys?.[p] ?? null;
  }
  setWebSearchKey(p: 'tavily' | 'firecrawl' | 'brave', key: string): void {
    const ws = this.getSettings().webSearch ?? {};
    this.setSetting('webSearch', { ...ws, keys: { ...ws.keys, [p]: key } });
  }
  getSearxngUrl(): string | null {
    return this.getSettings().webSearch?.searxngUrl ?? null;
  }
  setSearxngUrl(url: string): void {
    this.setSetting('webSearch', { ...this.getSettings().webSearch, searxngUrl: url });
  }
  isWebSearchConfigured(): boolean {
    const ws = this.getSettings().webSearch;
    if (!ws?.provider) return false;
    if (ws.provider === 'duckduckgo') return true;
    if (ws.provider === 'searxng') return !!ws.searxngUrl;
    return !!ws.keys?.[ws.provider];
  }

  getCollapsedModelGroups(): string[] {
    return this.getSettings().modelPickerCollapsed ?? [];
  }
  setModelGroupCollapsed(groupId: string, collapsed: boolean): void {
    const set = new Set(this.getCollapsedModelGroups());
    if (collapsed) set.add(groupId); else set.delete(groupId);
    this.setSetting('modelPickerCollapsed', [...set]);
  }

  /**
   * Which template sections are closed, or null if nobody has said yet.
   *
   * Null rather than an empty array because the two mean different things here: the picker starts
   * some sections closed, and "I opened all of them" has to be distinguishable from "this is a
   * first visit" or that choice would be undone on the next open.
   */
  getCollapsedTemplateGroups(): string[] | null {
    return this.getSettings().templatePickerCollapsed ?? null;
  }
  /**
   * Stores the whole set rather than one section at a time. Toggling one section has to be applied
   * to what is currently on screen, which includes sections closed by default and never touched;
   * reading the stored value here instead would drop those the first time anything was toggled.
   */
  setCollapsedTemplateGroups(groupIds: string[]): void {
    this.setSetting('templatePickerCollapsed', [...groupIds]);
  }

  // Custom provider management
  getCustomProviders(): Record<string, ProviderConfig> {
    return getCustomProviders();
  }

  setCustomProviders(providers: Record<string, ProviderConfig>): void {
    setCustomProviders(providers);
  }

  saveCustomProvider(id: string, config: ProviderConfig): void {
    saveCustomProviderConfig(id, config);
    if (typeof window !== 'undefined') {
      import('@/lib/vfs/auto-sync').then(({ autoSyncConnection }) => autoSyncConnection(config)).catch((e) => logger.debug('[ConfigManager] connection auto-sync trigger failed', e));
    }
  }

  removeCustomProvider(id: string): void {
    removeCustomProviderConfig(id);
    if (typeof window !== 'undefined') {
      import('@/lib/vfs/auto-sync').then(({ autoDeleteConnection }) => autoDeleteConnection(id)).catch((e) => logger.debug('[ConfigManager] connection auto-delete trigger failed', e));
    }
  }

  generateCustomProviderId(base: string): string {
    return generateCustomProviderIdHelper(base);
  }

  buildCustomProviderConfig(
    id: string,
    name: string,
    baseUrl: string,
    apiKeyRequired: boolean,
    customHeaders?: Record<string, string>
  ): ProviderConfig {
    return buildCustomProviderConfigHelper(id, name, baseUrl, apiKeyRequired, customHeaders);
  }
}

export const configManager = new ConfigManager();

/**
 * Get the login URL — points to the external auth provider if configured, otherwise the local login page.
 */
export function getLoginUrl(): string {
  return process.env.NEXT_PUBLIC_GATEWAY_URL
    ? `${process.env.NEXT_PUBLIC_GATEWAY_URL}/login`
    : '/admin/login';
}

/**
 * Migrate legacy 'osw-server-features-{id}' localStorage key to 'osw-backend-{id}'
 * Returns the current backend enabled state for the project.
 */
export function migrateBackendKey(projectId: string): boolean {
  if (typeof window === 'undefined') return true;
  const legacyKey = `osw-server-features-${projectId}`;
  const newKey = `osw-backend-${projectId}`;
  if (localStorage.getItem(legacyKey) && !localStorage.getItem(newKey)) {
    localStorage.setItem(newKey, localStorage.getItem(legacyKey)!);
    localStorage.removeItem(legacyKey);
  }
  return localStorage.getItem(newKey) !== 'false';
}
