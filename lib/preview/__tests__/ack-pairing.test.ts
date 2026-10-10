import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AckPairer } from '../ack-pairing';

/**
 * How the preview tells its own documents from a page the frame navigated to. Each document the
 * host writes reports in by message; the iframe's load event arrives separately, in either order.
 * A load nothing reports for is an escape, and the preview recovers from it, so a miscount either
 * way is a fault: a missed escape leaves a foreign page on screen as if it were the project, a
 * false one reloads (then overlays) a preview that was fine.
 */

const TIMEOUT = 3000;
let pairer: AckPairer;
let escapes: number;
const load = () => pairer.onFrameLoad(() => { escapes += 1; });

beforeEach(() => {
  vi.useFakeTimers();
  pairer = new AckPairer(TIMEOUT);
  pairer.begin(1);
  escapes = 0;
});

afterEach(() => vi.useRealTimers());

describe('AckPairer', () => {
  it('counts a load with no ack inside the timeout as an escape, and not before', () => {
    load();
    vi.advanceTimersByTime(TIMEOUT - 1);
    expect(escapes).toBe(0);
    vi.advanceTimersByTime(1);
    expect(escapes).toBe(1);
  });

  it('pairs a load with the ack that follows it', () => {
    load();
    expect(pairer.onAck(1)).toBe(true);
    vi.advanceTimersByTime(TIMEOUT * 2);
    expect(escapes).toBe(0);
  });

  it('pairs a load with the ack that came before it', () => {
    expect(pairer.onAck(1)).toBe(true);
    load();
    vi.advanceTimersByTime(TIMEOUT * 2);
    expect(escapes).toBe(0);
  });

  it('pairs each ack with one load only', () => {
    pairer.onAck(1);
    load();
    load();
    vi.advanceTimersByTime(TIMEOUT);
    expect(escapes).toBe(1);
  });

  it("does not let an outgoing document's late ack pair with the next load", () => {
    pairer.begin(2);
    expect(pairer.onAck(1)).toBe(false);
    load();
    vi.advanceTimersByTime(TIMEOUT);
    expect(escapes).toBe(1);
  });

  it('starts every new document with nothing owed either way', () => {
    // A surplus ack from the old document is void...
    pairer.onAck(1);
    pairer.begin(2);
    load();
    vi.advanceTimersByTime(TIMEOUT);
    expect(escapes).toBe(1);

    // ...and so is a wait for the old document's ack.
    escapes = 0;
    load();
    pairer.begin(3);
    vi.advanceTimersByTime(TIMEOUT);
    expect(escapes).toBe(0);
  });

  it('stops waiting when stopped, and the ack still owed is not counted against the next load', () => {
    load();
    pairer.stop();
    vi.advanceTimersByTime(TIMEOUT);
    expect(escapes).toBe(0);

    pairer.onAck(1);
    load();
    vi.advanceTimersByTime(TIMEOUT);
    expect(escapes).toBe(1);
  });
});
