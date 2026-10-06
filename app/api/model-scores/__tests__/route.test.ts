import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * Benchmark and usage figures from OpenRouter's Data API, read with the caller's key and reduced
 * by `buildSnapshot`. Either endpoint failing is a 502, never a partial snapshot.
 */

const buildSnapshot = vi.fn((benchmarks: unknown, tasks: unknown, asOf: string) => ({ benchmarks, tasks, asOf }));
vi.mock('@/lib/llm/suggestions/snapshot', () => ({
  buildSnapshot: (b: unknown, t: unknown, a: string) => buildSnapshot(b, t, a),
}));

import { POST } from '../route';

const req = (body: unknown, broken = false) =>
  ({ json: async () => { if (broken) throw new SyntaxError('bad'); return body; } }) as unknown as NextRequest;

function dataApi(answers: { benchmarks?: [number, unknown]; tasks?: [number, unknown] }) {
  const fetchMock = vi.fn(async (url: unknown, _init?: RequestInit) => {
    const [status, body] = String(url).includes('benchmarks') ? answers.benchmarks ?? [200, {}] : answers.tasks ?? [200, {}];
    return new Response(JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); buildSnapshot.mockClear(); });

describe('/api/model-scores', () => {
  it('reads both Data API endpoints with the key and builds the snapshot as of the tasks\' date', async () => {
    const fetchMock = dataApi({ benchmarks: [200, { data: ['b'] }], tasks: [200, { data: { as_of: '2026-10-01' } }] });
    const res = await POST(req({ apiKey: 'sk-or-x' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ benchmarks: { data: ['b'] }, tasks: { data: { as_of: '2026-10-01' } }, asOf: '2026-10-01' });
    const urls = fetchMock.mock.calls.map((c) => String(c[0])).sort();
    expect(urls).toEqual([
      'https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis',
      'https://openrouter.ai/api/v1/classifications/task',
    ]);
    for (const call of fetchMock.mock.calls) {
      expect(((call[1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer sk-or-x');
    }
  });

  it('dates the snapshot today when the tasks carry no date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
    dataApi({ tasks: [200, { data: {} }] });
    expect((await (await POST(req({ apiKey: 'k' }))).json()).asOf).toBe('2026-10-05');
  });

  it.each([
    ['benchmarks', { benchmarks: [500, {}] as [number, unknown] }],
    ['tasks', { tasks: [429, {}] as [number, unknown] }],
  ])('answers 502 when %s fails, building nothing', async (_label, answers) => {
    dataApi(answers);
    expect((await POST(req({ apiKey: 'k' }))).status).toBe(502);
    expect(buildSnapshot).not.toHaveBeenCalled();
  });

  it('answers 502 when OpenRouter cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect((await POST(req({ apiKey: 'k' }))).status).toBe(502);
  });

  it('answers 400 without a key or with broken JSON, asking no one', async () => {
    const fetchMock = dataApi({});
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ apiKey: '' }))).status).toBe(400);
    expect((await POST(req(null, true))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
