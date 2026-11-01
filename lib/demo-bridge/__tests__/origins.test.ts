import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as origins from '../origins';

const { bridgeOrigins } = origins;

/** The instance origins the demo's bridge answers come from the gateway, exactly, or not at all. */
beforeEach(() => origins.resetBridgeOrigins());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const answering = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('bridgeOrigins', () => {
  it("asks the demo's gateway, and keeps exact origins only", async () => {
    vi.stubEnv('DEMO_GATEWAY_URL', 'https://gateway.example.com');
    const fetchFn = answering({ origins: ['https://inst-1.example.com', 'https://inst-2.example.com/w/x', 'not a url', 7] });

    expect(await bridgeOrigins(fetchFn)).toEqual(['https://inst-1.example.com', 'https://inst-2.example.com']);
    expect((fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe('https://gateway.example.com/api/demo/bridge-origins');
  });

  it('answers nobody when the gateway fails, says no, or is not there', async () => {
    vi.stubEnv('DEMO_GATEWAY_URL', 'https://gateway.example.com');
    expect(await bridgeOrigins(answering({ error: 'down' }, 503))).toEqual([]);
    origins.resetBridgeOrigins();
    expect(await bridgeOrigins(vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toEqual([]);
    origins.resetBridgeOrigins();
    expect(await bridgeOrigins(answering({ origins: 'https://inst-1.example.com' }))).toEqual([]);

    // Without the kept empty answer, so the missing gateway is what turns it away.
    origins.resetBridgeOrigins();
    vi.stubEnv('DEMO_GATEWAY_URL', '');
    const untouched = answering({ origins: ['https://inst-1.example.com'] });
    expect(await bridgeOrigins(untouched)).toEqual([]);
    expect(untouched).not.toHaveBeenCalled();
  });

  it('keeps an answer for five minutes, and asks again half a minute after none', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-27T12:00:00Z'));
    vi.stubEnv('DEMO_GATEWAY_URL', 'https://gateway.example.com');
    const fetchFn = answering({ origins: ['https://inst-1.example.com'] });
    const calls = () => (fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    await Promise.all([bridgeOrigins(fetchFn), bridgeOrigins(fetchFn)]);
    vi.setSystemTime(Date.parse('2026-10-27T12:04:59Z'));
    expect(await bridgeOrigins(fetchFn)).toEqual(['https://inst-1.example.com']);
    expect(calls()).toBe(1);
    vi.setSystemTime(Date.parse('2026-10-27T12:05:00Z'));
    await bridgeOrigins(fetchFn);
    expect(calls()).toBe(2);

    const down = answering({ error: 'down' }, 503);
    vi.setSystemTime(Date.parse('2026-10-27T12:10:00Z'));
    expect(await bridgeOrigins(down)).toEqual([]);
    vi.setSystemTime(Date.parse('2026-10-27T12:10:29Z'));
    expect(await bridgeOrigins(fetchFn)).toEqual([]);
    vi.setSystemTime(Date.parse('2026-10-27T12:10:30Z'));
    expect(await bridgeOrigins(fetchFn)).toEqual(['https://inst-1.example.com']);
    expect(calls()).toBe(3);
  });
});
