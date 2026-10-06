import { describe, it, expect, vi } from 'vitest';
import { CostCalculator, PROVIDER_PRICING } from '../cost-calculator';

vi.mock('@/lib/config/storage', () => ({
  configManager: {
    getModelPricing: vi.fn().mockReturnValue(null),
  },
}));

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('CostCalculator.calculateCost', () => {
  it('calculates cost from static pricing', () => {
    const cost = CostCalculator.calculateCost(
      { promptTokens: 1000, completionTokens: 500 },
      'openai',
      'gpt-4o',
    );
    const expected = (1000 / 1_000_000) * 2.50 + (500 / 1_000_000) * 10.00;
    expect(cost).toBeCloseTo(expected);
  });

  it('treats opencode-go as zero cost (flat subscription, no per-token pricing)', () => {
    const cost = CostCalculator.calculateCost(
      { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      'opencode-go',
      'minimax-m2.7',
    );
    expect(cost).toBe(0);
  });

  it('uses reported cost when not provisional', () => {
    const cost = CostCalculator.calculateCost(
      { promptTokens: 1000, completionTokens: 500, cost: 0.05, isEstimated: false },
      'openrouter',
      'deepseek/deepseek-chat',
    );
    expect(cost).toBe(0.05);
  });

  it('falls back to computed cost when reported cost is provisional', () => {
    const cost = CostCalculator.calculateCost(
      { promptTokens: 1_000_000, completionTokens: 500_000, cost: 0, isEstimated: true },
      'openai',
      'gpt-4o',
    );
    const expected = (1_000_000 / 1_000_000) * 2.50 + (500_000 / 1_000_000) * 10.00;
    expect(cost).toBeCloseTo(expected);
  });

  it('returns zero for unknown models (ZERO_PRICING fallback)', () => {
    const cost = CostCalculator.calculateCost(
      { promptTokens: 1000, completionTokens: 1000 },
      'unknownprovider',
      'unknownmodel',
    );
    expect(cost).toBe(0);
  });

  it('accounts for reasoning tokens separately', () => {
    const cost = CostCalculator.calculateCost(
      { promptTokens: 1000, completionTokens: 600, reasoningTokens: 400 },
      'openai',
      'o1-preview',
    );
    const pricing = PROVIDER_PRICING['openai/o1-preview'];
    const promptCost = (1000 / 1_000_000) * pricing.input;
    const outputCost = (200 / 1_000_000) * pricing.output; // 600 - 400 reasoning
    const reasoningCost = (400 / 1_000_000) * pricing.reasoning!;
    expect(cost).toBeCloseTo(promptCost + outputCost + reasoningCost);
  });

  it('handles zero tokens gracefully', () => {
    const cost = CostCalculator.calculateCost(
      { promptTokens: 0, completionTokens: 0 },
      'openai',
      'gpt-4o',
    );
    expect(cost).toBe(0);
  });

  it('returns zero for local providers', () => {
    const cost = CostCalculator.calculateCost(
      { promptTokens: 10000, completionTokens: 5000 },
      'ollama',
      'llama3',
    );
    expect(cost).toBe(0);
  });
});

describe('CostCalculator.getPricing', () => {
  it('returns static pricing for known model', () => {
    const pricing = CostCalculator.getPricing('openai', 'gpt-4o');
    expect(pricing.input).toBe(2.50);
    expect(pricing.output).toBe(10.00);
  });

  it('returns zero pricing for unknown model', () => {
    const pricing = CostCalculator.getPricing('unknownprovider', 'unknownmodel');
    expect(pricing.input).toBe(0);
    expect(pricing.output).toBe(0);
  });

  it('handles openrouter model keys with slashes', () => {
    const pricing = CostCalculator.getPricing('openrouter', 'deepseek/deepseek-chat');
    expect(pricing.input).toBe(0.14);
    expect(pricing.output).toBe(0.28);
  });

  it('matches partial model names via findBestPricingMatch', () => {
    const pricing = CostCalculator.getPricing('anthropic', 'claude-3-5-sonnet-20241022');
    expect(pricing.input).toBe(3.00);
  });
});

describe('CostCalculator.estimateCost', () => {
  it('estimates input cost from text', () => {
    const text = 'hello world foo bar baz'; // 5 words → ceil(5*1.3)=7 tokens
    const cost = CostCalculator.estimateCost(text, 'openai', 'gpt-4o', true);
    // (7 / 1_000_000) * 2.50 = 0.0000175
    expect(cost).toBeCloseTo(0.0000175, 7);
  });

  it('uses output pricing when isInput=false', () => {
    const text = 'hello world';
    const inputCost = CostCalculator.estimateCost(text, 'openai', 'gpt-4o', true);
    const outputCost = CostCalculator.estimateCost(text, 'openai', 'gpt-4o', false);
    expect(outputCost).toBeGreaterThan(inputCost);
  });
});

describe('CostCalculator.updateWithGenerationApiCost', () => {
  it('updates cost and marks as non-estimated', () => {
    const original = { promptTokens: 100, completionTokens: 50, cost: 0.01, isEstimated: true, totalTokens: 150 };
    const updated = CostCalculator.updateWithGenerationApiCost(original, { total_cost: 0.025 });
    expect(updated.cost).toBe(0.025);
    expect(updated.isEstimated).toBe(false);
  });

  it('preserves original when no generation cost provided', () => {
    const original = { promptTokens: 100, completionTokens: 50, cost: 0.01, isEstimated: true, totalTokens: 150 };
    const updated = CostCalculator.updateWithGenerationApiCost(original, {});
    expect(updated.cost).toBe(0.01);
    expect(updated.isEstimated).toBe(true);
  });
});
