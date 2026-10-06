/**
 * Cost Calculator for LLM API Usage
 * All prices are in USD per million tokens
 */

import { ProviderId } from './providers/types';
import { UsageInfo } from './types';
import { configManager, type ProviderPricingEntry } from '@/lib/config/storage';
import { getCustomProviders } from './providers/custom-providers';
import { logger } from '@/lib/utils';

export const PROVIDER_PRICING: Record<string, { input: number; output: number; reasoning?: number }> = {
  'openrouter/deepseek/deepseek-chat': { input: 0.14, output: 0.28 },
  'openrouter/deepseek/deepseek-reasoner': { input: 0.55, output: 2.19, reasoning: 5.50 },
  'openrouter/anthropic/claude-3-5-sonnet': { input: 3.00, output: 15.00 },
  'openrouter/anthropic/claude-3-5-haiku': { input: 1.00, output: 5.00 },
  'openrouter/openai/gpt-4o': { input: 2.50, output: 10.00 },
  'openrouter/openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
  'openrouter/meta-llama/llama-3.3-70b-instruct': { input: 0.88, output: 0.88 },
  'openrouter/qwen/qwen-2.5-72b-instruct': { input: 0.35, output: 0.40 },
  
  'openai/gpt-4o': { input: 2.50, output: 10.00 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },
  'openai/gpt-4-turbo': { input: 10.00, output: 30.00 },
  'openai/gpt-3.5-turbo': { input: 0.50, output: 1.50 },
  'openai/o1-preview': { input: 15.00, output: 60.00, reasoning: 60.00 },
  'openai/o1-mini': { input: 3.00, output: 12.00, reasoning: 12.00 },
  
  'anthropic/claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'anthropic/claude-3-5-haiku-20241022': { input: 1.00, output: 5.00 },
  'anthropic/claude-3-opus-20240229': { input: 15.00, output: 75.00 },
  'anthropic/claude-3-sonnet-20240229': { input: 3.00, output: 15.00 },
  'anthropic/claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  
  'gemini/gemini-1.5-pro': { input: 1.25, output: 5.00 },
  'gemini/gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'gemini/gemini-1.5-flash-8b': { input: 0.0375, output: 0.15 },
  
  'groq/llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'groq/llama-3.3-70b-specdec': { input: 0.59, output: 0.99 },
  'groq/llama-3.2-90b-text-preview': { input: 0.90, output: 0.90 },
  'groq/mixtral-8x7b-32768': { input: 0.24, output: 0.24 },
  
  'fireworks/llama-v3p3-70b-instruct': { input: 0.90, output: 0.90 },
  'fireworks/llama-v3p1-405b-instruct': { input: 3.00, output: 3.00 },
  'fireworks/qwen2p5-72b-instruct': { input: 0.90, output: 0.90 },
  
  'together/meta-llama/Llama-3.3-70B-Instruct-Turbo': { input: 0.88, output: 0.88 },
  'together/meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo': { input: 3.50, output: 3.50 },
  'together/Qwen/Qwen2.5-72B-Instruct-Turbo': { input: 1.20, output: 1.20 },
  
  'sambanova/Meta-Llama-3.3-70B-Instruct': { input: 0.60, output: 0.60 },
  'sambanova/Meta-Llama-3.1-405B-Instruct': { input: 3.00, output: 3.00 },
  'sambanova/Qwen2.5-72B-Instruct': { input: 0.60, output: 0.60 },
  
  'hyperbolic/meta-llama/Llama-3.3-70B-Instruct': { input: 0.80, output: 0.80 },
  'hyperbolic/Qwen/Qwen2.5-72B-Instruct': { input: 0.80, output: 0.80 },
  
  'nebius/llama-3.3-70b': { input: 0.80, output: 0.80 },
  'nebius/qwen2.5-72b': { input: 0.80, output: 0.80 },
  
  'ollama/local': { input: 0, output: 0 },
  'lmstudio/local': { input: 0, output: 0 },
};

const ZERO_PRICING = { input: 0, output: 0 };
const MIN_MEANINGFUL_COST = 0.000001;

export class CostCalculator {
  /**
   * Calculate cost based on token usage and provider/model
   * Prioritizes actual costs from providers over manual calculations
   */
  static calculateCost(
    usage: Partial<UsageInfo>,
    provider: ProviderId | string,
    model: string,
    isRealUsageData: boolean = false
  ): number {
    const reportedCost = typeof usage.cost === 'number' && Number.isFinite(usage.cost)
      ? usage.cost
      : undefined;
    const headerIsProvisional =
      usage.isEstimated === true ||
      reportedCost === undefined ||
      reportedCost < MIN_MEANINGFUL_COST;

    const pricingKey = this.getPricingKey(provider, model);
    const dynamicPricing = this.getDynamicPricing(provider, model);
    const staticPricing = PROVIDER_PRICING[pricingKey];
    const pricing = dynamicPricing || staticPricing || this.findBestPricingMatch(provider, model);

    let computedCost = 0;

    const promptTokens = Math.max(usage.promptTokens ?? 0, 0);
    if (promptTokens) {
      computedCost += (promptTokens / 1_000_000) * pricing.input;
    }

    const completionTokens = Math.max(usage.completionTokens ?? 0, 0);
    let outputTokens = completionTokens;
    if (usage.reasoningTokens) {
      outputTokens = Math.max(outputTokens - Math.max(usage.reasoningTokens, 0), 0);
    }

    if (outputTokens) {
      computedCost += (outputTokens / 1_000_000) * pricing.output;
    }

    if (usage.reasoningTokens && pricing.reasoning) {
      computedCost += (usage.reasoningTokens / 1_000_000) * pricing.reasoning;
    }

    let finalCost: number;
    const usageInfo = usage as UsageInfo;

    if (!headerIsProvisional && reportedCost !== undefined) {
      finalCost = reportedCost;
      usageInfo.isEstimated = false;
    } else {
      finalCost = Math.max(computedCost, reportedCost ?? 0);
      usageInfo.isEstimated = !isRealUsageData || headerIsProvisional;

      if (reportedCost !== undefined && reportedCost > finalCost) {
        finalCost = reportedCost;
      }

      if (reportedCost !== undefined && Math.abs(finalCost - reportedCost) > 0.0001) {
        logger.debug('[CostCalculator] Adjusted provisional cost', {
          provider,
          model,
          reportedCost,
          computedCost,
          finalCost
        });
      }
    }

    return finalCost;
  }
  
  /**
   * Get pricing key for a provider/model combination
   */
  private static getPricingKey(provider: string, model: string): string {
    if (provider === 'openrouter' && model.includes('/')) {
      return `openrouter/${model}`;
    }
    
    return `${provider}/${model}`;
  }

  /**
   * Find best matching pricing for a model
   */
  private static findBestPricingMatch(provider: string, model: string): { input: number; output: number; reasoning?: number } {
    const searchKey = `${provider}/`;

    for (const [key, pricing] of Object.entries(PROVIDER_PRICING)) {
      if (key.startsWith(searchKey)) {
        const modelPart = key.substring(searchKey.length);
        if (model.includes(modelPart) || modelPart.includes(model)) {
          return pricing;
        }
      }
    }

    return ZERO_PRICING;
  }

  private static getDynamicPricing(provider: string, model: string): ProviderPricingEntry | null {
    if (!this.isKnownProvider(provider)) {
      return null;
    }

    try {
      return configManager.getModelPricing(provider, model);
    } catch (error) {
      logger.debug('[CostCalculator] Failed to read dynamic pricing', { provider, model, error });
      return null;
    }
  }

  private static isKnownProvider(provider: string): provider is ProviderId {
    const builtIn =
      provider === 'openrouter' ||
      provider === 'openai' ||
      provider === 'openai-codex' ||
      provider === 'anthropic' ||
      provider === 'groq' ||
      provider === 'gemini' ||
      provider === 'huggingface' ||
      provider === 'ollama' ||
      provider === 'lmstudio' ||
      provider === 'llamacpp' ||
      provider === 'meshllm' ||
      provider === 'sambanova' ||
      provider === 'deepseek' ||
      provider === 'zhipu' ||
      provider === 'minimax' ||
      provider === 'opencode-go' ||
      provider === 'pollinations' ||
      provider === 'vercel';
    if (builtIn) return true;
    return !!getCustomProviders()[provider];
  }
  
  /**
   * Get pricing info for a specific model
   */
  static getPricing(provider: string, model: string): { input: number; output: number; reasoning?: number } {
    const pricingKey = this.getPricingKey(provider, model);
    return PROVIDER_PRICING[pricingKey] || this.findBestPricingMatch(provider, model);
  }
  
  /**
   * Estimate cost for a text prompt (rough estimation)
   */
  static estimateCost(
    text: string,
    provider: ProviderId | string,
    model: string,
    isInput: boolean = true
  ): number {
    const wordCount = text.split(/\s+/).length;
    const estimatedTokens = Math.ceil(wordCount * 1.3);
    
    const pricing = this.getPricing(provider, model);
    const rate = isInput ? pricing.input : pricing.output;
    
    return (estimatedTokens / 1_000_000) * rate;
  }
  
  /**
   * Update usage info with accurate cost from Generation API
   */
  static updateWithGenerationApiCost(
    originalUsage: UsageInfo,
    generationUsage: { total_cost?: number; native_tokens_total?: number; native_tokens_prompt?: number; native_tokens_completion?: number }
  ): UsageInfo {
    const updated = { ...originalUsage };
    
    if (generationUsage.total_cost !== undefined) {
      updated.cost = generationUsage.total_cost;
      updated.isEstimated = false;
      
      if (originalUsage.cost && Math.abs(originalUsage.cost - generationUsage.total_cost) > 0.0001) {
        logger.debug(`[CostCalculator] Cost corrected: ${originalUsage.cost?.toFixed(4)} -> ${generationUsage.total_cost.toFixed(4)} (${((generationUsage.total_cost - originalUsage.cost) / originalUsage.cost * 100).toFixed(1)}% difference)`);
      }
    }
    
    // Optionally update token counts with native counts for future reference
    if (generationUsage.native_tokens_total !== undefined) {
      // Store native token counts for analysis
      (updated as any).nativeTokens = {
        total: generationUsage.native_tokens_total,
        prompt: generationUsage.native_tokens_prompt,
        completion: generationUsage.native_tokens_completion
      };
    }
    
    return updated;
  }
}
