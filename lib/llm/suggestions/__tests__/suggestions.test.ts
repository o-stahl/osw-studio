// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { modelKey, buildSnapshot } from '../snapshot';
import { rankModels, nextSuggestion, isFreeModel } from '../rank';
import { recordModelOutcome, getObserved, isCoolingDown, resetCooldowns, BUSY_COOLDOWN_MS } from '../observed';
import type { ProviderModel } from '@/lib/llm/providers/types';

const model = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id, name: id, contextLength: 200_000, supportsFunctions: true, ...extra,
});

describe('modelKey', () => {
  it('matches one model across the ways providers spell it', () => {
    const spellings = ['qwen/qwen3.8-27b:free', 'Qwen/Qwen3.8-27B', 'alibaba/qwen3.8-27b', 'qwen/qwen3.8-27b-20260814'];
    expect(new Set(spellings.map(modelKey))).toEqual(new Set(['qwen3.8-27b']));
  });

  it('drops Vercel free and dated suffixes', () => {
    expect(modelKey('poolside/laguna-s-2.1-free')).toBe('laguna-s-2.1');
    expect(modelKey('deepseek/deepseek-v4-flash-0731')).toBe('deepseek-v4-flash');
  });
});

describe('buildSnapshot', () => {
  const benchmarks = { data: [
    { model_permaslug: 'deepseek/deepseek-v4-flash-20260423', agentic_index: 26.3, coding_index: 52 },
    { model_permaslug: 'deepseek/deepseek-v4-flash-20260731', agentic_index: 41, coding_index: 69.1 },
    { model_permaslug: 'anthropic/claude-x-20260101', agentic_index: null, coding_index: null },
  ] };
  const tasks = { data: { as_of: '2026-10-02', classifications: [
    { tag: 'code:general_impl', usage_share: 0.5, models: [{ id: 'deepseek/deepseek-v4-flash-20260731', tag_usage_share: 0.2 }] },
    { tag: 'roleplay_fiction', usage_share: 0.5, models: [{ id: 'deepseek/deepseek-v4-flash-20260731', tag_usage_share: 0.9 }] },
  ] } };

  it('keeps the newest run of a family and only coding/agent traffic for usage', () => {
    const snapshot = buildSnapshot(benchmarks, tasks, '2026-10-02');
    expect(snapshot.models['deepseek-v4-flash']).toEqual({ agentic: 41, coding: 69.1, usage: 0.1 });
    expect(snapshot.models['claude-x']).toBeUndefined();
    expect(snapshot.asOf).toBe('2026-10-02');
  });
});

describe('rankModels', () => {
  const scores = { asOf: '2026-10-02', models: {
    'qwen3.8-27b': { agentic: 45.8, coding: 68.1 },
    'nemotron-3-ultra-550b-a55b': { agentic: 20.1, coding: 49.3 },
    'gemma-4-31b-it': { agentic: 4.2, coding: 43.4 },
  } };
  const candidates = [
    { provider: 'openrouter', model: model('google/gemma-4-31b-it:free') },
    { provider: 'openrouter', model: model('poolside/laguna-s-2.1:free') },
    { provider: 'openrouter', model: model('nvidia/nemotron-3-ultra-550b-a55b:free') },
    { provider: 'openrouter', model: model('qwen/qwen3.8-27b:free') },
    { provider: 'openrouter', model: model('deepseek/deepseek-v4-flash', { pricing: { input: 0.1, output: 0.3 } }) },
    { provider: 'openrouter', model: model('liquid/no-tools:free', { supportsFunctions: false }) },
  ];

  it('orders free tool models by agent score, unscored ones after', () => {
    const ids = rankModels(candidates, { scores, freeOnly: true }).map((r) => r.model.id);
    expect(ids).toEqual([
      'qwen/qwen3.8-27b:free',
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'google/gemma-4-31b-it:free',
      'poolside/laguna-s-2.1:free',
    ]);
  });

  it('never offers a paid model on the free path, nor one without tools', () => {
    const ids = rankModels(candidates, { scores, freeOnly: true }).map((r) => r.model.id);
    expect(ids).not.toContain('deepseek/deepseek-v4-flash');
    expect(ids).not.toContain('liquid/no-tools:free');
  });

  it('leaves out models too small for the conversation and models reported down', () => {
    const ranked = rankModels([
      { provider: 'pollinations', model: model('a/small', { contextLength: 8_000 }) },
      { provider: 'pollinations', model: model('a/down', { health: 'down' }) },
      { provider: 'pollinations', model: model('a/ok') },
    ], { scores, minContext: 30_000 });
    expect(ranked.map((r) => r.model.id)).toEqual(['a/ok']);
  });

  it('moves a cooling-down model and a struggling model to the back', () => {
    const ranked = rankModels(candidates, {
      scores,
      freeOnly: true,
      coolingDown: (_p, m) => m === 'qwen/qwen3.8-27b:free',
      observed: (_p, m) => (m === 'nvidia/nemotron-3-ultra-550b-a55b:free' ? { ok: 0, fail: 3 } : undefined),
    });
    const ids = ranked.map((r) => r.model.id);
    expect(ids[0]).toBe('google/gemma-4-31b-it:free');
    expect(ids.at(-1)).toBe('qwen/qwen3.8-27b:free');
    expect(nextSuggestion(ranked, { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' })?.model.id)
      .toBe('poolside/laguna-s-2.1:free');
  });

  it('suggests nothing when the only other model is cooling down', () => {
    const ranked = rankModels(candidates.slice(0, 2), {
      scores,
      freeOnly: true,
      coolingDown: (_p, m) => m === 'poolside/laguna-s-2.1:free',
    });
    expect(nextSuggestion(ranked, { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' })).toBeUndefined();
  });
});

describe('isFreeModel', () => {
  it('reads free from the flag, the :free suffix, or zero prices', () => {
    expect(isFreeModel(model('x', { free: true }))).toBe(true);
    expect(isFreeModel(model('x:free'))).toBe(true);
    expect(isFreeModel(model('glm-4.7-flash', { pricing: { input: 0, output: 0 } }))).toBe(true);
    expect(isFreeModel(model('x'))).toBe(false);
  });
});

describe('observed outcomes', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCooldowns();
  });

  it('counts working turns and tool failures, but not busy answers', () => {
    recordModelOutcome('openrouter', 'm', 'ok');
    recordModelOutcome('openrouter', 'm', 'tool_failure');
    recordModelOutcome('openrouter', 'm', 'busy');
    expect(getObserved('openrouter', 'm')).toEqual({ ok: 1, fail: 1 });
  });

  it('cools a busy model down for a while, then lets it back', () => {
    recordModelOutcome('openrouter', 'm', 'busy', 1_000);
    expect(isCoolingDown('openrouter', 'm', 2_000)).toBe(true);
    expect(isCoolingDown('openrouter', 'm', 1_000 + BUSY_COOLDOWN_MS + 1)).toBe(false);
  });
});
