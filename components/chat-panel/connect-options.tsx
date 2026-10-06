'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ChevronDown, ExternalLink, KeyRound, Loader2, LogIn, Monitor, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { configManager } from '@/lib/config/storage';
import { getProvider } from '@/lib/llm/providers/registry';
import type { ProviderId } from '@/lib/llm/providers/types';
import { detectKeyProvider } from '@/lib/llm/providers/key-detect';
import { getAvailableModels, verifyApiKey } from '@/lib/llm/llm-client';
import { loadProviderModels } from '@/lib/llm/models/model-catalog';
import { activateProviderAsGlobalDefault } from '@/lib/llm/models/global-auto-assign';
import { shouldAutoAssignAgent } from '@/lib/llm/models/project-assignment';
import { startSignIn } from '@/lib/auth/provider-sign-in';
import { checkHFCapabilities, loginHF } from '@/lib/auth/hf-auth';
import { detectDeploymentType } from '@/lib/telemetry/config';
import { track } from '@/lib/telemetry';

/**
 * Ways to connect a model, as the first thing in an empty chat and on a stopped task's card.
 *
 * Which ways are offered depends on where the app runs: HuggingFace sign-in only on the Space,
 * where HF provides the OAuth settings; a model on this computer only where the server can reach
 * one (desktop and self-hosted, not the Space or hosted instances). OpenRouter sign-in works
 * everywhere and comes first.
 */

type Surface = ReturnType<typeof detectDeploymentType>;

const ZAI_KEYS_URL = 'https://z.ai/manage-apikey/apikey-list';
const POLLINATIONS_KEYS_URL = 'https://enter.pollinations.ai/keys';
const LOCAL_PROVIDERS: ProviderId[] = ['ollama', 'lmstudio', 'llamacpp'];

/** A local server is reachable from the app's server only where both run on the user's machine. */
function surfaceCanReachLocal(surface: Surface): boolean {
  if (surface === 'hf_space' || surface === 'managed') return false;
  if (surface === 'desktop') return true;
  const host = typeof window !== 'undefined' ? window.location.hostname : '';
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

function isFramed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

/** Store a key the way Settings › Connections does, and announce it. */
function connectWithKey(provider: ProviderId, key: string): void {
  configManager.setProviderApiKey(provider, key);
  configManager.clearModelCache(provider);
  track('connection_added', { provider, method: 'key' });
  window.dispatchEvent(new CustomEvent('apiKeyUpdated', { detail: { provider, hasKey: true } }));
}

type KeyCheck =
  | { kind: 'connected'; provider: ProviderId }
  | { kind: 'choose'; candidates: ProviderId[] }
  | { kind: 'rejected'; provider: ProviderId }
  | { kind: 'failed' };

/**
 * A key whose shape names one provider is checked with that provider. A key several providers could
 * have issued is sent nowhere until the person says whose it is: trying it against each would hand
 * the key to providers it does not belong to.
 */
async function checkPastedKey(key: string, only?: ProviderId): Promise<KeyCheck> {
  const candidates = only ? [only] : detectKeyProvider(key).candidates;
  if (candidates.length !== 1) return { kind: 'choose', candidates };
  const provider = candidates[0];
  try {
    return (await verifyApiKey(key, provider)) ? { kind: 'connected', provider } : { kind: 'rejected', provider };
  } catch {
    return { kind: 'failed' };
  }
}

function OptionRow({ badge, name, description, action, primary }: {
  badge: string;
  name: React.ReactNode;
  description: string;
  action: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <div className={cn(
      'flex items-center gap-3 rounded-lg border px-3 py-2.5',
      primary ? 'border-primary/30 bg-primary/5' : 'border-border bg-card',
    )}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-bold text-foreground" aria-hidden="true">
        {badge}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">{name}</div>
        <div className="text-xs leading-snug text-muted-foreground">{description}</div>
      </div>
      {action}
    </div>
  );
}

function RowButton({ onClick, icon: Icon, children, primary, busy }: {
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  primary?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors disabled:opacity-60',
        primary ? 'bg-primary/15 text-primary hover:bg-primary/20' : 'bg-muted text-foreground hover:bg-accent',
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

interface ConnectOptionsProps {
  /** Providers not to offer, such as the one a stopped task just ran out on. */
  exclude?: ProviderId[];
  /** Open Settings › Connections, for every provider not listed here. */
  onMoreOptions?: () => void;
  /** Leave out the paste field's label and the privacy line: the stopped card keeps it short. */
  rowsOnly?: boolean;
  /**
   * Sign in without leaving the page, in a popup. The stopped card continues the task once a
   * provider connects, which a redirect would cut short. HuggingFace's sign-in can only redirect,
   * so it is not offered here.
   */
  keepPage?: boolean;
}

export function ConnectOptions({ exclude = [], onMoreOptions, rowsOnly = false, keepPage = false }: ConnectOptionsProps) {
  const t = useTranslations('connect');
  const surface = useMemo(() => detectDeploymentType(), []);
  const [hf, setHf] = useState<{ clientId: string; scopes: string } | null>(null);
  const [local, setLocal] = useState<{ provider: ProviderId; count: number } | null>(null);
  const [findingLocal, setFindingLocal] = useState(false);
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [choices, setChoices] = useState<ProviderId[] | null>(null);
  const offerLocal = surfaceCanReachLocal(surface) && !exclude.some((p) => LOCAL_PROVIDERS.includes(p));

  const excludeHf = keepPage || exclude.includes('huggingface');
  useEffect(() => {
    if (surface !== 'hf_space' || excludeHf) return;
    let cancelled = false;
    checkHFCapabilities()
      .then((caps) => { if (!cancelled && caps.oauthAvailable && caps.clientId) setHf({ clientId: caps.clientId, scopes: caps.scopes }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [surface, excludeHf]);

  /**
   * Look for a running local server without caching its models: a cached list is what marks a
   * local provider connected, and looking is not connecting.
   */
  const probeLocal = useCallback(async (): Promise<{ provider: ProviderId; count: number } | null> => {
    for (const provider of LOCAL_PROVIDERS) {
      const models = await getAvailableModels(undefined, provider).catch(() => []);
      if (models.length > 0) return { provider, count: models.length };
    }
    return null;
  }, []);

  // On the user's own machine, look once for a running model server so it can be offered first.
  useEffect(() => {
    if (!offerLocal) return;
    let cancelled = false;
    probeLocal().then((found) => { if (!cancelled) setLocal(found); });
    return () => { cancelled = true; };
  }, [offerLocal, probeLocal]);

  const connectLocal = useCallback(async () => {
    setFindingLocal(true);
    try {
      const found = local ?? await probeLocal();
      if (!found) {
        toast.error(t('noLocal'));
        return;
      }
      // Loading (and caching) its models is what connects a local provider.
      await loadProviderModels(found.provider);
      track('connection_added', { provider: found.provider, method: 'local' });
      if (shouldAutoAssignAgent()) await activateProviderAsGlobalDefault(found.provider);
      window.dispatchEvent(new CustomEvent('apiKeyUpdated', { detail: { provider: found.provider, hasKey: false } }));
      toast.success(t('connected', { name: getProvider(found.provider).name }));
    } finally {
      setFindingLocal(false);
    }
  }, [local, probeLocal, t]);

  const signIn = useCallback((provider: 'openrouter') => {
    // Sign-in pages refuse to load inside a frame (OpenRouter sends frame-ancestors 'self'), and
    // the HuggingFace Space runs this app in one; there, as on a stopped task's card, use a popup.
    startSignIn(provider, { popup: keepPage || isFramed() })
      .then((started) => { if (!started) toast.error(t('popupBlocked')); })
      .catch(() => toast.error(t('signInFailed')));
  }, [t, keepPage]);

  const openKeyPage = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
    document.getElementById('osw-connect-key')?.focus();
  }, []);

  const submitKey = useCallback(async (only?: ProviderId) => {
    const value = key.trim();
    if (!value) return;
    setChecking(true);
    setProblem(null);
    try {
      const result = await checkPastedKey(value, only);
      if (result.kind === 'connected') {
        connectWithKey(result.provider, value);
        toast.success(t('connected', { name: getProvider(result.provider).name }));
        setKey('');
        setChoices(null);
      } else if (result.kind === 'choose') {
        setChoices(result.candidates);
      } else if (result.kind === 'rejected') {
        setProblem(t('invalid', { name: getProvider(result.provider).name }));
      } else {
        setProblem(t('checkFailed'));
      }
    } finally {
      setChecking(false);
    }
  }, [key, t]);

  const detected = useMemo(() => {
    const { candidates } = detectKeyProvider(key);
    return candidates.length === 1 ? getProvider(candidates[0]).name : null;
  }, [key]);

  const offered = (p: ProviderId) => !exclude.includes(p);
  const localRow = offerLocal && (
    <OptionRow
      key="local"
      badge="PC"
      name={t('localTitle')}
      description={local ? t('localFound', { name: getProvider(local.provider).name, count: local.count }) : t('localDesc')}
      primary={!!local}
      action={<RowButton onClick={connectLocal} icon={Monitor} busy={findingLocal} primary={!!local}>{local ? t('use') : t('find')}</RowButton>}
    />
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {/* A model already running here needs no account at all, so it leads when there is one. */}
        {local && localRow}
        {offered('openrouter') && (
          <OptionRow
            badge="OR"
            name={<>OpenRouter{!local && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">{t('recommended')}</span>}</>}
            description={t('openrouterDesc')}
            primary={!local}
            action={<RowButton onClick={() => signIn('openrouter')} icon={LogIn} primary={!local}>{t('signIn')}</RowButton>}
          />
        )}
        {offered('pollinations') && (
          <OptionRow
            badge="Po"
            name="Pollinations"
            description={t('pollinationsKeyDesc')}
            action={<RowButton onClick={() => openKeyPage(POLLINATIONS_KEYS_URL)} icon={ExternalLink}>{t('getKey')}</RowButton>}
          />
        )}
        {offered('zhipu') && (
          <OptionRow
            badge="Z"
            name="Z.ai"
            description={t('zaiDesc')}
            action={<RowButton onClick={() => openKeyPage(ZAI_KEYS_URL)} icon={ExternalLink}>{t('getKey')}</RowButton>}
          />
        )}
        {hf && !keepPage && offered('huggingface') && (
          <OptionRow
            badge="HF"
            name="HuggingFace"
            description={t('huggingfaceDesc')}
            action={<RowButton onClick={() => { loginHF(hf.clientId, hf.scopes).catch(() => toast.error(t('signInFailed'))); }} icon={LogIn}>{t('signIn')}</RowButton>}
          />
        )}
        {!local && localRow}
      </div>

      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => { e.preventDefault(); void submitKey(); }}
      >
        {!rowsOnly && <label htmlFor="osw-connect-key" className="text-xs font-semibold text-muted-foreground">{t('pasteLabel')}</label>}
        <div className="flex gap-2">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background px-3">
            <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              id="osw-connect-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => { setKey(e.target.value); setProblem(null); setChoices(null); }}
              placeholder={t('pastePlaceholder')}
              aria-label={rowsOnly ? t('pasteLabel') : undefined}
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={!key.trim() || checking}
            className="h-9 shrink-0 rounded-md border border-border bg-card px-3 text-xs font-semibold text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            {checking ? t('checking') : t('connect')}
          </button>
        </div>
        {detected && !problem && !choices && <p className="text-xs text-muted-foreground">{t('detected', { name: detected })}</p>}
        {problem && <p className="text-xs text-destructive" role="alert">{problem}</p>}
        {choices && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground">{t('ambiguous')}</p>
            <div className="flex flex-wrap gap-1.5">
              {choices.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => void submitKey(p)}
                  className="rounded-full border border-border px-2.5 py-1 text-xs text-foreground hover:bg-primary/15 hover:text-primary"
                >
                  {getProvider(p).name}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>

      {onMoreOptions && (
        <button
          type="button"
          onClick={onMoreOptions}
          className="flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="h-3.5 w-3.5" />
          {t('moreOptions')}
        </button>
      )}
      {!rowsOnly && (
        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          {t('privacy')}
        </p>
      )}
    </div>
  );
}

/** The empty chat before anything is connected. */
export function ConnectChooser({ onMoreOptions, held, onDiscardHeld }: {
  onMoreOptions: () => void;
  held?: string | null;
  onDiscardHeld?: () => void;
}) {
  const t = useTranslations('connect');
  return (
    <div className="flex flex-col gap-5 py-2">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold leading-snug text-foreground">{t('title')}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{t('intro')}</p>
      </div>
      {held && (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <p className="line-clamp-3 whitespace-pre-wrap text-sm text-foreground">{held}</p>
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t('held')}</span>
            {onDiscardHeld && (
              <button type="button" onClick={onDiscardHeld} className="underline hover:text-foreground">{t('discard')}</button>
            )}
          </div>
        </div>
      )}
      <ConnectOptions onMoreOptions={onMoreOptions} />
    </div>
  );
}
