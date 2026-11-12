import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

/**
 * A stopping server exits once its grace period has passed, whatever is still open. Next's own
 * SIGTERM handler closes the server and exits when the last connection ends, and an events stream
 * held by an open Server Mode tab never ends. The handlers are captured rather than triggered:
 * sending the test process a real signal would stop the test runner.
 */

type Handler = () => void;
let handlers: Map<string, Handler>;
let exit: MockInstance<typeof process.exit>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  handlers = new Map();
  vi.spyOn(process, 'once').mockImplementation(((signal: string, handler: Handler) => {
    handlers.set(signal, handler);
    return process;
  }) as never);
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('exitAfterShutdownGrace', () => {
  it('exits the grace period after SIGTERM, with the signal\'s exit code, and not before', async () => {
    const { exitAfterShutdownGrace, SHUTDOWN_GRACE_MS } = await import('../shutdown');
    exitAfterShutdownGrace();

    handlers.get('SIGTERM')!();
    vi.advanceTimersByTime(SHUTDOWN_GRACE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('does the same for SIGINT', async () => {
    const { exitAfterShutdownGrace, SHUTDOWN_GRACE_MS } = await import('../shutdown');
    exitAfterShutdownGrace();

    handlers.get('SIGINT')!();
    vi.advanceTimersByTime(SHUTDOWN_GRACE_MS);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('installs its handlers once, however often it is called', async () => {
    const { exitAfterShutdownGrace } = await import('../shutdown');
    exitAfterShutdownGrace();
    exitAfterShutdownGrace();

    expect(process.once).toHaveBeenCalledTimes(2);
  });
});
