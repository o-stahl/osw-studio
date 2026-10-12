'use client';

import React, { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeftRight, Clock, ExternalLink, OctagonPause, Play, Sparkles } from 'lucide-react';
import { getDefaultModel, getProvider } from '@/lib/llm/providers/registry';
import { isProviderConnected } from '@/lib/llm/providers/connection-status';
import type { ProviderId } from '@/lib/llm/providers/types';
import type { ModelRef } from '@/lib/llm/models/assignment';
import type { ProviderQuota } from '@/lib/llm/provider-status';
import { modelLabel } from '@/lib/llm/providers/model-label';
import { FREE_MODELS_FALLBACK, isFreeModels } from '@/lib/llm/suggestions/free-models';
import { HF_BILLING_URL } from '@/lib/constants/links';
import { cn } from '@/lib/utils';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import { ConnectOptions } from './connect-options';
import { configManager } from '@/lib/config/storage';
import { useWorkspaceStore } from '@/lib/stores/workspace';

/**
 * What the chat shows when a provider limit gets in the way: a short note when the run waited, or
 * when "Free models" moved to another free model, and a card when the task stopped.
 *
 * Every number comes from the event as the provider gave it at the time. With none, the copy says
 * what happened without one.
 */

/** Asks the chat panel to open its model picker, from anywhere in the thread. */
export const OPEN_MODEL_PICKER_EVENT = 'osw-open-model-picker';

const openModelPicker = () => window.dispatchEvent(new CustomEvent(OPEN_MODEL_PICKER_EVENT));

const providerName = (id: string) => (id ? getProvider(id).name : '');

interface NoticeData {
  kind: 'retrying' | 'switched' | 'picked' | 'resolved';
  provider: string;
  /** The HTTP status being retried: 429 is a rate limit, 5xx the provider not answering. */
  status?: number;
  fromModel?: string;
  toModel?: string;
  reason?: 'busy' | 'unavailable' | 'refused';
}

/**
 * The base for a note in the chat thread that is not a message: a provider limit, a model switch,
 * a stopped task. One look for all of them, with the icon carrying the kind.
 */
function ChatNotice({ icon: Icon, iconClassName, children }: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  iconClassName?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground" role="status">
      <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', iconClassName)} aria-hidden={true} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
    </div>
  );
}

export function LimitNotice({ data }: { data: NoticeData }) {
  const t = useTranslations('limits');
  if (data.kind === 'retrying') {
    return (
      <ChatNotice icon={Clock}>
        <span>{t((data.status ?? 0) >= 500 ? 'retryingServer' : 'retrying', { provider: providerName(data.provider) })}</span>
      </ChatNotice>
    );
  }
  const provider = data.provider as ProviderId;
  const from = modelLabel(provider, data.fromModel ?? '');
  const to = modelLabel(provider, data.toModel ?? '');
  if (data.kind === 'picked' || data.kind === 'resolved') {
    // OpenRouter's free router picks the model itself; which one is known once it answers.
    const text = data.kind === 'resolved'
      ? t('routerAnswering', { model: to })
      : data.toModel === FREE_MODELS_FALLBACK ? t('pickedRouter') : t('pickedFree', { model: to });
    return (
      <ChatNotice icon={Sparkles}>
        <span>{text}</span>
      </ChatNotice>
    );
  }
  return (
    <ChatNotice icon={ArrowLeftRight}>
      <span>{t(data.reason === 'unavailable' ? 'switchedUnavailable' : data.reason === 'refused' ? 'switchedRefused' : 'switchedBusy', { from, to })}</span>
    </ChatNotice>
  );
}

interface StoppedData {
  message?: string;
  errorCategory?: string;
  provider?: string;
  model?: string;
  quota?: ProviderQuota;
  resetAt?: number;
  /** Other connected providers, each with the model it would continue on. */
  alternatives?: ModelRef[];
  /** A model on the same provider worth trying: a suggestion, never applied on its own. */
  suggestion?: ModelRef;
  /** Resending on the same model can succeed (a wait, a top-up, a replaced key). */
  canRetrySame?: boolean;
}

/** Where a spent allowance leaves the task: it can only go on somewhere else, or after a top-up. */
const SPENT = new Set(['daily_limit', 'credit_exhausted']);
/** The provider's own words say why: which key, or what in the request was refused. */
const SHOW_DETAILS = new Set(['auth_expired', 'blocked', 'model_refused']);

/** OpenRouter's documented free tier: 50 free requests a day until $10 of credit is bought. */
const OPENROUTER_FREE_TIER_DAILY = 50;

/** A model's name for the card, with "Free models" named in the current language. */
function useModelName() {
  const tm = useTranslations('models');
  return (provider: ProviderId, id: string) => (isFreeModels(id) ? tm('freeModels') : modelLabel(provider, id));
}

/**
 * A task that stopped on a provider error or limit, and the ways to carry on. Stopping rather than
 * waiting keeps no run open; Continue starts a new turn on the same conversation. Everything here
 * is a suggestion: the model only changes when the user picks one.
 */
export function StoppedCard({ data, live, onContinue }: {
  data: StoppedData;
  /** This is where the task last stopped and nothing has run since, so its actions apply. */
  live: boolean;
  onContinue?: (withModel?: ModelRef) => void;
}) {
  const t = useTranslations('limits');
  const format = useLocalFormat();
  const nameOf = useModelName();
  const category = data.errorCategory ?? 'unknown';
  const provider = (data.provider ?? '') as ProviderId;
  const name = providerName(provider);
  const model = data.model ? nameOf(provider, data.model) : '';

  const title = (() => {
    switch (category) {
      case 'daily_limit': return t('titleDaily', { provider: name });
      case 'credit_exhausted': return provider === 'huggingface' ? t('titleHfCredit') : t('titleCredit', { provider: name });
      case 'rate_limited': return t('titleRate', { provider: name });
      case 'model_busy':
      case 'model_not_found': return t('titleModel', { model });
      case 'auth_expired': return t('titleAuth', { provider: name });
      case 'blocked': return t('titleBlocked', { provider: name });
      case 'model_refused': return t('titleModelRefused', { model, provider: name });
      default: return name ? t('titleOther', { provider: name }) : t('titleOtherNoProvider');
    }
  })();

  const lines: string[] = [];
  const quota = data.quota;
  if (category === 'daily_limit') {
    const resetAt = quota?.kind === 'daily' ? quota.resetAt : data.resetAt;
    const when = resetAt ? format.relativeTime(resetAt) : '';
    if (quota?.kind === 'daily' && when) lines.push(t('dailyCount', { used: quota.used, limit: quota.limit, when }));
    else lines.push(when ? t('dailyReset', { when }) : t('dailyEachDay'));
    // Only when the live limit is the documented free-tier one, so a changed policy stops matching
    // instead of the note going wrong.
    if (provider === 'openrouter' && quota?.kind === 'daily' && quota.limit === OPENROUTER_FREE_TIER_DAILY) lines.push(t('openrouterRaise'));
  } else if (category === 'credit_exhausted') {
    if (provider === 'huggingface') lines.push(t('hfCreditBody'));
    else {
      if (quota?.kind === 'balance') lines.push(t('balance', { remaining: quota.remaining }));
      lines.push(t('creditBody', { provider: name }));
    }
  } else if (category === 'rate_limited' || category === 'server_error') lines.push(t('rateBody'));
  else if (category === 'model_busy' || category === 'model_not_found') lines.push(t('modelBody'));
  else if (category === 'auth_expired') lines.push(t('authBody'));
  else if (category === 'blocked') lines.push(t('blockedBody'));
  else if (category === 'model_refused') lines.push(t('modelRefusedBody'));

  const alternatives = (data.alternatives ?? []).filter((a) => a.provider !== provider);
  const [first, ...others] = alternatives;
  const spent = SPENT.has(category);
  // Re-read when the model changes: a model picked with "Change" can be continued on.
  useWorkspaceStore((s) => s.modelConfigVersion);
  const working = configManager.getActiveAssignment().agent;
  const movedOn = working.provider !== provider || working.model !== data.model;
  const offerContinue = (data.canRetrySame !== false && !spent) || movedOn;

  return (
    <ChatNotice icon={OctagonPause} iconClassName="text-amber-500">
      {/* One notification, read as a sentence or two: what happened, then what to do. */}
      <p>{[title, ...lines, ...(live ? [t('stoppedHere')] : [])].join(' ')}</p>
      {(lines.length === 0 || SHOW_DETAILS.has(category)) && data.message && (
        <details>
          <summary className="cursor-pointer hover:text-foreground">{t('details')}</summary>
          <p className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{data.message}</p>
        </details>
      )}

      {live && onContinue && (
        <div className="flex flex-col gap-2">
          {/* A free HuggingFace account has no inference credit, so buying some is the direct fix. */}
          {category === 'credit_exhausted' && provider === 'huggingface' && (
            <a
              href={HF_BILLING_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-8 w-full items-center justify-center gap-2 rounded-md border border-primary/30 bg-primary/15 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              {t('hfBuyCredits')}
            </a>
          )}
          {offerContinue && (
            <button
              type="button"
              onClick={() => onContinue()}
              className="flex h-8 w-full items-center justify-center gap-2 rounded-md border border-primary/30 bg-primary/15 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              {movedOn ? t('continueWithModel', { model: nameOf(working.provider, working.model) }) : t('continue')}
            </button>
          )}
          {data.suggestion && !movedOn && (
            <button
              type="button"
              onClick={() => onContinue(data.suggestion)}
              className="flex h-8 w-full items-center justify-center gap-2 rounded-md border border-border bg-muted text-xs font-semibold text-foreground transition-colors hover:bg-accent"
            >
              <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden="true" />
              {t('tryModel', { model: nameOf(data.suggestion.provider, data.suggestion.model) })}
            </button>
          )}
          {first && (
            <>
              <button
                type="button"
                onClick={() => onContinue(first)}
                className="flex h-8 w-full items-center justify-center gap-2 rounded-md border border-border bg-muted text-xs font-semibold text-foreground transition-colors hover:bg-accent"
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                {t('continueWith', { provider: providerName(first.provider) })}
              </button>
              <p className="text-center text-xs text-muted-foreground">
                {t('yourModel', { model: nameOf(first.provider, first.model), provider: providerName(first.provider) })}
              </p>
              {others.slice(0, 2).map((alt) => (
                <button
                  key={`${alt.provider}:${alt.model}`}
                  type="button"
                  onClick={() => onContinue(alt)}
                  className="h-8 w-full rounded-md border border-border bg-muted text-xs font-semibold text-foreground transition-colors hover:bg-accent"
                >
                  {t('continueWith', { provider: providerName(alt.provider) })}
                </button>
              ))}
            </>
          )}
          <button type="button" onClick={openModelPicker} className="self-start text-xs text-primary underline-offset-2 hover:underline">
            {t('chooseAnother')}
          </button>
          {spent && !first && !data.suggestion && (
            <ContinueOnConnect exclude={provider} onContinue={onContinue} />
          )}
        </div>
      )}
    </ChatNotice>
  );
}

/**
 * Nothing else is connected: offer the ways to connect, and carry on as soon as one lands, on the
 * model suggested for the provider that was just connected.
 */
function ContinueOnConnect({ exclude, onContinue }: { exclude: ProviderId; onContinue: (withModel?: ModelRef) => void }) {
  const t = useTranslations('limits');
  const continued = useRef(false);

  useEffect(() => {
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent).detail as { provider?: ProviderId } | undefined;
      const provider = detail?.provider;
      // The same event announces a disconnect; only a provider that is connected now counts. A
      // local server announces itself without a key, so connection status decides, not `hasKey`.
      if (!provider || provider === exclude || continued.current || !isProviderConnected(provider)) return;
      continued.current = true;
      let model: ModelRef;
      try {
        const { modelForProvider } = await import('@/lib/llm/suggestions/suggest');
        model = await modelForProvider(provider);
      } catch {
        model = { provider, model: getDefaultModel(provider) };
      }
      onContinue(model);
    };
    window.addEventListener('apiKeyUpdated', handler);
    return () => window.removeEventListener('apiKeyUpdated', handler);
  }, [exclude, onContinue]);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{t('connectAnother')}</p>
      <ConnectOptions exclude={[exclude]} rowsOnly keepPage />
    </div>
  );
}
