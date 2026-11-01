import { configManager } from '@/lib/config/storage';
import { OSWS_PROVIDER } from '@/lib/inference/allowance';
import { allowanceUsable } from '@/lib/inference/allowance-status';
import { getProvider } from '@/lib/llm/providers/registry';
import { resolveActiveAssignment } from './template-store';
import { type ResolvedAssignment } from './assignment';

/**
 * Whether the GLOBAL active template's agent provider has the credentials needed
 * to chat. Resolves the provider from the global active template's assignment and
 * runs the usual key / local / oauth readiness checks on that provider.
 */
export function isProjectProviderReady(): boolean {
  const agent = resolveActiveAssignment().agent;
  const provider = agent?.provider ?? configManager.getSelectedProvider();
  // The free allowance has no key: its status check says whether it can be used.
  if (provider === OSWS_PROVIDER) return allowanceUsable();
  const providerConfig = getProvider(provider);
  if (providerConfig.isLocal) return true;
  if (providerConfig.apiKeyRequired || providerConfig.usesOAuth) {
    return !!configManager.getProviderApiKey(provider);
  }
  return true;
}

/**
 * True when the global active template's agent provider is not ready (no key/token), i.e. the user
 * has not chosen a working model yet, so onboarding may auto-assign a default. Guards against
 * overwriting an existing user's already-configured model when they merely re-auth a provider.
 */
export function shouldAutoAssignAgent(): boolean {
  return !isProjectProviderReady();
}

// Choose which model to select when auto-assigning a freshly connected provider:
// prefer the curated default if the provider actually serves it, otherwise the first available.
export function pickModelForProvider(defaultModel: string, availableModelIds: string[]): string {
  if (defaultModel && availableModelIds.includes(defaultModel)) return defaultModel;
  return availableModelIds[0] ?? defaultModel ?? '';
}

export async function getProjectAssignment(): Promise<ResolvedAssignment> {
  // ensure the Default template exists (one-time, idempotent); part B also runs this on settings load
  configManager.migrateModels();
  // Model selection is fully global now: resolve the single global active template.
  return resolveActiveAssignment();
}
