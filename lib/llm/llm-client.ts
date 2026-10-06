
import { ProviderId, ProviderModel } from './providers/types';
import { getProvider } from './providers/registry';
import { configManager } from '../config/storage';
import { apiFetch } from '../api/backend-status';

/**
 * Whether `provider` accepts the key. Throws when the check could not be made (no network, or the
 * provider could not be reached), which is not the same answer as a rejected key.
 */
export async function verifyApiKey(apiKey: string, provider: ProviderId): Promise<boolean> {
  if (!apiKey) return false;
  const response = await apiFetch('/api/validate-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey, provider }),
  });
  if (response.status >= 500) throw new Error(`Key check failed (${response.status})`); // i18n-ignore: never shown; callers word the failure
  if (!response.ok) return false;
  const { valid } = await response.json();
  return valid === true;
}

/** `verifyApiKey` for callers that only show valid or not: a check that could not run reads as not valid. */
export async function validateApiKey(apiKey: string, provider: ProviderId): Promise<boolean> {
  return verifyApiKey(apiKey, provider).catch(() => false);
}

export type ModelEntry = string | (Pick<ProviderModel, 'id'> & Partial<Omit<ProviderModel, 'id'>>);

export function normalizeModelEntry(entry: ModelEntry, defaultContextLength: number): ProviderModel {
  if (typeof entry === 'string') {
    return {
      id: entry,
      name: entry.split('/').pop() || entry,
      contextLength: defaultContextLength,
      supportsFunctions: true,
    };
  }

  return {
    ...entry,
    name: entry.name || entry.id.split('/').pop() || entry.id,
    contextLength: entry.contextLength || defaultContextLength,
    supportsFunctions: entry.supportsFunctions ?? true,
    supportsVision: entry.supportsVision ?? entry.inputModalities?.includes('image'),
  };
}

export async function getAvailableModels(
  apiKey?: string,
  provider?: ProviderId,
  baseUrl?: string,
  customHeaders?: Record<string, string>,
): Promise<ModelEntry[]> {
  const currentProvider = provider || configManager.getSelectedProvider() || 'openrouter';
  const providerConfig = getProvider(currentProvider);
  let key = apiKey || configManager.getProviderApiKey(currentProvider);

  if (!providerConfig.supportsModelDiscovery && providerConfig.models) {
    return providerConfig.models;
  }

  try {
    if (currentProvider === 'openai-codex' && typeof window !== 'undefined') {
      const { ensureValidCodexToken } = await import('@/lib/auth/codex-auth');
      key = await ensureValidCodexToken();
    }

    const body: Record<string, unknown> = {
      apiKey: key,
      provider: currentProvider
    };
    if (baseUrl) body.baseUrl = baseUrl;
    if (customHeaders) body.customHeaders = customHeaders;
    const response = await apiFetch('/api/models', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      return providerConfig.models || [];
    }

    const { models } = await response.json();
    return models || [];
  } catch {
    return providerConfig.models || [];
  }
}
