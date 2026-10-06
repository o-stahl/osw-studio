import { describe, it, expect } from 'vitest';
import { trackConnectSettling, connectSettled } from '../global-auto-assign';

/**
 * Connect handling can overlap: the load-time reconcile is still running when a sign-in return
 * connects a provider. Waiting for "the connect" has to wait for both, or a held message goes out
 * while the earlier work can still change the assignment.
 */

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('connectSettled', () => {
  it('waits for every connect still in flight, not only the latest', async () => {
    const first = deferred();
    const second = deferred();
    trackConnectSettling(first.promise);
    trackConnectSettling(second.promise);

    let settled = false;
    const waiting = connectSettled().then(() => { settled = true; });
    second.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    first.resolve();
    await waiting;
    expect(settled).toBe(true);
  });

  it('settles when a connect fails', async () => {
    const failing = deferred();
    trackConnectSettling(failing.promise);
    failing.reject(new Error('nope'));
    await expect(connectSettled()).resolves.toBeUndefined();
  });
});
