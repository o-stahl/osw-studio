import { describe, it, expect } from 'vitest';
import { executeFunction } from '@/lib/edge-functions/executor';

/**
 * The error a call reports, which the function logs keep and the scheduler records as the run's
 * outcome. The function's code runs in a wrapper that turns anything it throws into
 * `Response.error`, so a throw arrives as an error response; its message is the call's error, as is
 * the message a function gives `Response.error` itself. A response the function chose, error status
 * or not, reports none.
 */

const deploymentDb = {
  query: () => [], run: () => ({}), all: () => [], exec: () => {},
  listServerFunctions: () => [],
  listSecretsWithValues: () => [],
} as never;
const request = { method: 'GET', path: '/t', headers: {}, query: {}, body: null } as never;
const run = (code: string) =>
  executeFunction({ id: 'f1', name: 't', method: 'GET', code, timeoutMs: 5000, enabled: true } as never, request, deploymentDb);

describe('the error a call reports', () => {
  it('is the message of what the function threw', async () => {
    const result = await run("throw new TypeError('cart.total is not a function');");
    expect(result.response.status).toBe(500);
    expect(result.error).toBe('cart.total is not a function');
  });

  it('is the message the function gave Response.error', async () => {
    const result = await run("Response.error('Missing API key', 502);");
    expect(result.response.status).toBe(502);
    expect(result.error).toBe('Missing API key');
  });

  it('is what the function gave Response.error as JSON, when that is not a string', async () => {
    const result = await run("Response.error({ code: 'quota', remaining: 0 }, 429);");
    expect(result.response.status).toBe(429);
    expect(result.error).toBe('{"code":"quota","remaining":0}');
  });

  it('is absent from a response the function chose, error status or not', async () => {
    expect((await run('Response.json({ ok: true });')).error).toBeUndefined();
    const missing = await run('Response.json({ missing: true }, 404);');
    expect(missing.response.status).toBe(404);
    expect(missing.error).toBeUndefined();
  });
});
