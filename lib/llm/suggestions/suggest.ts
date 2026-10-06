import type { ProviderId } from '@/lib/llm/providers/types';
import type { ModelRef } from '@/lib/llm/models/assignment';
import { getDefaultModel, getProvider } from '@/lib/llm/providers/registry';
import { getConnectedProviders } from '@/lib/llm/providers/connection-status';
import { loadProviderModels } from '@/lib/llm/models/model-catalog';
import { configManager } from '@/lib/config/storage';
import { fetchProviderStatus } from '@/lib/llm/provider-status';
import { getScores, refreshScores } from './scores';
import { getObserved, isCoolingDown } from './observed';
import { rankModels, nextSuggestion, isFreeModel, type RankedModel } from './rank';

/**
 * Suggestions for the browser: the ranking in `rank.ts` fed with the connected providers' model
 * lists, the current scores and this browser's record of what has worked.
 */

/** The conversation plus the agent's instructions rarely fit in less. */
const MIN_AGENT_CONTEXT = 32_000;

export async function rankProviderModels(provider: ProviderId, options: { freeOnly?: boolean } = {}): Promise<RankedModel[]> {
  void refreshScores(configManager.getProviderApiKey('openrouter'));
  const models = await loadProviderModels(provider);
  return rankModels(models.map((model) => ({ provider, model })), {
    scores: getScores(),
    freeOnly: options.freeOnly,
    minContext: MIN_AGENT_CONTEXT,
    observed: getObserved,
    coolingDown: isCoolingDown,
  });
}

/**
 * Whether a switch away from `current` has to stay on free models: it was a free model, or the
 * provider says the account cannot pay for anything else. A switch never starts spending money.
 */
async function mustStayFree(current: ModelRef): Promise<boolean> {
  const models = await loadProviderModels(current.provider);
  const entry = models.find((m) => m.id === current.model);
  if (entry && isFreeModel(entry)) return true;
  if (current.model.endsWith(':free')) return true;
  const status = await fetchProviderStatus(current.provider, configManager.getProviderApiKey(current.provider) ?? '');
  return status.freeOnly === true;
}

/**
 * The model to carry on with on the same provider after `current` was busy or missing. On the free
 * path only free models; on a paid model only ones that cost no more per output token, and none at
 * all when its price is unknown, since a switch the user did not ask for must not raise the bill.
 */
export async function nextModelAfter(current: ModelRef): Promise<ModelRef | undefined> {
  const freeOnly = await mustStayFree(current);
  let ranked = await rankProviderModels(current.provider, { freeOnly });
  if (!freeOnly) {
    const models = await loadProviderModels(current.provider);
    const ceiling = models.find((m) => m.id === current.model)?.pricing?.output;
    if (ceiling === undefined) return undefined;
    ranked = ranked.filter((r) => r.model.pricing !== undefined && r.model.pricing.output <= ceiling);
  }
  const next = nextSuggestion(ranked, current);
  return next ? { provider: next.provider, model: next.model.id } : undefined;
}

/**
 * The model to use on a provider the user has just connected or is switching to: the model they
 * already chose for it, else the top suggestion (free only when the account can only use free
 * models), else the provider's default.
 */
export async function modelForProvider(provider: ProviderId): Promise<ModelRef> {
  const chosen = configManager.getProviderModel(provider);
  if (chosen) return { provider, model: chosen };
  const status = await fetchProviderStatus(provider, configManager.getProviderApiKey(provider) ?? '');
  const ranked = await rankProviderModels(provider, { freeOnly: status.freeOnly === true });
  const top = ranked.find((r) => !r.coolingDown);
  return { provider, model: top?.model.id ?? getDefaultModel(provider) };
}

/** Other connected providers and the model each would continue with, for a stopped task's card. */
export async function alternativesTo(provider: ProviderId): Promise<ModelRef[]> {
  const others = getConnectedProviders().filter((p) => p !== provider && !getProvider(p).isLocal);
  const locals = getConnectedProviders().filter((p) => p !== provider && getProvider(p).isLocal);
  const refs = await Promise.all([...others, ...locals].map((p) => modelForProvider(p).catch(() => null)));
  return refs.filter((r): r is ModelRef => !!r && !!r.model);
}
