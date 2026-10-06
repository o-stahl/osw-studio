// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderModel } from '@/lib/llm/providers/types';

const models: Record<string, ProviderModel[]> = {};
vi.mock('@/lib/llm/models/model-catalog', () => ({
  loadProviderModels: async (p: string) => models[p] ?? [],
}));
const status = vi.fn(async () => ({ quota: { kind: 'none' } }) as unknown);
vi.mock('@/lib/llm/provider-status', () => ({ fetchProviderStatus: () => status() }));
vi.mock('../scores', () => ({
  getScores: () => ({ asOf: 'x', models: { strong: { agentic: 50 }, mid: { agentic: 20 }, weak: { agentic: 2 } } }),
  refreshScores: () => Promise.resolve(),
}));

import { nextModelAfter } from '../suggest';
import { resetCooldowns } from '../observed';

const m = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({ id, name: id, contextLength: 200_000, supportsFunctions: true, ...extra });

beforeEach(() => {
  localStorage.clear();
  resetCooldowns();
});

describe('nextModelAfter', () => {
  it('stays on free models after a free one was busy', async () => {
    models.openrouter = [m('x/weak:free'), m('x/mid:free'), m('x/strong', { pricing: { input: 1, output: 5 } })];
    expect(await nextModelAfter({ provider: 'openrouter', model: 'x/weak:free' })).toEqual({ provider: 'openrouter', model: 'x/mid:free' });
  });

  it('never moves a paid model to a pricier one', async () => {
    models.vercel = [
      m('x/mid', { pricing: { input: 0.5, output: 1 } }),
      m('x/strong', { pricing: { input: 5, output: 25 } }),
      m('x/weak', { pricing: { input: 0.1, output: 0.5 } }),
    ];
    expect(await nextModelAfter({ provider: 'vercel', model: 'x/mid' })).toEqual({ provider: 'vercel', model: 'x/weak' });
  });

  it('does not switch away from a model whose price it does not know', async () => {
    models.groq = [m('x/mid'), m('x/strong', { pricing: { input: 0, output: 0.1 } })];
    expect(await nextModelAfter({ provider: 'groq', model: 'x/mid' })).toBeUndefined();
  });
});
