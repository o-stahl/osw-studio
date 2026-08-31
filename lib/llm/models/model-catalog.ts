/**
 * model-catalog.ts
 *
 * Shared, non-React model discovery utilities.
 *
 *   loadProviderModels(provider)  — cache-then-fetch for one provider
 *   modelsForSlot(slot, providers, opts)  — aggregator with slot-based filtering
 */

import { configManager } from '@/lib/config/storage';
import { ProviderId, ProviderModel, InputModality, OutputModality } from '@/lib/llm/providers/types';
import { getProvider } from '@/lib/llm/providers/registry';
import { getAvailableModels, normalizeModelEntry } from '@/lib/llm/llm-client';
import {
  fetchAvailableModels,
} from '@/lib/llm/models-api';
import {
  registerOpenRouterPricingFromApi,
  registerPricingFromProviderModels,
} from '@/lib/llm/pricing-cache';
import { enrichModelsFromModelsDev, loadModelsFromModelsDev } from '@/lib/llm/models-dev';
import { logger } from '@/lib/utils';

// ---------------------------------------------------------------------------
// loadProviderModels
// ---------------------------------------------------------------------------

/**
 * Return the model list for a provider.
 *
 * - Returns cached models when available (same 24-hour TTL as ModelSelector).
 * - When the provider requires an API key that isn't present, returns the
 *   provider's hardcoded model list (or []) — mirrors ModelSelector behaviour.
 * - Registers OpenRouter / HuggingFace pricing into the pricing cache as a
 *   side-effect (same as ModelSelector does).
 * - Does NOT throw; returns [] on unrecoverable errors.
 */
export async function loadProviderModels(provider: ProviderId): Promise<ProviderModel[]> {
  const providerConfig = getProvider(provider);
  const apiKey = configManager.getProviderApiKey(provider);

  // If API key is required but missing, return hardcoded models (or empty).
  if (providerConfig.apiKeyRequired && !apiKey) {
    return providerConfig.models ?? [];
  }

  // Cache hit
  const cachedEntry = configManager.getCachedModels(provider);
  if (cachedEntry) {
    const cached = cachedEntry.models as ProviderModel[];
    await enrichModelsFromModelsDev(provider, cached);
    if (provider === 'openrouter') {
      registerPricingFromProviderModels('openrouter', cached);
    }
    if (provider === 'openai-codex') {
      const ids = new Set(cached.map(model => model.id));
      return [...cached, ...(providerConfig.models || []).filter(model => model.outputModalities?.includes('image') && !ids.has(model.id))];
    }
    return cached;
  }

  // Cache miss — fetch
  let loadedModels: ProviderModel[] = [];

  try {
    if (provider === 'openrouter') {
      const availableModels = await fetchAvailableModels();
      registerOpenRouterPricingFromApi(availableModels);

      const norm = (desc: unknown): string => {
        if (typeof desc === 'string') return desc;
        if (desc && typeof desc === 'object') {
          const record = desc as Record<string, unknown>;
          const candidate = ['description', 'name', 'summary']
            .map((key) => record[key])
            .find((value): value is string => typeof value === 'string');
          if (candidate) return candidate;
          try { return JSON.stringify(record); } catch { /* ignore */ }
        }
        if (desc == null) return '';
        return String(desc);
      };

      loadedModels = availableModels.map((model) => {
        const promptRate = model.pricing?.prompt ? Number(model.pricing.prompt) : undefined;
        const completionRate = model.pricing?.completion ? Number(model.pricing.completion) : undefined;
        const reasoningRate = model.pricing?.internal_reasoning
          ? Number(model.pricing.internal_reasoning)
          : undefined;

        const normalizeRate = (value?: number) => {
          if (value === undefined || !Number.isFinite(value)) return undefined;
          return value * 1_000_000;
        };

        const normalizedInput = normalizeRate(promptRate);
        const normalizedOutput = normalizeRate(completionRate);
        const normalizedReasoning = normalizeRate(reasoningRate);

        const pricing =
          normalizedInput !== undefined && normalizedOutput !== undefined
            ? { input: normalizedInput, output: normalizedOutput, reasoning: normalizedReasoning }
            : undefined;

        const orModalities = model.architecture?.input_modalities as InputModality[] | undefined;
        const orOutputModalities = model.architecture?.output_modalities as OutputModality[] | undefined;
        const providerModel: ProviderModel = {
          id: model.id,
          name: model.name,
          description: norm(model.description),
          contextLength: model.context_length,
          maxTokens: model.top_provider?.max_completion_tokens,
          supportsFunctions: model.supported_parameters?.includes('tools'),
          supportsVision: orModalities?.includes('image'),
          supportsReasoning: model.supported_parameters?.includes('reasoning'),
          ...(orModalities ? { inputModalities: orModalities } : {}),
          ...(orOutputModalities ? { outputModalities: orOutputModalities } : {}),
          pricing,
        };
        return providerModel;
      });
    } else if (provider === 'huggingface') {
      try {
        const hfResponse = await fetch('https://router.huggingface.co/v1/models');
        if (hfResponse.ok) {
          const hfData = await hfResponse.json();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          loadedModels = (hfData.data || []).map((model: any) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const hfProviders = model.providers || [] as any[];
            const bestProvider =
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              hfProviders.find((p: any) => p.supports_tools && p.status === 'live') ||
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              hfProviders.find((p: any) => p.status === 'live') ||
              hfProviders[0];

            const contextLength = bestProvider?.context_length || 32768;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const supportsFunctions = hfProviders.some((p: any) => p.supports_tools);
            const hfModalities = model.architecture?.input_modalities as InputModality[] | undefined;
            const hfOutputModalities = model.architecture?.output_modalities as OutputModality[] | undefined;
            const supportsVision = hfModalities?.includes('image');

            let pricing: { input: number; output: number } | undefined;
            if (
              bestProvider?.pricing?.input != null &&
              bestProvider?.pricing?.output != null
            ) {
              pricing = {
                input: bestProvider.pricing.input,
                output: bestProvider.pricing.output,
              };
            }

            return {
              id: model.id,
              name: model.id.split('/').pop() || model.id,
              contextLength,
              supportsFunctions,
              supportsVision,
              ...(hfModalities ? { inputModalities: hfModalities } : {}),
              ...(hfOutputModalities ? { outputModalities: hfOutputModalities } : {}),
              pricing,
            } as ProviderModel;
          });
        }
      } catch (error) {
        logger.error('HuggingFace models fetch error:', error);
      }
      if (loadedModels.length > 0) {
        registerPricingFromProviderModels('huggingface', loadedModels);
      }
    } else if (providerConfig.supportsModelDiscovery) {
      const modelEntries = await getAvailableModels(apiKey || undefined, provider, providerConfig.baseUrl);
      loadedModels = modelEntries.map((entry) => normalizeModelEntry(entry, 128000));
    } else {
      const devModels = await loadModelsFromModelsDev(provider);
      loadedModels = devModels ?? providerConfig.models ?? [];
    }

    // Enrich with models.dev pricing for models that don't have it
    if (loadedModels.length > 0) {
      await enrichModelsFromModelsDev(provider, loadedModels);
    }

    // Cache results
    if (loadedModels.length > 0) {
      configManager.setCachedModels(provider, loadedModels);
      if (provider === 'openrouter') {
        registerPricingFromProviderModels('openrouter', loadedModels);
      }
    }
  } catch (error) {
    logger.error(`loadProviderModels: failed to load models for ${provider}:`, error);
    // Fall back to hardcoded models
    return providerConfig.models ?? [];
  }

  return loadedModels;
}

// ---------------------------------------------------------------------------
// modelsForSlot
// ---------------------------------------------------------------------------

export type SlotKind = 'agent' | 'imageGen' | 'voiceInput';

export interface ModelsForSlotOptions {
  /** When true, skip modality filtering and return everything. */
  all?: boolean;
}

export interface SlotModelEntry {
  provider: ProviderId;
  model: ProviderModel;
}

/**
 * Aggregate models from one or more providers and filter by slot modality.
 *
 * Filtering rules (when opts.all is not set):
 *   - agent:       effective outputModalities includes 'text'
 *                  (undeclared outputModalities defaults to ['text'])
 *   - imageGen:    effective outputModalities includes 'image'
 *                  (undeclared outputModalities defaults to ['text'], so excluded)
 *   - voiceInput:  inputModalities includes 'audio'
 *
 * Errors from individual providers are swallowed — failed providers contribute
 * no entries to the result.
 *
 * The optional `_loader` parameter is an escape hatch for testing: pass a stub
 * to control which models each provider returns without network calls.
 */
export async function modelsForSlot(
  slot: SlotKind,
  providers: ProviderId[],
  opts?: ModelsForSlotOptions,
  _loader: (provider: ProviderId) => Promise<ProviderModel[]> = loadProviderModels,
): Promise<SlotModelEntry[]> {
  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const models = await _loader(provider);
      return { provider, models };
    }),
  );

  const rows: SlotModelEntry[] = [];

  for (const result of settled) {
    if (result.status === 'rejected') {
      logger.error('modelsForSlot: provider load failed:', result.reason);
      continue;
    }
    const { provider, models } = result.value;
    for (const model of models) {
      rows.push({ provider, model });
    }
  }

  if (opts?.all) return rows;

  return rows.filter(({ model }) => matchesSlot(slot, model));
}

/** Pure predicate: does a model qualify for the given slot? */
export function matchesSlot(slot: SlotKind, model: ProviderModel): boolean {
  // Effective output modalities: declared value, or ['text'] when absent.
  const effectiveOutput: string[] = model.outputModalities ?? ['text'];
  const effectiveInput: string[] = model.inputModalities ?? [];

  switch (slot) {
    case 'agent':
      return effectiveOutput.includes('text');
    case 'imageGen':
      return effectiveOutput.includes('image');
    case 'voiceInput':
      return effectiveInput.includes('audio');
    default:
      return false;
  }
}
