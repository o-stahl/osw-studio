import { describe, it, expect, beforeEach } from 'vitest';
import { ServerConfigManager } from '../server-config-manager';
import type { ServerGenerationParams } from '../types';

const baseParams: ServerGenerationParams = {
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'sk-test-key',
  temperature: 0.7,
  maxTokens: 4096,
  reasoningEnabled: false,
  compactionEnabled: true,
  compactionLimit: 80000,
  debugStreamEnabled: false,
  modelPricing: { 'gpt-4o': { prompt: 2.5, completion: 10 } },
  cachedModels: [{ id: 'gpt-4o', name: 'GPT-4o', context_length: 128000 }],
};

describe('ServerConfigManager', () => {
  let config: ServerConfigManager;

  beforeEach(() => {
    config = new ServerConfigManager(baseParams, 'task-123');
  });

  it('returns provider from params', () => {
    expect(config.getSelectedProvider()).toBe('openai');
  });

  it('returns API key from params', () => {
    expect(config.getProviderApiKey('openai')).toBe('sk-test-key');
  });

  it('returns null API key for non-matching provider', () => {
    expect(config.getProviderApiKey('anthropic')).toBeNull();
  });

  it('returns model from params', () => {
    expect(config.getProviderModel('openai')).toBe('gpt-4o');
  });

  it('returns cached models', () => {
    const cached = config.getCachedModels('openai');
    expect(cached).not.toBeNull();
    expect(cached!.models).toHaveLength(1);
    expect(cached!.models[0].id).toBe('gpt-4o');
  });

  it('returns null cached models for non-matching provider', () => {
    expect(config.getCachedModels('anthropic')).toBeNull();
  });

  it('returns model pricing', () => {
    const pricing = config.getModelPricing('openai', 'gpt-4o');
    expect(pricing).toEqual({ prompt: 2.5, completion: 10 });
  });

  it('returns null pricing for unknown model', () => {
    expect(config.getModelPricing('openai', 'gpt-3.5')).toBeNull();
  });

  it('returns reasoning enabled', () => {
    expect(config.getReasoningEnabled('gpt-4o')).toBe(false);
  });

  it('returns debug stream enabled', () => {
    expect(config.getDebugStreamEnabled()).toBe(false);
  });

  it('returns compaction enabled', () => {
    expect(config.isCompactionEnabled('openai')).toBe(true);
  });

  it('returns compaction limit', () => {
    expect(config.getCompactionLimit('openai')).toBe(80000);
  });

  it('returns context length from cached models', () => {
    expect(config.getModelContextLengthFromCache('openai', 'gpt-4o')).toBe(128000);
  });

  it('returns undefined context length for unknown model', () => {
    expect(config.getModelContextLengthFromCache('openai', 'gpt-3.5')).toBeUndefined();
  });

  it('tracks session cost', () => {
    config.updateSessionCost({ promptTokens: 100, completionTokens: 50 }, 0.01);
    config.updateSessionCost({ promptTokens: 200, completionTokens: 100 }, 0.02);
    const session = config.getCurrentSession();
    expect(session).not.toBeNull();
    expect(session!.totalCost).toBeCloseTo(0.03);
    expect(session!.requestCount).toBe(2);
  });
});
