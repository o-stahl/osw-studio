import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * `fetch` as project code in the script worker sees it. Pyodide raises a rejected promise in Python
 * only when the value has a `stack` (or is a DOMException); WebKit's network errors have none, and a
 * coroutine awaiting one never resumes. Pyodide itself needs a browser and is not run here; this
 * covers the worker's side.
 */
const SOURCE = readFileSync(path.resolve(__dirname, '../../../public/workers/script-worker.js'), 'utf8');

type Fetch = (input: unknown, init?: unknown) => Promise<unknown>;

/** Runs the worker's top level against a stand-in global scope and returns the fetch it leaves there. */
function workerFetch(nativeFetch: Fetch): Fetch {
  const scope: Record<string, unknown> = { fetch: nativeFetch, postMessage: () => {} };
  new Function('self', SOURCE)(scope);
  return scope.fetch as Fetch;
}

/** What a request failed with. */
async function rejection(request: Promise<unknown>): Promise<Error & { cause?: unknown }> {
  try {
    await request;
  } catch (err) {
    return err as Error & { cause?: unknown };
  }
  throw new Error('the request did not fail');
}

/** An error the way WebKit's network layer makes one: no `stack` at all. */
function stackless<T extends object>(err: T): T {
  delete (err as { stack?: string }).stack;
  expect('stack' in err).toBe(false);
  return err;
}

describe('script worker fetch', () => {
  it('rejects a failed request with an error Pyodide raises in Python: name, message and a stack', async () => {
    const webkit = stackless(new TypeError('Load failed'));
    const fetch = workerFetch(() => Promise.reject(webkit));
    const err = await rejection(fetch('https://example.invalid/'));
    expect(err).not.toBe(webkit);
    expect(err.name).toBe('TypeError');
    expect(err.message).toBe('Load failed');
    expect(typeof err.stack).toBe('string');
    expect(err.cause).toBe(webkit);
  });

  it('does the same for a rejection that is not an object', async () => {
    const fetch = workerFetch(() => Promise.reject('offline'));
    const err = await rejection(fetch('https://example.com/'));
    expect(err.name).toBe('TypeError');
    expect(err.message).toBe('offline');
    expect(typeof err.stack).toBe('string');
  });

  it('leaves errors Pyodide already raises as they are, aborts included', async () => {
    for (const original of [new TypeError('Failed to fetch'), stackless(new DOMException('aborted', 'AbortError'))]) {
      const fetch = workerFetch(() => Promise.reject(original));
      await expect(fetch('https://example.com/')).rejects.toBe(original);
    }
  });

  it('passes the request through and the response back', async () => {
    const response = { ok: true };
    const native = vi.fn(async () => response);
    const fetch = workerFetch(native);
    const init = { method: 'POST' };
    await expect(fetch('https://example.com/api', init)).resolves.toBe(response);
    expect(native).toHaveBeenCalledWith('https://example.com/api', init);
  });
});
