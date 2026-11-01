// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { arrivedForDemoImport, demoOfferDecision, demoOfferOutcome, resetDemoOffer, settleDemoOffer } from '../offer';

/** The first answer between the demo-import offer and the first run stands, a wait that ran out included. */
beforeEach(() => {
  resetDemoOffer();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('the demo-import offer outcome', () => {
  it("is the offer's answer when it comes in time", async () => {
    const outcome = demoOfferOutcome(15_000);
    expect(settleDemoOffer('offered')).toBe(true);
    await expect(outcome).resolves.toBe('offered');
  });

  it('is none once the wait runs out, and an answer after that does not stand', async () => {
    const outcome = demoOfferOutcome(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(outcome).resolves.toBe('none');
    expect(settleDemoOffer('offered')).toBe(false);
    expect(demoOfferDecision()).toBe('none');
  });

  it('keeps the first answer', () => {
    expect(settleDemoOffer('none')).toBe(true);
    expect(settleDemoOffer('none')).toBe(true);
    expect(settleDemoOffer('offered')).toBe(false);
  });
});

describe("the gateway's demo-import mark", () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('is not there on an ordinary visit', () => {
    window.history.replaceState(null, '', '/w/ws-1/projects');
    expect(arrivedForDemoImport()).toBe(false);
  });

  it('still counts after the offer takes it off the address', () => {
    window.history.replaceState(null, '', '/w/ws-1/projects?demo_import=1');
    expect(arrivedForDemoImport()).toBe(true);
    window.history.replaceState(null, '', '/w/ws-1/projects');
    expect(arrivedForDemoImport()).toBe(true);
  });
});
