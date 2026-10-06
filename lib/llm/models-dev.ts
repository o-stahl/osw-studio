import type { ProviderId, ProviderModel, InputModality, OutputModality } from './providers/types';
import type { ProviderPricingEntry } from '@/lib/config/storage';
import { configManager } from '@/lib/config/storage';
import { logger } from '@/lib/utils';

const API_URL = 'https://models.dev/api.json';

const PROVIDER_MAP: Partial<Record<ProviderId, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-codex': 'openai',
  gemini: 'google',
  groq: 'groq',
  deepseek: 'deepseek',
  huggingface: 'huggingface',
  minimax: 'minimax',
  zhipu: 'zhipuai',
  sambanova: 'sambanova',
  'opencode-go': 'opencode-go',
  vercel: 'vercel',
};

interface ModelsDevCost {
  input: number;
  output: number;
  reasoning?: number;
}

interface ModelsDevModalities {
  input?: string[];
  output?: string[];
}

interface ModelsDevLimit {
  context?: number;
  output?: number;
}

interface ModelsDevModel {
  id: string;
  name?: string;
  description?: string;
  cost?: ModelsDevCost;
  modalities?: ModelsDevModalities;
  tool_call?: boolean;
  reasoning?: boolean;
  limit?: ModelsDevLimit;
}

interface ModelsDevProvider {
  id: string;
  models: Record<string, ModelsDevModel>;
}

type ModelsDevResponse = Record<string, ModelsDevProvider>;

let fetchPromise: Promise<ModelsDevResponse | null> | null = null;
let cachedData: ModelsDevResponse | null = null;

async function fetchModelsDevData(): Promise<ModelsDevResponse | null> {
  if (cachedData) return cachedData;
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const response = await fetch(API_URL, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      cachedData = await response.json() as ModelsDevResponse;
      return cachedData;
    } catch (error) {
      logger.warn('[models.dev] Failed to fetch pricing data', error);
      fetchPromise = null;
      return null;
    }
  })();

  return fetchPromise;
}

function registerProviderPricing(
  oswsProvider: ProviderId,
  devProvider: ModelsDevProvider,
): void {
  const pricingMap: Record<string, ProviderPricingEntry> = {};

  for (const [modelId, model] of Object.entries(devProvider.models)) {
    if (!model.cost || !Number.isFinite(model.cost.input) || !Number.isFinite(model.cost.output)) {
      continue;
    }

    const entry: ProviderPricingEntry = {
      input: model.cost.input,
      output: model.cost.output,
      reasoning: model.cost.reasoning,
    };

    pricingMap[modelId] = entry;
    pricingMap[`${oswsProvider}/${modelId}`] = entry;
  }

  if (Object.keys(pricingMap).length > 0) {
    configManager.setProviderPricing(oswsProvider, pricingMap);
  }
}

let registered = false;

export async function ensureModelsDevPricing(): Promise<void> {
  if (registered) return;

  const data = await fetchModelsDevData();
  if (!data) return;

  registered = true;

  for (const [oswsId, devId] of Object.entries(PROVIDER_MAP) as [ProviderId, string][]) {
    if (!devId) continue;
    const devProvider = data[devId];
    if (devProvider) {
      registerProviderPricing(oswsId, devProvider);
    }
  }
}

const VALID_INPUT_MODALITIES = new Set<InputModality>(['text', 'image', 'audio', 'file']);
const VALID_OUTPUT_MODALITIES = new Set<OutputModality>(['text', 'image', 'audio']);

function mapInputModalities(raw: string[]): InputModality[] {
  const mapped: InputModality[] = [];
  for (const m of raw) {
    if (VALID_INPUT_MODALITIES.has(m as InputModality)) {
      mapped.push(m as InputModality);
    }
  }
  return mapped;
}

function mapOutputModalities(raw: string[]): OutputModality[] {
  const mapped: OutputModality[] = [];
  for (const m of raw) {
    if (VALID_OUTPUT_MODALITIES.has(m as OutputModality)) {
      mapped.push(m as OutputModality);
    }
  }
  return mapped;
}

export async function enrichModelsFromModelsDev(
  provider: ProviderId,
  models: ProviderModel[],
): Promise<ProviderModel[]> {
  const devId = PROVIDER_MAP[provider];
  if (!devId) return models;

  const data = await fetchModelsDevData();
  if (!data) return models;

  const devProvider = data[devId];
  if (!devProvider) return models;

  for (const model of models) {
    const devModel = devProvider.models[model.id];
    if (!devModel) continue;

    if (!model.pricing && devModel.cost && Number.isFinite(devModel.cost.input) && Number.isFinite(devModel.cost.output)) {
      model.pricing = {
        input: devModel.cost.input,
        output: devModel.cost.output,
        reasoning: devModel.cost.reasoning,
      };
    }

    if (devModel.modalities?.input?.length) {
      const mapped = mapInputModalities(devModel.modalities.input);
      if (!model.inputModalities?.length && mapped.length) {
        model.inputModalities = mapped;
      }
      if (model.supportsVision === undefined && mapped.includes('image')) {
        model.supportsVision = true;
      }
    }

    if (!model.outputModalities?.length && devModel.modalities?.output?.length) {
      const mapped = mapOutputModalities(devModel.modalities.output);
      if (mapped.length) model.outputModalities = mapped;
    }

    if (model.supportsFunctions === undefined && devModel.tool_call !== undefined) {
      model.supportsFunctions = devModel.tool_call;
    }

    if (model.supportsReasoning === undefined && devModel.reasoning !== undefined) {
      model.supportsReasoning = devModel.reasoning;
    }

    if (devModel.limit) {
      if (model.contextLength <= 128000 && devModel.limit.context && devModel.limit.context > 0) {
        model.contextLength = devModel.limit.context;
      }
      if (model.maxTokens === undefined && devModel.limit.output && devModel.limit.output > 0) {
        model.maxTokens = devModel.limit.output;
      }
    }
  }

  return models;
}

function devModelToProviderModel(devModel: ModelsDevModel): ProviderModel {
  const inputMods = devModel.modalities?.input?.length
    ? mapInputModalities(devModel.modalities.input) : undefined;
  const outputMods = devModel.modalities?.output?.length
    ? mapOutputModalities(devModel.modalities.output) : undefined;

  return {
    id: devModel.id,
    name: devModel.name || devModel.id,
    description: devModel.description,
    contextLength: devModel.limit?.context || 128000,
    maxTokens: devModel.limit?.output || undefined,
    supportsFunctions: devModel.tool_call,
    supportsVision: inputMods?.includes('image') || undefined,
    supportsReasoning: devModel.reasoning || undefined,
    ...(inputMods?.length ? { inputModalities: inputMods } : {}),
    ...(outputMods?.length ? { outputModalities: outputMods } : {}),
    ...(devModel.cost && Number.isFinite(devModel.cost.input) && Number.isFinite(devModel.cost.output)
      ? { pricing: { input: devModel.cost.input, output: devModel.cost.output, reasoning: devModel.cost.reasoning } }
      : {}),
  };
}

export async function loadModelsFromModelsDev(
  provider: ProviderId,
): Promise<ProviderModel[] | null> {
  const devId = PROVIDER_MAP[provider];
  if (!devId) return null;

  const data = await fetchModelsDevData();
  if (!data) return null;

  const devProvider = data[devId];
  if (!devProvider) return null;

  const models = Object.values(devProvider.models).map(devModelToProviderModel);
  return models.length > 0 ? models : null;
}
