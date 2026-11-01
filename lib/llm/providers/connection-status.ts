import { configManager } from '@/lib/config/storage';
import { getAllProviders, getProviderArchetype, getProvider } from '@/lib/llm/providers/registry';
import type { ProviderId } from '@/lib/llm/providers/types';
import { OSWS_PROVIDER } from '@/lib/inference/allowance';
import { allowanceUsable } from '@/lib/inference/allowance-status';

/**
 * Whether a provider is connected and usable.
 *
 * Connected = has an API key / OAuth token. For LOCAL providers, having cached
 * models also counts (reaching the local server is the connection — they have no
 * key). Cloud providers like HuggingFace expose a *public* model list that
 * `loadProviderModels` caches with no auth, so cached models there are NOT proof
 * of a connection — counting them would falsely show the provider as connected.
 */
export function isProviderConnected(id: ProviderId): boolean {
  // The free allowance needs nothing from the user: where it is offered, its status check decides.
  if (id === OSWS_PROVIDER) return allowanceUsable();
  if (configManager.getProviderApiKey(id)) return true;
  const archetype = getProviderArchetype(id);
  if (archetype === 'local') return !!configManager.getCachedModels(id);
  // Custom providers with optional keys are connected once models are cached.
  if (archetype === 'custom') {
    const cfg = getProvider(id);
    return !cfg.apiKeyRequired && !!configManager.getCachedModels(id);
  }
  return false;
}

/** The provider IDs that are currently connected. */
export function getConnectedProviders(): ProviderId[] {
  return getAllProviders()
    .filter((p) => isProviderConnected(p.id))
    .map((p) => p.id);
}

/** Whether any provider is connected at all. */
export function hasAnyConnectedProvider(): boolean {
  return getAllProviders().some((p) => isProviderConnected(p.id));
}
