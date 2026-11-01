// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OswsProviderAdapter, ProviderApiError, type ProviderAdapterConfig } from '../provider-adapter';
import type { Message } from '../core/types';

/**
 * The free allowance on the demo: the adapter sends no key (the server adds a token for the trial
 * session in this browser's cookie). When the server asks for a session, it runs the check once and
 * retries the request once; when it cannot get a session, the chat shows the matching stop. The
 * project id goes along for the allowance only.
 */
vi.mock('@/lib/api/backend-status', () => ({ apiFetch: vi.fn() }));
vi.mock('../models-dev', () => ({ ensureModelsDevPricing: vi.fn(async () => {}) }));
vi.mock('../models-api', () => ({ fetchAvailableModels: vi.fn(async () => []) }));
vi.mock('../pricing-cache', () => ({ registerOpenRouterPricingFromApi: vi.fn(), registerPricingFromProviderModels: vi.fn() }));

const trial = vi.hoisted(() => ({ start: vi.fn(), started: 0, Err: class extends Error { constructor(readonly failure: string, readonly resetAt?: number) { super(failure); } } }));
vi.mock('@/lib/inference/trial-check', () => ({
  startTrialSession: (signal?: AbortSignal) => trial.start(signal),
  trialSessionsStarted: () => trial.started,
  TrialCheckError: trial.Err,
}));

import { apiFetch } from '@/lib/api/backend-status';
import { ensureModelsDevPricing } from '../models-dev';

const messages: Message[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];

function adapter(provider = 'osws', extra: Partial<ProviderAdapterConfig> = {}): OswsProviderAdapter {
  const config: ProviderAdapterConfig = {
    getProviderConfig: () => ({ provider, apiKey: provider === 'osws' ? '' : 'k', model: provider === 'osws' ? 'osws/agent' : 'm' }),
    getApiUrl: () => 'http://localhost/api/generate',
    getReasoningEnabled: () => false,
    getDebugStreamEnabled: () => false,
    getModelPricing: () => ({}),
    getCachedModels: () => null,
    getSessionId: () => 'project-1',
    progress: { onEvent: vi.fn() },
    ...extra,
  };
  return new OswsProviderAdapter(config);
}

const okResponse = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
const sessionNeeded = () => new Response(JSON.stringify({ error: 'OSW Studio inference needs a new check.', code: 'trial_session' }), { status: 401 });
const bodies = () => vi.mocked(apiFetch).mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));

beforeEach(() => {
  document.documentElement.dataset.demoGateway = 'https://gateway.oswstudio.com';
  vi.mocked(apiFetch).mockReset();
  trial.start.mockReset();
  trial.start.mockResolvedValue(undefined);
  trial.started = 0;
});
afterEach(() => { delete document.documentElement.dataset.demoGateway; });

describe('the free allowance on the demo', () => {
  it('fetches no price list for the allowance, which costs nothing', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => okResponse());
    vi.mocked(ensureModelsDevPricing).mockClear();
    // As in the app: no price is kept for the allowance's model.
    await adapter('osws', { getModelPricing: () => null }).call({ messages });
    expect(ensureModelsDevPricing).not.toHaveBeenCalled();
  });

  it('sends no key, and the project id for the allowance only', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => okResponse());
    await adapter().call({ messages });
    expect(bodies()[0]).toMatchObject({ provider: 'osws', apiKey: '', sessionId: 'project-1' });
    expect(trial.start).not.toHaveBeenCalled();

    await adapter('openrouter').call({ messages });
    expect(bodies()[1].sessionId).toBeUndefined();
  });

  it('runs the check when the server asks for a session, and sends the request again once', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(sessionNeeded()).mockResolvedValueOnce(okResponse());
    await adapter().call({ messages });
    expect(trial.start).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(bodies()[1]).toEqual(bodies()[0]);
  });

  it('sends the request again without a new check when a parallel request started a session meanwhile', async () => {
    // Its answer was on its way while another request's check set a new session cookie.
    vi.mocked(apiFetch)
      .mockImplementationOnce(async () => { trial.started++; return sessionNeeded(); })
      .mockResolvedValueOnce(okResponse());
    await adapter().call({ messages });
    expect(trial.start).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('stops after the one retry when the server still has no session', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => sessionNeeded());
    const err = await adapter().call({ messages }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ProviderApiError);
    expect(err.errorCategory).toBe('auth_expired');
    expect(trial.start).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('runs no check for any other refusal', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ error: 'no', code: 'auth' }), { status: 401 }));
    await adapter().call({ messages }).then(() => null, (e) => e);
    expect(trial.start).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['trial_limit', 'daily_limit', 1_800_000_000_000],
    ['check_failed', 'auth_expired', undefined],
    ['unavailable', 'model_not_found', undefined],
  ])('turns a %s check into the %s stop without sending the request again', async (failure, category, resetAt) => {
    vi.mocked(apiFetch).mockImplementation(async () => sessionNeeded());
    trial.start.mockRejectedValue(new trial.Err(failure as string, resetAt as number | undefined));
    const err = await adapter().call({ messages }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ProviderApiError);
    expect(err.errorCategory).toBe(category);
    expect(err.provider).toBe('osws');
    expect(err.timing.resetAt).toBe(resetAt);
    expect(trial.start).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("sends a server-side run's own headers with each request", async () => {
    delete document.documentElement.dataset.demoGateway;
    vi.mocked(apiFetch).mockImplementation(async () => okResponse());
    await adapter('osws', { getRequestHeaders: () => ({ 'x-run': 'this run' }) }).call({ messages });
    const headers = new Headers((vi.mocked(apiFetch).mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('x-run')).toBe('this run');
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('stops, as any request does, when stopped during the check', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => sessionNeeded());
    trial.start.mockImplementation((signal?: AbortSignal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason));
    }));
    const stop = new AbortController();
    const calling = adapter().call({ messages, signal: stop.signal }).then(() => null, (e) => e);
    await vi.waitFor(() => expect(trial.start).toHaveBeenCalledWith(stop.signal));
    stop.abort();
    const err = await calling;
    expect(err).not.toBeInstanceOf(ProviderApiError);
    expect(err).toMatchObject({ name: 'AbortError' });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("tells apiFetch that /api/generate relays other servers' answers", async () => {
    vi.mocked(apiFetch).mockImplementation(async () => okResponse());
    await adapter().call({ messages });
    expect(vi.mocked(apiFetch).mock.calls[0][2]).toEqual({ relaysUpstream: true });
  });

  it('runs no check off the demo, where a hosted server adds its own token', async () => {
    delete document.documentElement.dataset.demoGateway;
    vi.mocked(apiFetch).mockImplementation(async () => sessionNeeded());
    await adapter().call({ messages }).then(() => null, (e) => e);
    expect(trial.start).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
