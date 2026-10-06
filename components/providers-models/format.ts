import type { ModelRef } from '@/lib/llm/models/assignment';
import type { ProviderModel } from '@/lib/llm/providers/types';

/** Format context length as a concise string (e.g. "1M ctx", "200K ctx"). */
export function fmtCtx(length: number | undefined): string | null {
  if (!length) return null;
  if (length >= 1_000_000) {
    const val = length / 1_000_000;
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}M ctx`;
  }
  return `${Math.round(length / 1_000)}K ctx`;
}

/** Short model id — the trailing segment after any vendor prefix. */
export function modelRefLabel(ref: ModelRef | null): string {
  if (!ref) return '';
  const parts = ref.model.split('/');
  return parts[parts.length - 1] ?? ref.model;
}

/** The keys {@link fmtPrice} reads. */
export type PriceKey = 'perImage' | 'free';

/** A per-1M-token rate as the Models pane shows it. */
export function fmtRatePerMillion(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${(n).toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * A model's price as "input / output". The Models pane and the picker word a rate differently, so
 * each passes its own `formatRate`.
 */
export function fmtPrice(
  t: (key: PriceKey) => string,
  model: ProviderModel,
  formatRate: (rate: number) => string,
): string | null {
  const pricing = model.pricing;
  // Image models are billed per image, not per token — OpenRouter reports 0 token
  // rates for them, so don't show "free" (it's misleading).
  const isImageOut = !!model.outputModalities?.includes('image');
  if (!pricing) return isImageOut ? t('perImage') : null;
  if (pricing.input === 0 && pricing.output === 0) return isImageOut ? t('perImage') : t('free');
  return `${formatRate(pricing.input)} / ${formatRate(pricing.output)}`;
}
