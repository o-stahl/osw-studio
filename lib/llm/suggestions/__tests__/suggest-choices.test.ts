// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderModel } from '@/lib/llm/providers/types';

/**
 * The choices a switch makes on the user's behalf: which models are eligible (big enough, free when
 * the account or the model is free, never pricier), what a provider starts on, and which other
 * connected providers a stopped task offers.
 */

const models: Record<string, ProviderModel[]> = {};
vi.mock('@/lib/llm/models/model-catalog', () => ({
  loadProviderModels: async (p: string) => models[p] ?? [],
}));
const status = vi.fn(async (_provider: string) => ({ quota: { kind: 'none' } }) as unknown);
vi.mock('@/lib/llm/provider-status', () => ({ fetchProviderStatus: (p: string) => status(p) }));
vi.mock('../scores', () => ({
  getScores: () => ({ asOf: 'x', models: { strong: { agentic: 50 }, mid: { agentic: 20 }, weak: { agentic: 2 } } }),
  refreshScores: () => Promise.resolve(),
}));
const chosen: Record<string, string | null> = {};
vi.mock('@/lib/config/storage', () => ({
  configManager: {
    getProviderApiKey: () => 'k',
    getProviderModel: (p: string) => chosen[p] ?? null,
  },
}));
let connected: string[] = [];
vi.mock('@/lib/llm/providers/connection-status', () => ({ getConnectedProviders: () => connected }));

import { nextModelAfter, modelForProvider, alternativesTo } from '../suggest';
import { recordModelOutcome, resetCooldowns } from '../observed';
import { getDefaultModel } from '@/lib/llm/providers/registry';

const m = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({ id, name: id, contextLength: 200_000, supportsFunctions: true, ...extra });

beforeEach(() => {
  localStorage.clear();
  resetCooldowns();
  for (const key of Object.keys(models)) delete models[key];
  for (const key of Object.keys(chosen)) delete chosen[key];
  connected = [];
  status.mockReset().mockResolvedValue({ quota: { kind: 'none' } });
});

describe('nextModelAfter', () => {
  it('never suggests a model too small to hold the conversation and instructions', async () => {
    models.openrouter = [m('x/weak:free'), m('x/strong:free', { contextLength: 16_000 }), m('x/mid:free')];
    expect(await nextModelAfter({ provider: 'openrouter', model: 'x/weak:free' })).toEqual({ provider: 'openrouter', model: 'x/mid:free' });
  });

  it('treats a model the catalogue marks free as free, whatever its id', async () => {
    models.openrouter = [
      m('x/weak', { free: true }),
      m('x/strong', { pricing: { input: 1, output: 5 } }),
      m('x/mid', { pricing: { input: 0, output: 0 } }),
    ];
    expect(await nextModelAfter({ provider: 'openrouter', model: 'x/weak' })).toEqual({ provider: 'openrouter', model: 'x/mid' });
  });

  it('keeps an account that can only use free models on free ones, even from a paid model', async () => {
    status.mockResolvedValue({ quota: { kind: 'none' }, freeOnly: true });
    models.openrouter = [
      m('x/weak', { pricing: { input: 1, output: 10 } }),
      m('x/strong', { pricing: { input: 1, output: 5 } }),
      m('x/mid:free'),
    ];
    expect(await nextModelAfter({ provider: 'openrouter', model: 'x/weak' })).toEqual({ provider: 'openrouter', model: 'x/mid:free' });
  });

  it('allows a model that costs the same per output token', async () => {
    models.vercel = [
      m('x/mid', { pricing: { input: 0.5, output: 1 } }),
      m('x/strong', { pricing: { input: 0.5, output: 1 } }),
      m('x/weak', { pricing: { input: 0.1, output: 0.5 } }),
    ];
    expect(await nextModelAfter({ provider: 'vercel', model: 'x/mid' })).toEqual({ provider: 'vercel', model: 'x/strong' });
  });

  it('never switches a paid model to one whose price is unknown', async () => {
    models.vercel = [
      m('x/mid', { pricing: { input: 0.5, output: 1 } }),
      m('x/strong'),
      m('x/weak', { pricing: { input: 0.1, output: 0.5 } }),
    ];
    expect(await nextModelAfter({ provider: 'vercel', model: 'x/mid' })).toEqual({ provider: 'vercel', model: 'x/weak' });
  });
});

describe('modelForProvider', () => {
  it('keeps the model the user already chose for the provider', async () => {
    chosen.openrouter = 'my/model';
    models.openrouter = [m('x/strong:free')];
    expect(await modelForProvider('openrouter')).toEqual({ provider: 'openrouter', model: 'my/model' });
  });

  it('picks a free model for an account that can only use free ones', async () => {
    status.mockResolvedValue({ quota: { kind: 'none' }, freeOnly: true });
    models.openrouter = [m('x/strong', { pricing: { input: 1, output: 5 } }), m('x/mid:free')];
    expect(await modelForProvider('openrouter')).toEqual({ provider: 'openrouter', model: 'x/mid:free' });
  });

  it('falls back to the provider default rather than a model that is cooling down', async () => {
    models.openrouter = [m('x/strong:free')];
    recordModelOutcome('openrouter', 'x/strong:free', 'busy');
    expect(await modelForProvider('openrouter')).toEqual({ provider: 'openrouter', model: getDefaultModel('openrouter') });
  });
});

describe('alternativesTo', () => {
  it('offers the other connected providers, local ones last, and drops one that fails', async () => {
    connected = ['openrouter', 'ollama', 'vercel', 'groq'];
    chosen.openrouter = 'or/model';
    chosen.ollama = 'llama';
    chosen.groq = 'groq/model';
    status.mockImplementation(async (p: string) => {
      if (p === 'vercel') throw new Error('offline');
      return { quota: { kind: 'none' } };
    });
    expect(await alternativesTo('openrouter')).toEqual([
      { provider: 'groq', model: 'groq/model' },
      { provider: 'ollama', model: 'llama' },
    ]);
  });
});
