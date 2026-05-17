import type { ServerGenerationParams } from './types';
import type { ProviderId } from '@/lib/llm/providers/types';

interface SessionCost {
  totalCost: number;
  requestCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export class ServerConfigManager {
  private session: SessionCost = {
    totalCost: 0,
    requestCount: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
  };

  constructor(
    private readonly params: ServerGenerationParams,
    private readonly taskId?: string,
  ) {}

  getSelectedProvider(): ProviderId {
    return this.params.provider;
  }

  getProviderApiKey(provider: ProviderId): string | null {
    return provider === this.params.provider ? this.params.apiKey : null;
  }

  getProviderModel(provider: ProviderId): string | null {
    return provider === this.params.provider ? this.params.model : null;
  }

  getCachedModels(
    provider: ProviderId,
  ): { models: Array<{ id: string; name: string; context_length?: number }>; timestamp: number } | null {
    if (provider !== this.params.provider || !this.params.cachedModels) return null;
    return { models: this.params.cachedModels, timestamp: Date.now() };
  }

  getModelPricing(_provider: ProviderId, model: string): { prompt: number; completion: number } | null {
    return this.params.modelPricing?.[model] ?? null;
  }

  getReasoningEnabled(_model: string): boolean {
    return this.params.reasoningEnabled ?? false;
  }

  getDebugStreamEnabled(): boolean {
    return this.params.debugStreamEnabled ?? false;
  }

  isCompactionEnabled(_provider: ProviderId): boolean {
    return this.params.compactionEnabled ?? true;
  }

  getCompactionLimit(_provider: ProviderId): number | undefined {
    return this.params.compactionLimit;
  }

  getModelContextLengthFromCache(_provider: ProviderId, modelId: string): number | undefined {
    return this.params.cachedModels?.find((m) => m.id === modelId)?.context_length;
  }

  updateSessionCost(usage: { promptTokens?: number; completionTokens?: number }, cost: number): void {
    this.session.totalCost += cost;
    this.session.requestCount += 1;
    this.session.totalPromptTokens += usage.promptTokens ?? 0;
    this.session.totalCompletionTokens += usage.completionTokens ?? 0;
  }

  getCurrentSession(): { sessionId?: string; totalCost: number; requestCount: number } | null {
    return { sessionId: this.taskId, ...this.session };
  }

  getSessionCost(): SessionCost {
    return { ...this.session };
  }
}
