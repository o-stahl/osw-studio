'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useProviderDescriptions } from '@/lib/i18n/use-provider-descriptions';
import { Plus, Search, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Eye, EyeOff, Loader2, ExternalLink, MoreVertical, Pencil, RefreshCw, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { ServerDeleteRefused } from '@/lib/vfs/auto-sync';
import { configManager } from '@/lib/config/storage';
import { track } from '@/lib/telemetry';
import { validateApiKey as checkApiKey } from '@/lib/llm/llm-client';
import { getAllProviders, getOfferableProviders, getProvider, getProviderArchetype } from '@/lib/llm/providers/registry';
import { isProviderConnected } from '@/lib/llm/providers/connection-status';
import { assertPublicHttpUrl } from '@/lib/llm/providers/url-safety';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { ConnectionBadge } from '@/components/settings/connection-badge';
import { loadProviderModels } from '@/lib/llm/models/model-catalog';
import { CodexAuthPanel } from '@/components/settings/codex-auth-panel';
import { HFAuthPanel } from '@/components/settings/hf-auth-panel';
import { OllamaPreflight } from '@/components/settings/ollama-preflight';
import { LocalContextLength } from '@/components/settings/local-context-length';
import { Drawer } from './drawer';
import { SearchConnectionsSection } from './search-connections';
import type { ProviderId } from '@/lib/llm/providers/types';
import { disconnectCodex } from '@/lib/auth/codex-auth';
import { useSignInStart } from '@/lib/hooks/use-sign-in-start';
import { cn, logger } from '@/lib/utils';
import {
  CustomHeadersEditor,
  headerRowsFrom,
  headersFromRows,
  unusableHeaderNames,
  type HeaderRow,
} from './custom-headers-editor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Notify the rest of the app that a provider's key/connection state changed. */
function emitApiKeyUpdate(provider: string, hasKey: boolean) {
  window.dispatchEvent(new CustomEvent('apiKeyUpdated', { detail: { provider, hasKey } }));
}

/** Masked credential for display in connection rows. */
function maskedCred(id: ProviderId): string {
  const cfg = getProvider(id);
  const archetype = getProviderArchetype(id);
  if (archetype === 'local' || archetype === 'custom') return cfg.baseUrl ?? '';
  if (id === 'huggingface') {
    const auth = configManager.getHFAuth();
    if (auth?.username) return auth.username;
    const key = configManager.getProviderApiKey(id);
    return key ? `···${key.slice(-4)}` : '';
  }
  if (id === 'openai-codex') {
    const auth = configManager.getCodexAuth();
    return auth?.user_email ?? 'ChatGPT';
  }
  const key = configManager.getProviderApiKey(id);
  return key ? `···${key.slice(-4)}` : '';
}

// ---------------------------------------------------------------------------
// Connect-config body
// ---------------------------------------------------------------------------

interface ConnectConfigBodyProps {
  providerId: ProviderId;
  onConnected: () => void;
  onBack: () => void;
}

export function ConnectConfigBody({ providerId, onConnected, onBack }: ConnectConfigBodyProps) {
  const t = useTranslations('connections');
  const tc = useTranslations('common');
  const ts = useTranslations('settings');
  const tconnect = useTranslations('connect');
  const providerConfig = getProvider(providerId);
  const archetype = getProviderArchetype(providerId);

  const [currentApiKey, setCurrentApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [validatingKey, setValidatingKey] = useState(false);
  const [testing, setTesting] = useState(false);

  const dispatchApiKeyEvent = useCallback((hasKey: boolean) => {
    emitApiKeyUpdate(providerId, hasKey);
  }, [providerId]);

  // OpenRouter can also be connected by signing in. A popup keeps this page open and announces the
  // key when it lands; desktop sends popups to the system browser, so there it redirects instead.
  const canSignIn = providerId === 'openrouter';
  const signingIn = useRef(false);
  const startSignIn = useSignInStart();
  const signIn = () => {
    signingIn.current = true;
    startSignIn('openrouter', { popup: process.env.NEXT_PUBLIC_DESKTOP !== 'true' })
      .then((started) => { if (!started) toast.error(tconnect('popupBlocked')); })
      .catch(() => toast.error(tconnect('signInFailed')));
  };
  useEffect(() => {
    if (!canSignIn) return;
    const onKey = (e: Event) => {
      const detail = (e as CustomEvent<{ provider?: string; hasKey?: boolean }>).detail;
      if (signingIn.current && detail?.provider === providerId && detail.hasKey) {
        signingIn.current = false;
        onConnected();
      }
    };
    window.addEventListener('apiKeyUpdated', onKey);
    return () => window.removeEventListener('apiKeyUpdated', onKey);
  }, [canSignIn, providerId, onConnected]);

  const handleConnect = async () => {
    const key = currentApiKey.trim();
    if (!key) {
      toast.error(ts('apiKeyRequired'));
      return;
    }
    setValidatingKey(true);
    try {
      const isValid = await checkApiKey(key, providerId);
      if (isValid) {
        configManager.setProviderApiKey(providerId, key);
        configManager.clearModelCache(providerId);
        track('connection_added', { provider: providerId, method: 'key' });
        toast.success(t('connectedTo', { name: providerConfig.name }));
        dispatchApiKeyEvent(true);
        onConnected();
      } else {
        toast.error(ts('apiKeyInvalidRetry'));
      }
    } catch {
      toast.error(ts('apiKeyValidateFailed'));
    } finally {
      setValidatingKey(false);
    }
  };

  const handleLocalConnect = async () => {
    // Save the optional key first so the discovery fetch uses it, then probe the
    // local server. Caching its models on success is what marks it "connected".
    configManager.setProviderApiKey(providerId, currentApiKey.trim());
    configManager.clearModelCache(providerId);
    setTesting(true);
    try {
      const models = await loadProviderModels(providerId);
      if (models.length > 0) {
        track('connection_added', { provider: providerId, method: 'local' });
        toast.success(t('connectedModels', { name: providerConfig.name, count: models.length }));
        dispatchApiKeyEvent(!!currentApiKey.trim());
        onConnected();
      } else {
        toast.error(providerConfig.baseUrl
            ? t('unreachableAt', { name: providerConfig.name, url: providerConfig.baseUrl })
            : t('unreachable', { name: providerConfig.name }));
      }
    } catch {
      toast.error(t('unreachable', { name: providerConfig.name }));
    } finally {
      setTesting(false);
    }
  };

  // --- subscription (Codex OAuth) ---
  if (archetype === 'subscription') {
    return (
      <div className="px-[18px] py-4 space-y-4">
        <CodexAuthPanel
          onAuthChange={() => {
            dispatchApiKeyEvent(!!configManager.getProviderApiKey(providerId));
            onConnected();
          }}
        />
      </div>
    );
  }

  // --- OAuth cloud (HuggingFace) ---
  if (archetype === 'cloud' && providerConfig.usesOAuth) {
    return (
      <div className="px-[18px] py-4 space-y-4">
        <HFAuthPanel
          onAuthChange={() => {
            dispatchApiKeyEvent(!!configManager.getProviderApiKey(providerId));
            onConnected();
          }}
        />
      </div>
    );
  }

  // --- local ---
  if (archetype === 'local') {
    return (
      <div className="px-[18px] py-4 space-y-4">

        <div className="p-3 border rounded-md bg-muted/50 text-sm text-muted-foreground space-y-1">
          <p className="font-medium">{ts('localProvider')}</p>
          <p>{ts('ensureRunning', { provider: providerConfig.name })}</p>
          {providerConfig.baseUrl && (
            <p>
              {ts('defaultEndpoint')}{' '}
              <code className="text-xs">{providerConfig.baseUrl}</code>
            </p>
          )}
          {providerId === 'ollama' && <OllamaPreflight />}
        </div>

        <LocalContextLength providerId={providerId} />

        <div>
          <Label htmlFor="local-key">
            {t('apiKey')}
            <span className="text-muted-foreground text-xs ml-1">{tc('labels.optionalParen')}</span>
          </Label>
          <div className="flex gap-2 mt-2">
            <div className="relative flex-1">
              <Input
                id="local-key"
                type={showApiKey ? 'text' : 'password'}
                value={currentApiKey}
                onChange={(e) => setCurrentApiKey(e.target.value)}
                placeholder={providerConfig.apiKeyPlaceholder || t('authOnlyIfRequired')}
                className="pr-10"
              />
              <Button
                size="icon"
                variant="ghost"
                className="absolute right-1 top-1 h-7 w-7"
                onClick={() => setShowApiKey(!showApiKey)}
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {ts('apiKeyOptionalFor', { provider: providerConfig.name })}
          </p>
        </div>

        <div className="flex gap-2 justify-end pt-2">
          <Button variant="ghost" size="sm" onClick={onBack} disabled={testing}>
            {tc('actions.back')}
          </Button>
          <Button size="sm" onClick={handleLocalConnect} disabled={testing}>
            {testing ? t('testing') : t('testAndConnect')}
          </Button>
        </div>
      </div>
    );
  }

  // --- cloud / aggregator (API key required) ---
  return (
    <div className="px-[18px] py-4 space-y-4">

      {canSignIn && (
        <>
          <Button onClick={signIn} className="w-full gap-2" variant="outline">
            {ts('signInWithProvider', { provider: providerConfig.name })}
          </Button>
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">{ts('orPasteKey')}</span>
            </div>
          </div>
        </>
      )}

      <div>
        <Label htmlFor="cloud-key">{ts('providerApiKey', { provider: providerConfig.name })}</Label>
        <div className="flex gap-2 mt-2">
          <div className="relative flex-1">
            <Input
              id="cloud-key"
              type={showApiKey ? 'text' : 'password'}
              value={currentApiKey}
              onChange={(e) => { setCurrentApiKey(e.target.value); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && currentApiKey.trim()) handleConnect(); }}
              placeholder={providerConfig.apiKeyPlaceholder || t('apiKeyPlaceholder')}
              className="pr-10"
              disabled={validatingKey}
            />
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1 h-7 w-7"
              onClick={() => setShowApiKey(!showApiKey)}
            >
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
          <Button
            onClick={handleConnect}
            disabled={validatingKey || !currentApiKey.trim()}
            size="sm"
          >
            {validatingKey ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                {t('connecting')}
              </>
            ) : (
              t('connect')
            )}
          </Button>
        </div>
        {providerConfig.apiKeyHelpUrl && (
          <p className="text-sm text-muted-foreground mt-2">
            {ts.rich('getApiKeyFrom', {
              provider: providerConfig.name,
              link: (chunks) => (
                <a
                  href={providerConfig.apiKeyHelpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  {chunks} <ExternalLink className="h-3 w-3" />
                </a>
              ),
            })}
          </p>
        )}
      </div>

      <div className="flex gap-2 justify-end pt-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          {tc('actions.back')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect-custom body (OpenAI-compatible endpoint)
// ---------------------------------------------------------------------------

interface ConnectCustomBodyProps {
  onConnected: () => void;
  onBack: () => void;
}

function ConnectCustomBody({ onConnected, onBack }: ConnectCustomBodyProps) {
  const tc = useTranslations('common');
  const t = useTranslations('connections');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [currentApiKey, setCurrentApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [requireApiKey, setRequireApiKey] = useState(true);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([]);
  const [testing, setTesting] = useState(false);

  const dispatchApiKeyEvent = useCallback((provider: string, hasKey: boolean) => {
    emitApiKeyUpdate(provider, hasKey);
  }, []);

  const handleConnect = async () => {
    const trimmedName = name.trim();
    const trimmedUrl = baseUrl.trim();
    if (!trimmedName) {
      toast.error(t('providerNameRequired'));
      return;
    }
    if (!trimmedUrl) {
      toast.error(t('endpointRequired'));
      return;
    }
    if (requireApiKey && !currentApiKey.trim()) {
      toast.error(t('apiTokenRequired'));
      return;
    }
    // External-only: custom endpoints must be public. Reject loopback/private/non-http
    // before persisting anything.
    try {
      assertPublicHttpUrl(trimmedUrl);
    } catch {
      toast.error(t('externalOnly'));
      return;
    }

    const id = configManager.generateCustomProviderId(trimmedName);
    const badNames = unusableHeaderNames(headerRows);
    if (badNames.length > 0) {
      toast.error(t('badHeaders', { names: badNames.join(', ') }));
      return;
    }

    const cfg = configManager.buildCustomProviderConfig(
      id,
      trimmedName,
      trimmedUrl,
      requireApiKey,
      headersFromRows(headerRows)
    );

    const key = currentApiKey.trim();
    setTesting(true);
    // Persist the connection regardless of model discovery — some valid OpenAI-compatible
    // endpoints don't expose /models. We probe afterwards and surface the outcome.
    configManager.saveCustomProvider(id, cfg);
    if (key) configManager.setProviderApiKey(id, key);
    configManager.clearModelCache(id);
    track('connection_added', { provider: 'custom', method: 'custom' });
    try {
      const models = await loadProviderModels(id);
      if (models.length > 0) {
        toast.success(t('connectedModels', { name: cfg.name, count: models.length }));
      } else {
        toast.warning(t('addedEmptyModels', { name: cfg.name }));
      }
    } catch (err) {
      logger.error(`[custom-provider] ${trimmedName} model discovery failed:`, err);
      toast.warning(t('addedNoModels', { name: cfg.name }));
    } finally {
      setTesting(false);
      dispatchApiKeyEvent(id, !!key);
      onConnected();
    }
  };

  return (
    <div className="px-[18px] py-4 space-y-4">
      <div>
        <Label htmlFor="custom-name">{t('providerName')}</Label>
        <Input
          id="custom-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('providerNamePlaceholder')}
          className="mt-2"
          disabled={testing}
        />
      </div>

      <div>
        <Label htmlFor="custom-url">{t('apiEndpoint')}</Label>
        <Input
          id="custom-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
          className="mt-2"
          disabled={testing}
        />
        <p className="text-xs text-muted-foreground mt-2">
          {t.rich('baseUrlHint', {
            code: (chunks) => <code className="text-xs">{chunks}</code>,
          })}
        </p>
      </div>

      <div>
        <Label htmlFor="custom-key">
          {t('apiToken')}
          <span className="text-muted-foreground text-xs ml-1">{requireApiKey ? t('requiredParen') : tc('labels.optionalParen')}</span>
        </Label>
        <div className="flex gap-2 mt-2">
          <div className="relative flex-1">
            <Input
              id="custom-key"
              type={showApiKey ? 'text' : 'password'}
              value={currentApiKey}
              onChange={(e) => setCurrentApiKey(e.target.value)}
              placeholder="sk-..."
              className="pr-10"
              disabled={testing}
            />
            <Button
              size="icon"
              variant="ghost"
              className="absolute right-1 top-1 h-7 w-7"
              onClick={() => setShowApiKey(!showApiKey)}
              disabled={testing}
            >
              {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>

      <CustomHeadersEditor
        rows={headerRows}
        onChange={setHeaderRows}
        disabled={testing}
        idPrefix="custom"
      />

      <div className="flex items-center justify-between">
        <Label htmlFor="custom-require-key" className="text-sm font-normal cursor-pointer">
          {t('requireApiToken')}
        </Label>
        <Switch
          id="custom-require-key"
          checked={requireApiKey}
          onCheckedChange={setRequireApiKey}
          disabled={testing}
        />
      </div>

      <div className="flex gap-2 justify-end pt-2">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={testing}>
          {tc('actions.back')}
        </Button>
        <Button size="sm" onClick={handleConnect} disabled={testing || !name.trim() || !baseUrl.trim() || (requireApiKey && !currentApiKey.trim())}>
          {testing ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin mr-1" />
              {t('testing')}
            </>
          ) : (
            t('testAndConnect')
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect-choose body
// ---------------------------------------------------------------------------

interface ConnectChooseBodyProps {
  onChoose: (id: ProviderId) => void;
  onChooseCustom: () => void;
}

function ConnectChooseBody({ onChoose, onChooseCustom }: ConnectChooseBodyProps) {
  const t = useTranslations('connections');
  const describe = useProviderDescriptions();
  const [query, setQuery] = useState('');

  const allProviders = getOfferableProviders();
  const unconnected = allProviders.filter((p) => !isProviderConnected(p.id));

  const filtered = query.trim()
    ? unconnected.filter(
        (p) =>
          p.name.toLowerCase().includes(query.toLowerCase()) ||
          describe(p).toLowerCase().includes(query.toLowerCase())
      )
    : unconnected;

  const customCard = (
    <button
      key="__custom__"
      type="button"
      onClick={onChooseCustom}
      className={cn(
        'w-full flex items-start gap-3 px-3 py-3 rounded-lg text-left transition-colors',
        'hover:bg-muted border border-transparent hover:border-border',
        'cursor-pointer'
      )}
    >
      <div className="w-[34px] h-[34px] rounded-sm bg-secondary border border-border flex items-center justify-center flex-shrink-0 text-xs font-semibold text-muted-foreground">
        +
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm">{t('customOpenAiCompatible')}</span>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-muted border border-border text-muted-foreground">
            {t('customEndpoint')}
          </span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {t('addAnyEndpoint')}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
    </button>
  );

  const archetypeLabel: Record<string, string> = {
    aggregator: t('apiKey'),
    cloud: t('apiKey'),
    subscription: t('subscription'),
    local: t('localEndpoint'),
    custom: t('customEndpoint'),
  };

  return (
    <div className="px-[18px] py-4 space-y-3">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          autoFocus
          placeholder={t('searchProviders')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Provider list */}
      <div className="space-y-1 pt-1">
        {!query.trim() && customCard}
        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">{t('noProvidersMatch')}</p>
        ) : (
          filtered.map((p) => {
            const archetype = getProviderArchetype(p.id);
            const label = archetypeLabel[archetype] ?? archetype;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onChoose(p.id)}
                className={cn(
                  'w-full flex items-start gap-3 px-3 py-3 rounded-lg text-left transition-colors',
                  'hover:bg-muted border border-transparent hover:border-border',
                  'cursor-pointer'
                )}
              >
                {/* Icon / initials */}
                <div className="w-[34px] h-[34px] rounded-sm bg-secondary border border-border flex items-center justify-center flex-shrink-0 text-xs font-semibold text-muted-foreground">
                  {p.name.slice(0, 2).toUpperCase()}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm">{p.name}</span>
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-muted border border-border text-muted-foreground">
                      {label}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">{describe(p)}</div>
                </div>

                <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection row
// ---------------------------------------------------------------------------

interface ConnectionRowProps {
  providerId: ProviderId;
  onDisconnect: () => void;
  onEdit: () => void;
  onRevalidate: () => Promise<void>;
}

function ConnectionRow({ providerId, onDisconnect, onEdit, onRevalidate }: ConnectionRowProps) {
  const t = useTranslations('connections');
  const tc = useTranslations('common');
  const cfg = getProvider(providerId);
  const cred = maskedCred(providerId);
  const [revalidating, setRevalidating] = useState(false);

  const handleRevalidate = async () => {
    setRevalidating(true);
    try { await onRevalidate(); } finally { setRevalidating(false); }
  };

  return (
    <div className="flex items-center gap-3 bg-card border border-border rounded-md px-4 py-3">
      {/* Icon / initials */}
      <div className="w-[36px] h-[36px] rounded-md bg-secondary border border-border flex items-center justify-center flex-shrink-0 text-xs font-semibold text-muted-foreground">
        {cfg.name.slice(0, 2).toUpperCase()}
      </div>

      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm">{cfg.name}</div>
        {cred && (
          <div className="text-xs text-muted-foreground font-mono mt-0.5 truncate">{cred}</div>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        <div className="h-1.5 w-1.5 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]" />
        <span className="text-xs font-semibold text-green-500 mr-1">{tc('labels.connected')}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" className="size-7" title={tc('labels.connectionOptions')} disabled={revalidating}>
              {revalidating ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreVertical className="h-4 w-4" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="h-4 w-4" />
              {tc('actions.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { void handleRevalidate(); }}>
              <RefreshCw className="h-4 w-4" />
              {t('revalidate')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDisconnect} className="text-destructive focus:text-destructive">
              <Unplug className="h-4 w-4" />
              {t('disconnect')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit-config body (for existing connections)
// ---------------------------------------------------------------------------

interface EditConfigBodyProps {
  providerId: ProviderId;
  onDone: () => void;
  onDisconnected: () => void;
}

function EditConfigBody({ providerId, onDone, onDisconnected }: EditConfigBodyProps) {
  const t = useTranslations('connections');
  const tc = useTranslations('common');
  const ts = useTranslations('settings');
  const providerConfig = getProvider(providerId);
  const archetype = getProviderArchetype(providerId);
  const isCustom = archetype === 'custom';
  const [disconnecting, setDisconnecting] = useState(false);

  // Editable fields for custom providers
  const [customName, setCustomName] = useState(isCustom ? providerConfig.name : '');
  const [customUrl, setCustomUrl] = useState(isCustom ? providerConfig.baseUrl || '' : '');
  const [customKey, setCustomKey] = useState(() => configManager.getProviderApiKey(providerId) || '');
  const [showCustomKey, setShowCustomKey] = useState(false);
  const [customRequireKey, setCustomRequireKey] = useState(isCustom ? providerConfig.apiKeyRequired : true);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(
    () => (isCustom ? headerRowsFrom(providerConfig.customHeaders) : [])
  );
  const [savingCustom, setSavingCustom] = useState(false);

  const dispatchApiKeyEvent = useCallback((hasKey: boolean) => {
    emitApiKeyUpdate(providerId, hasKey);
  }, [providerId]);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      // First, so a refused server delete leaves the key and connection as they were.
      if (isCustom) {
        await configManager.removeCustomProvider(providerId);
      }
      if (providerId === 'openai-codex') {
        await disconnectCodex();
        configManager.clearCodexAuth();
        configManager.clearModelCache('openai-codex');
      } else if (providerId === 'huggingface') {
        configManager.clearHFAuth();
        configManager.clearModelCache('huggingface');
      } else {
        configManager.setProviderApiKey(providerId, '');
        configManager.clearModelCache(providerId);
      }
      track('connection_removed', { provider: isCustom ? 'custom' : providerId });
      toast.success(t('disconnectedFrom', { name: providerConfig.name }));
      dispatchApiKeyEvent(false);
      onDisconnected();
    } catch (error) {
      toast.error(error instanceof ServerDeleteRefused ? error.message : ts('disconnectFailed'));
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSaveCustom = async () => {
    const name = customName.trim();
    const url = customUrl.trim();
    if (!name || !url) {
      toast.error(t('nameEndpointRequired'));
      return;
    }
    try {
      assertPublicHttpUrl(url);
    } catch {
      toast.error(t('externalOnly'));
      return;
    }
    const badNames = unusableHeaderNames(headerRows);
    if (badNames.length > 0) {
      toast.error(t('badHeaders', { names: badNames.join(', ') }));
      return;
    }
    setSavingCustom(true);
    try {
      // Passed on every save. Without them an edit to any other field would rebuild the config
      // without its headers and drop them.
      const cfg = configManager.buildCustomProviderConfig(
        providerId,
        name,
        url,
        customRequireKey,
        headersFromRows(headerRows)
      );
      configManager.saveCustomProvider(providerId, cfg);
      configManager.setProviderApiKey(providerId, customKey.trim());
      configManager.clearModelCache(providerId);
      const models = await loadProviderModels(providerId);
      toast.success(
        models.length > 0
          ? t('updatedModels', { name: cfg.name, count: models.length })
          : t('updatedName', { name: cfg.name })
      );
      dispatchApiKeyEvent(!!customKey.trim());
      onDone();
    } catch {
      toast.error(t('updateCustomFailed'));
    } finally {
      setSavingCustom(false);
    }
  };

  // For OAuth providers, render their auth panel (which has built-in disconnect)
  if (archetype === 'subscription') {
    return (
      <div className="px-[18px] py-4 space-y-4">
        <CodexAuthPanel
          onAuthChange={() => {
            const hasKey = !!configManager.getProviderApiKey(providerId);
            dispatchApiKeyEvent(hasKey);
            if (!hasKey) onDisconnected();
          }}
        />
        <div className="flex justify-end pt-2">
          <Button size="sm" onClick={onDone}>{tc('actions.done')}</Button>
        </div>
      </div>
    );
  }

  if (archetype === 'cloud' && providerConfig.usesOAuth) {
    return (
      <div className="px-[18px] py-4 space-y-4">
        <HFAuthPanel
          onAuthChange={() => {
            const hasKey = !!configManager.getProviderApiKey(providerId);
            dispatchApiKeyEvent(hasKey);
            if (!hasKey) onDisconnected();
          }}
        />
        <div className="flex justify-end pt-2">
          <Button size="sm" onClick={onDone}>{tc('actions.done')}</Button>
        </div>
      </div>
    );
  }

  // custom: editable name, endpoint, key, and disconnect/delete
  if (isCustom) {
    return (
      <div className="px-[18px] py-4 space-y-4">
        <div>
          <Label htmlFor="edit-custom-name">{t('providerName')}</Label>
          <Input
            id="edit-custom-name"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            className="mt-2"
            disabled={savingCustom}
          />
        </div>

        <div>
          <Label htmlFor="edit-custom-url">{t('apiEndpoint')}</Label>
          <Input
            id="edit-custom-url"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            className="mt-2"
            disabled={savingCustom}
          />
        </div>

        <div>
          <Label htmlFor="edit-custom-key">{t('apiToken')}</Label>
          <div className="flex gap-2 mt-2">
            <div className="relative flex-1">
              <Input
                id="edit-custom-key"
                type={showCustomKey ? 'text' : 'password'}
                value={customKey}
                onChange={(e) => setCustomKey(e.target.value)}
                placeholder={customRequireKey ? tc('labels.required') : tc('labels.optional')}
                className="pr-10"
                disabled={savingCustom}
              />
              <Button
                size="icon"
                variant="ghost"
                className="absolute right-1 top-1 h-7 w-7"
                onClick={() => setShowCustomKey(!showCustomKey)}
                disabled={savingCustom}
              >
                {showCustomKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        </div>

        <CustomHeadersEditor
          rows={headerRows}
          onChange={setHeaderRows}
          disabled={savingCustom}
          idPrefix="edit-custom"
        />

        <div className="flex items-center justify-between">
          <Label htmlFor="edit-custom-require-key" className="text-sm font-normal cursor-pointer">
            {t('requireApiToken')}
          </Label>
          <Switch
            id="edit-custom-require-key"
            checked={customRequireKey}
            onCheckedChange={setCustomRequireKey}
            disabled={savingCustom}
          />
        </div>

        <div className="flex gap-2 justify-end pt-2">
          <Button
            variant="destructive"
            size="sm"
            onClick={handleDisconnect}
            disabled={disconnecting || savingCustom}
          >
            {disconnecting ? t('deleting') : tc('actions.delete')}
          </Button>
          <Button
            size="sm"
            onClick={handleSaveCustom}
            disabled={savingCustom || !customName.trim() || !customUrl.trim()}
          >
            {savingCustom ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                {tc('actions.saving')}
              </>
            ) : (
              tc('actions.save')
            )}
          </Button>
        </div>
      </div>
    );
  }

  // local: show read-only endpoint info + disconnect
  if (archetype === 'local') {
    return (
      <div className="px-[18px] py-4 space-y-4">
        <ConnectionBadge
          method="Local"
          extra={providerConfig.baseUrl}
          onDisconnect={handleDisconnect}
          disconnecting={disconnecting}
        />
        <p className="text-xs text-muted-foreground">
          {t('localAlwaysAvailable')}
        </p>
        <LocalContextLength providerId={providerId} />
        {providerId === 'ollama' && <OllamaPreflight />}
        <div className="flex justify-end pt-2">
          <Button size="sm" onClick={onDone}>{tc('actions.done')}</Button>
        </div>
      </div>
    );
  }

  // cloud / aggregator: show current key badge + option to replace or disconnect
  const existingKey = configManager.getProviderApiKey(providerId);
  return (
    <div className="px-[18px] py-4 space-y-4">
      <ConnectionBadge
        method="API Key"
        extra={existingKey ? `···${existingKey.slice(-4)}` : undefined}
        info={
          providerConfig.apiKeyHelpUrl ? (
            <a
              href={providerConfig.apiKeyHelpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              {ts('manageOn', { provider: providerConfig.name })} <ExternalLink className="h-2.5 w-2.5" />
            </a>
          ) : undefined
        }
        onDisconnect={handleDisconnect}
        disconnecting={disconnecting}
      />
      <div className="flex justify-end pt-2">
        <Button size="sm" onClick={onDone}>{tc('actions.done')}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Drawer mode type
// ---------------------------------------------------------------------------

type ConnDrawerMode = 'connect-choose' | 'connect-config' | 'connect-custom' | 'edit-config' | null;

// ---------------------------------------------------------------------------
// Main ConnectionsPane
// ---------------------------------------------------------------------------

export function ConnectionsPane() {
  const tc = useTranslations('common');
  const t = useTranslations('connections');
  const describe = useProviderDescriptions();
  const ts = useTranslations('settings');
  // Bumped after connect/disconnect to force a re-render that re-evaluates which
  // providers are connected. The value itself is unused — only the update matters.
  const [, setConnVersion] = useState(0);
  const refresh = useCallback(() => setConnVersion((v) => v + 1), []);
  // Connections live in this browser's storage, which the server render cannot see: read them only
  // once hydrated, so the server HTML and the first client render agree.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<ConnDrawerMode>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderId | null>(null);

  const openAddDrawer = () => {
    setDrawerMode('connect-choose');
    setSelectedProviderId(null);
    setDrawerOpen(true);
  };

  const openEditDrawer = (id: ProviderId) => {
    setSelectedProviderId(id);
    setDrawerMode('edit-config');
    setDrawerOpen(true);
  };

  // Drop the cached model list and re-fetch it (also picks up new capability
  // fields like output modalities). Implicitly re-checks the key — a fetch with
  // a bad key returns no models.
  const handleRevalidate = async (id: ProviderId) => {
    const cfg = getProvider(id);
    configManager.clearModelCache(id);
    try {
      const models = await loadProviderModels(id);
      if (models.length > 0) {
        toast.success(t('refreshedModels', { name: cfg.name, count: models.length }));
      } else {
        toast.error(t('noModelsFor', { name: cfg.name }));
      }
    } catch {
      toast.error(t('refreshFailedFor', { name: cfg.name }));
    }
  };

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setDrawerMode(null);
    setSelectedProviderId(null);
  }, []);

  const handleDisconnect = async (id: ProviderId) => {
    const cfg = getProvider(id);
    const isCustom = getProviderArchetype(id) === 'custom';
    try {
      // First, so a refused server delete leaves the key and connection as they were.
      if (isCustom) {
        await configManager.removeCustomProvider(id);
      }
      if (id === 'openai-codex') {
        await disconnectCodex();
        configManager.clearCodexAuth();
        configManager.clearModelCache('openai-codex');
      } else if (id === 'huggingface') {
        configManager.clearHFAuth();
        configManager.clearModelCache('huggingface');
      } else {
        configManager.setProviderApiKey(id, '');
        configManager.clearModelCache(id);
      }
      track('connection_removed', { provider: isCustom ? 'custom' : id });
      toast.success(t('disconnectedFrom', { name: cfg.name }));
      emitApiKeyUpdate(id, false);
      refresh();
    } catch (error) {
      toast.error(error instanceof ServerDeleteRefused ? error.message : ts('disconnectFailed'));
    }
  };

  const showLocalProviders = !process.env.NEXT_PUBLIC_GATEWAY_URL;
  const allProviders = getAllProviders();
  const connectedProviders = hydrated ? allProviders.filter((p) => isProviderConnected(p.id)) : [];

  const cloudProviders = connectedProviders.filter((p) => {
    const arch = getProviderArchetype(p.id);
    return arch !== 'local' && arch !== 'custom';
  });
  const customProviders = connectedProviders.filter((p) => getProviderArchetype(p.id) === 'custom');
  const localProviders = connectedProviders.filter((p) => {
    const arch = getProviderArchetype(p.id);
    return arch === 'local';
  });

  // Drawer title/label/scope
  let drawerLabel: string | undefined;
  let drawerTitle: string | undefined;
  let drawerScope: string | undefined;

  if (drawerMode === 'connect-choose') {
    drawerLabel = t('addProvider');
    drawerTitle = t('chooseProvider');
    drawerScope = t('chooseProviderScope');
  } else if (drawerMode === 'connect-custom') {
    drawerLabel = `← ${tc('actions.back')}`;
    drawerTitle = t('customProvider');
    drawerScope = t('customProviderScope');
  } else if (drawerMode === 'connect-config' && selectedProviderId) {
    drawerLabel = `← ${tc('actions.back')}`;
    drawerTitle = getProvider(selectedProviderId).name;
    drawerScope = describe(getProvider(selectedProviderId));
  } else if (drawerMode === 'edit-config' && selectedProviderId) {
    drawerLabel = t('editConnection');
    drawerTitle = getProvider(selectedProviderId).name;
    drawerScope = tc('labels.connected');
  }

  return (
    <div className="flex flex-col gap-8">
      {/* AI section */}
      <div className="flex flex-col gap-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-foreground">AI</h3>
            <p className="text-xs text-muted-foreground mt-1">
              {t('inferenceProvidersHint')}
            </p>
          </div>
          <Button
            variant="default"
            size="sm"
            autoFocus={hydrated && connectedProviders.length === 0}
            className={cn(
              'gap-1.5 shrink-0',
              // Nothing connected yet: make the primary next step obvious.
              hydrated && connectedProviders.length === 0 && 'ring-2 ring-primary/70 animate-ring-opacity',
            )}
            onClick={openAddDrawer}
          >
            <Plus className="h-3.5 w-3.5" />
            {t('addProvider')}
          </Button>
        </div>

        {/* Cloud section */}
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            {t('cloud')}
          </p>
        {cloudProviders.length === 0 ? (
          hydrated && <p className="text-sm text-muted-foreground py-1 pl-1">{t('noneYet')}</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {cloudProviders.map((p) => (
              <ConnectionRow
                key={p.id}
                providerId={p.id}
                onDisconnect={() => handleDisconnect(p.id)}
                onEdit={() => openEditDrawer(p.id)}
                onRevalidate={() => handleRevalidate(p.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Custom section */}
      {customProviders.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            {tc('labels.custom')}
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {customProviders.map((p) => (
              <ConnectionRow
                key={p.id}
                providerId={p.id}
                onDisconnect={() => handleDisconnect(p.id)}
                onEdit={() => openEditDrawer(p.id)}
                onRevalidate={() => handleRevalidate(p.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Local section — hidden on the managed gateway (no local inference there) */}
      {showLocalProviders && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            {t('local')}
          </p>
          {localProviders.length === 0 ? (
            hydrated && <p className="text-sm text-muted-foreground py-1 pl-1">{t('noneYet')}</p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {localProviders.map((p) => (
                <ConnectionRow
                  key={p.id}
                  providerId={p.id}
                  onDisconnect={() => handleDisconnect(p.id)}
                  onEdit={() => openEditDrawer(p.id)}
                  onRevalidate={() => handleRevalidate(p.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      </div>

      {/* Separator between AI and Search */}
      <div className="border-t border-border" />

      {/* Search section */}
      <SearchConnectionsSection />

      {/* Drawer */}
      <Drawer
        open={drawerOpen}
        mode={drawerMode as 'connect-choose' | 'connect-config' | 'connect-custom' | null}
        label={drawerLabel}
        onLabelClick={drawerMode === 'connect-config' || drawerMode === 'connect-custom' ? () => {
          setDrawerMode('connect-choose');
          setSelectedProviderId(null);
        } : undefined}
        title={drawerTitle}
        scope={drawerScope}
        onClose={closeDrawer}
      >
        {drawerMode === 'connect-choose' && (
          <ConnectChooseBody
            onChoose={(id) => {
              setSelectedProviderId(id);
              if (getProviderArchetype(id) === 'custom') {
                setDrawerMode('edit-config');
              } else {
                setDrawerMode('connect-config');
              }
            }}
            onChooseCustom={() => {
              setDrawerMode('connect-custom');
            }}
          />
        )}

        {drawerMode === 'connect-custom' && (
          <ConnectCustomBody
            onConnected={() => {
              refresh();
              closeDrawer();
            }}
            onBack={() => {
              setDrawerMode('connect-choose');
            }}
          />
        )}

        {drawerMode === 'connect-config' && selectedProviderId && (
          <ConnectConfigBody
            key={selectedProviderId}
            providerId={selectedProviderId}
            onConnected={() => {
              refresh();
              closeDrawer();
            }}
            onBack={() => {
              setDrawerMode('connect-choose');
              setSelectedProviderId(null);
            }}
          />
        )}

        {drawerMode === 'edit-config' && selectedProviderId && (
          <EditConfigBody
            key={selectedProviderId}
            providerId={selectedProviderId}
            onDone={() => {
              refresh();
              closeDrawer();
            }}
            onDisconnected={() => {
              refresh();
              closeDrawer();
            }}
          />
        )}
      </Drawer>
    </div>
  );
}
