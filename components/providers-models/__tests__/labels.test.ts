import { describe, it, expect } from 'vitest';
import { fmtPrice, fmtRatePerMillion } from '../format';
import { formatModelPrice } from '@/lib/llm/models-api';
import { slotLabel } from '../templates-pane';
import type { ProviderModel } from '@/lib/llm/providers/types';

/** The model price and slot labels in Models, the model picker and Templates. */
const t = (key: string) => `<${key}>`;
const model = (pricing?: { input: number; output: number }, image = false) =>
  ({ id: 'm', name: 'M', pricing, outputModalities: image ? ['image'] : ['text'] }) as unknown as ProviderModel;

describe.each([
  ['per million', fmtRatePerMillion],
  ['per thousand', formatModelPrice],
])('price %s', (_rate, formatRate) => {
  const fmt = (m: ProviderModel) => fmtPrice(t, m, formatRate);
  it('calls a zero-rate text model free', () => {
    expect(fmt(model({ input: 0, output: 0 }))).toBe('<free>');
  });

  it('bills an image model per image, never free, priced or not', () => {
    expect(fmt(model({ input: 0, output: 0 }, true))).toBe('<perImage>');
    expect(fmt(model(undefined, true))).toBe('<perImage>');
  });

  it('shows nothing for a text model with no pricing', () => {
    expect(fmt(model(undefined))).toBeNull();
  });

  it('shows input and output rates for a paid model', () => {
    const price = fmt(model({ input: 3, output: 15 }));
    expect(price).toMatch(/^\$.+ \/ \$.+$/);
    expect(price).not.toBe('<free>');
  });
});

describe('the rates each list shows', () => {
  // The Models pane shows a rate per million tokens, the picker per thousand.
  const paid = model({ input: 3, output: 15 });

  it('words a per-million rate', () => {
    expect(fmtPrice(t, paid, fmtRatePerMillion)).toBe('$3.00 / $15.00');
    expect(fmtPrice(t, model({ input: 0.005, output: 0.2 }), fmtRatePerMillion)).toBe('$0.0050 / $0.20');
    expect(fmtPrice(t, model({ input: 0, output: 5 }), fmtRatePerMillion)).toBe('$0 / $5.00');
  });

  it('words a per-thousand rate', () => {
    expect(fmtPrice(t, paid, formatModelPrice)).toBe('$0.003 / $0.015');
    expect(fmtPrice(t, model({ input: 0, output: 5 }), formatModelPrice)).toBe('free / $0.005');
  });

  it('formats the input rate first', () => {
    expect(fmtPrice(t, model({ input: 1, output: 2 }), fmtRatePerMillion)).toBe('$1.00 / $2.00');
  });
});

describe('slotLabel', () => {
  it('words the special values', () => {
    expect(slotLabel(t, null)).toBe('<slotNone>');
    expect(slotLabel(t, 'agent')).toBe('<slotReuseAgent>');
    expect(slotLabel(t, 'browser')).toBe('<slotBrowser>');
  });

  it('shortens a model to its last path part', () => {
    expect(slotLabel(t, { provider: 'openrouter', model: 'anthropic/claude-sonnet' } as never)).toBe('claude-sonnet');
    expect(slotLabel(t, { provider: 'ollama', model: 'llama3' } as never)).toBe('llama3');
  });
});
