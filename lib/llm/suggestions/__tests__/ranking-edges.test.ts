// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { buildSnapshot } from '../snapshot';
import { rankModels, nextSuggestion, isFreeModel } from '../rank';
import { recordModelOutcome, getObserved, isCoolingDown, resetCooldowns, outcomeForStop, switchReason } from '../observed';
import { FREE_MODELS_ID } from '../free-models';
import type { ProviderModel } from '@/lib/llm/providers/types';

const model = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id, name: id, contextLength: 200_000, supportsFunctions: true, ...extra,
});
const noScores = { asOf: '2026-10-02', models: {} };
const ids = (ranked: Array<{ model: ProviderModel }>) => ranked.map((r) => r.model.id);

describe('rankModels filters', () => {
  it('never suggests the "Free models" entry itself', () => {
    const ranked = rankModels([
      { provider: 'openrouter', model: model(FREE_MODELS_ID, { pricing: { input: 0, output: 0 } }) },
      { provider: 'openrouter', model: model('a/m:free') },
    ], { scores: noScores, freeOnly: true });
    expect(ids(ranked)).toEqual(['a/m:free']);
  });

  it('leaves out a model that writes no text', () => {
    const ranked = rankModels([
      { provider: 'pollinations', model: model('img/only', { outputModalities: ['image'] }) },
      { provider: 'pollinations', model: model('text/and-image', { outputModalities: ['text', 'image'] }) },
    ], { scores: noScores });
    expect(ids(ranked)).toEqual(['text/and-image']);
  });

  it('does not count one failure as struggling', () => {
    const scores = { asOf: 'x', models: { 'b-strong': { agentic: 50 }, 'a-weak': { agentic: 10 } } };
    const ranked = rankModels([
      { provider: 'p', model: model('v/a-weak') },
      { provider: 'p', model: model('v/b-strong') },
    ], { scores, observed: (_p, m) => (m === 'v/b-strong' ? { ok: 0, fail: 1 } : undefined) });
    expect(ids(ranked)).toEqual(['v/b-strong', 'v/a-weak']);
  });

  it('breaks an agent-score tie by coding score, then usage, then what worked here', () => {
    // Ids chosen so alphabetical order would give the opposite answer each time.
    const coding = rankModels([
      { provider: 'p', model: model('v/a-low') },
      { provider: 'p', model: model('v/b-high') },
    ], { scores: { asOf: 'x', models: { 'a-low': { agentic: 30, coding: 40 }, 'b-high': { agentic: 30, coding: 60 } } } });
    expect(ids(coding)).toEqual(['v/b-high', 'v/a-low']);

    const usage = rankModels([
      { provider: 'p', model: model('v/a-low') },
      { provider: 'p', model: model('v/b-high') },
    ], { scores: { asOf: 'x', models: { 'a-low': { agentic: 30, coding: 50, usage: 0.01 }, 'b-high': { agentic: 30, coding: 50, usage: 0.2 } } } });
    expect(ids(usage)).toEqual(['v/b-high', 'v/a-low']);

    const seen = rankModels([
      { provider: 'p', model: model('v/a-low') },
      { provider: 'p', model: model('v/b-high') },
    ], { scores: noScores, observed: (_p, m) => (m === 'v/b-high' ? { ok: 5, fail: 0 } : { ok: 1, fail: 0 }) });
    expect(ids(seen)).toEqual(['v/b-high', 'v/a-low']);
  });
});

describe('isFreeModel prices', () => {
  it('needs both prices at zero: free input with paid output still costs', () => {
    expect(isFreeModel(model('x', { pricing: { input: 0, output: 1.5 } }))).toBe(false);
  });
});

describe('nextSuggestion', () => {
  it('offers the same model on another provider', () => {
    const ranked = rankModels([
      { provider: 'openrouter', model: model('deepseek/m') },
      { provider: 'vercel', model: model('deepseek/m') },
    ], { scores: noScores });
    const next = nextSuggestion(ranked, { provider: 'openrouter', model: 'deepseek/m' });
    expect(next).toMatchObject({ provider: 'vercel', model: { id: 'deepseek/m' } });
  });
});

describe('buildSnapshot details', () => {
  it('adds a model\'s share over every coding and agent tag, rounded to four places', () => {
    const snapshot = buildSnapshot({ data: [] }, { data: { classifications: [
      { tag: 'code:impl', usage_share: 0.5, models: [{ id: 'v/m', tag_usage_share: 0.2 }] },
      { tag: 'agent:tools', usage_share: 0.4, models: [{ id: 'v/m', tag_usage_share: 0.5 }] },
      { tag: 'code:debug', usage_share: 0.123456, models: [{ id: 'v/n', tag_usage_share: 1 }] },
    ] } }, 'd');
    expect(snapshot.models.m.usage).toBe(0.3);
    expect(snapshot.models.n.usage).toBe(0.1235);
  });

  it('skips a benchmark row with no name and carries on with the rest', () => {
    const snapshot = buildSnapshot({ data: [
      { agentic_index: 10 },
      { model_permaslug: 'v/m-20260101', agentic_index: 20 },
    ] }, {}, 'd');
    expect(snapshot.models.m).toMatchObject({ agentic: 20 });
  });

  it('ignores shares that are not numbers', () => {
    const snapshot = buildSnapshot({ data: [] }, { data: { classifications: [
      { tag: 'code:impl', usage_share: '0.5', models: [{ id: 'v/a', tag_usage_share: 0.2 }] },
      { tag: 'code:impl', usage_share: 0.5, models: [{ id: 'v/b', tag_usage_share: '0.2' }] },
    ] } }, 'd');
    expect(snapshot.models).toEqual({});
  });
});

describe('observed outcomes, the edges', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCooldowns();
  });

  it('cools down a model that was not there, and counts it against', () => {
    recordModelOutcome('openrouter', 'gone', 'unavailable', 1_000);
    expect(isCoolingDown('openrouter', 'gone', 2_000)).toBe(true);
    expect(getObserved('openrouter', 'gone')).toEqual({ ok: 0, fail: 1 });
  });

  it('treats a damaged record as empty instead of failing', () => {
    localStorage.setItem('osw-model-observed', 'null');
    expect(getObserved('openrouter', 'm')).toBeUndefined();
    localStorage.setItem('osw-model-observed', '{not json');
    expect(getObserved('openrouter', 'm')).toBeUndefined();
    recordModelOutcome('openrouter', 'm', 'ok');
    expect(getObserved('openrouter', 'm')).toEqual({ ok: 1, fail: 0 });
  });
});

/**
 * OpenRouter refuses some free models to every app not on its list ("only available on agentic
 * harnesses"). Ten minutes changes nothing about that, so a refusal is passed over for a day and
 * outlives a reload; it says nothing about how good the model is.
 */
describe('a model that refused the request', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCooldowns();
  });

  it('is passed over for a day, after a reload too, and then offered again', () => {
    const now = 1_000_000;
    recordModelOutcome('openrouter', 'gated:free', 'refused', now);
    resetCooldowns(); // a reload forgets the in-memory cooldowns
    expect(isCoolingDown('openrouter', 'gated:free', now + 23 * 60 * 60_000)).toBe(true);
    expect(isCoolingDown('openrouter', 'gated:free', now + 25 * 60 * 60_000)).toBe(false);
  });

  it('does not count against the model', () => {
    recordModelOutcome('openrouter', 'gated:free', 'refused');
    expect(getObserved('openrouter', 'gated:free')).toBeUndefined();
  });

  it('is not suggested next, so two failing models are not offered in turn', () => {
    recordModelOutcome('openrouter', 'a', 'refused');
    const ranked = ['a', 'b'].map((id) => ({ provider: 'openrouter', model: { id }, coolingDown: isCoolingDown('openrouter', id) }));
    // Stopped on b: the only other model, a, refused earlier, so nothing is offered.
    expect(nextSuggestion(ranked as never, { provider: 'openrouter', model: 'b' })).toBeUndefined();
  });
});

/** A moderation flag is about what was sent, so the model is back after a busy model's wait. */
describe('a model whose moderation flagged the request', () => {
  beforeEach(() => {
    localStorage.clear();
    resetCooldowns();
  });

  it('is passed over briefly, not for a day, and not across a reload', () => {
    const now = 1_000_000;
    recordModelOutcome('openrouter', 'strict', 'flagged', now);
    expect(isCoolingDown('openrouter', 'strict', now + 60_000)).toBe(true);
    expect(isCoolingDown('openrouter', 'strict', now + 60 * 60_000)).toBe(false);
    resetCooldowns();
    expect(isCoolingDown('openrouter', 'strict', now + 60_000)).toBe(false);
    expect(getObserved('openrouter', 'strict')).toBeUndefined();
  });

  it('comes from a blocked stop; a model refusing the app comes from model_refused', () => {
    expect(outcomeForStop('blocked')).toBe('flagged');
    expect(outcomeForStop('model_refused')).toBe('refused');
    expect(outcomeForStop('rate_limited')).toBeNull();
    // Both read as a refusal in the thread when "Free models" moves on.
    expect(switchReason('blocked')).toBe('refused');
    expect(switchReason('model_refused')).toBe('refused');
    expect(switchReason('model_busy')).toBe('busy');
  });
});
