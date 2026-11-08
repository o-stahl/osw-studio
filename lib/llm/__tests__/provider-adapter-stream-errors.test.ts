import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OswsProviderAdapter, ProviderApiError, type ProviderAdapterConfig } from '../provider-adapter';
import type { Message } from '../core/types';

vi.mock('@/lib/api/backend-status', () => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('../models-dev', () => ({ ensureModelsDevPricing: vi.fn(async () => {}) }));
vi.mock('../models-api', () => ({ fetchAvailableModels: vi.fn(async () => []) }));
vi.mock('../pricing-cache', () => ({ registerOpenRouterPricingFromApi: vi.fn(), registerPricingFromProviderModels: vi.fn() }));

import { apiFetch } from '@/lib/api/backend-status';
import { track } from '@/lib/telemetry';

/**
 * Provider errors sent inside the stream (HTTP 200): asked again when transient and nothing usable
 * arrived, and after part of the answer, a tool call still arriving is marked unfinished.
 */

const sse = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
function stream(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(c) { for (const chunk of chunks) c.enqueue(encoder.encode(chunk)); c.close(); },
  }), { status: 200 });
}

const streamError = (code: number, errorType?: string) => sse({
  error: { code, message: 'The model stopped sending.', ...(errorType ? { metadata: { error_type: errorType } } : {}) },
  choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
});
const reasoningThenError = (code: number, errorType?: string) => stream([
  sse({ choices: [{ index: 0, delta: { reasoning: 'Thinking about it' } }] }),
  streamError(code, errorType),
]);
const answer = () => stream([
  sse({ choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }] }),
  'data: [DONE]\n\n',
]);
const toolCallDelta = (index: number, id: string, args: string) =>
  sse({ choices: [{ index: 0, delta: { tool_calls: [{ index, id, type: 'function', function: { name: 'bash', arguments: args } }] } }] });

const onEvent = vi.fn();
function makeAdapter(): OswsProviderAdapter {
  const config: ProviderAdapterConfig = {
    getProviderConfig: () => ({ provider: 'openrouter', apiKey: 'k', model: 'some/model', baseUrl: undefined }),
    getApiUrl: () => 'http://localhost/api/generate',
    getReasoningEnabled: () => false,
    getDebugStreamEnabled: () => false,
    getModelPricing: () => ({ input: 0, output: 0 }) as never,
    getCachedModels: () => null,
    progress: { onEvent },
  };
  return new OswsProviderAdapter(config);
}

const messages: Message[] = [{ role: 'user', content: 'build' }];
const tools = [{ name: 'bash', description: 'run', parameters: { type: 'object', properties: {} } }] as never;

/** Runs a call to its end while the retry waits pass at once. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const caught = promise.then((v) => ({ v }), (e) => ({ e }));
  await vi.runAllTimersAsync();
  const out = await caught as { v?: T; e?: unknown };
  if ('e' in out) throw out.e;
  return out.v as T;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  vi.mocked(apiFetch).mockReset();
  vi.mocked(track).mockReset();
  onEvent.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe('a stream error before anything usable arrived', () => {
  it('is asked again when transient, and the answer that follows is used', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(reasoningThenError(504)).mockResolvedValueOnce(answer());
    const result = await settle(makeAdapter().call({ messages }));
    expect(result.content).toBe('Done.');
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledWith('retry', expect.objectContaining({ attempt: 1, status: 504 }));
  });

  it('stops after two more tries, with the error\'s own type code', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => reasoningThenError(504, 'upstream_idle'));
    const error = await settle(makeAdapter().call({ messages })).catch((e) => e);
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error).toMatchObject({ status: 504, errorType: 'midstream', errorCategory: 'midstream_error', streamErrorType: 'upstream_idle' });
  });

  it('is not asked again for a status that is not transient', async () => {
    for (const code of [503, 400, 0]) {
      vi.mocked(apiFetch).mockReset().mockImplementation(async () => reasoningThenError(code));
      const error = await settle(makeAdapter().call({ messages })).catch((e) => e);
      expect(error, String(code)).toBeInstanceOf(ProviderApiError);
      expect(apiFetch, String(code)).toHaveBeenCalledTimes(1);
    }
  });

  it('is not asked again once the run was stopped', async () => {
    const ac = new AbortController();
    vi.mocked(apiFetch).mockImplementation(async () => { ac.abort(); return reasoningThenError(504); });
    await settle(makeAdapter().call({ messages, signal: ac.signal })).catch(() => {});
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('ends at once when the run is stopped during the wait before asking again', async () => {
    const ac = new AbortController();
    vi.mocked(apiFetch).mockResolvedValueOnce(reasoningThenError(504)).mockResolvedValueOnce(answer());
    let outcome: unknown = 'pending';
    makeAdapter().call({ messages, signal: ac.signal }).then(() => { outcome = 'answered'; }, (e) => { outcome = e; });
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({ name: 'AbortError' });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps free text out of the type code', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => reasoningThenError(400, 'Something went wrong upstream'));
    const error = await settle(makeAdapter().call({ messages })).catch((e) => e);
    expect(error.streamErrorType).toBeUndefined();
  });
});

describe('a stream error after part of the answer', () => {
  it('marks only the tool call still arriving as unfinished, and records the error', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(stream([
      toolCallDelta(0, 't1', JSON.stringify({ command: 'ls /src' })),
      toolCallDelta(1, 't2', '{"command":"rm /src/app.js'),
      streamError(504, 'upstream_idle'),
    ]));
    const result = await settle(makeAdapter().call({ messages, tools }));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(result.toolCalls?.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(result.unfinishedToolCallIds).toEqual(['t2']);
    expect(result.streamError).toEqual({ status: 504, type: 'upstream_idle' });
    expect(track).toHaveBeenCalledWith('api_error', expect.objectContaining({
      error_category: 'midstream_error', status_code: 504, after_output: true, unfinished_tool_calls: 1, stream_error_type: 'upstream_idle',
    }));
  });

  it('marks nothing when every tool call had finished arriving', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(stream([
      toolCallDelta(0, 't1', JSON.stringify({ command: 'ls /src' })),
      streamError(502),
    ]));
    const result = await settle(makeAdapter().call({ messages, tools }));
    expect(result.unfinishedToolCallIds).toBeUndefined();
    expect(result.streamError).toEqual({ status: 502 });
  });

  it('leaves a stream without an error alone', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(answer());
    const result = await settle(makeAdapter().call({ messages }));
    expect(result.streamError).toBeUndefined();
    expect(track).not.toHaveBeenCalled();
  });
});

describe('a retry on the status line', () => {
  it('ends at once when the run is stopped during the wait', async () => {
    const ac = new AbortController();
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response('busy', { status: 502 })).mockResolvedValueOnce(answer());
    let outcome: unknown = 'pending';
    makeAdapter().call({ messages, signal: ac.signal }).then(() => { outcome = 'answered'; }, (e) => { outcome = e; });
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({ name: 'AbortError' });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
