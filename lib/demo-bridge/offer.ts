/**
 * On the landing the gateway marks with `?demo_import=1`, two things want the first visit: the
 * demo-import offer (components/demo-import) and a new workspace's first run, which opens a starter
 * project (components/page-wrapper). The offer decides first, and the first run makes no starter project
 * when the visitor was asked about the demo's projects. The first answer stands: once the first run has
 * stopped waiting, the offer stays away.
 */

export type DemoOfferOutcome = 'offered' | 'none';

/** How long the first run waits for the offer's answer before going ahead without it. */
export const DEMO_OFFER_WAIT_MS = 15_000;

let arrived: boolean | null = null;
let decided: DemoOfferOutcome | null = null;
let outcome: Promise<DemoOfferOutcome> | null = null;
let settle: ((result: DemoOfferOutcome) => void) | null = null;

/** Whether this page load came with the gateway's mark, as it was before the offer took it off. */
export function arrivedForDemoImport(): boolean {
  arrived ??= new URLSearchParams(window.location.search).get('demo_import') === '1';
  return arrived;
}

function pending(): Promise<DemoOfferOutcome> {
  outcome ??= new Promise((resolve) => { settle = resolve; });
  return outcome;
}

/** The offer says whether it asks. True when that answer stands; false when a different one already does. */
export function settleDemoOffer(result: DemoOfferOutcome): boolean {
  if (decided) return decided === result;
  decided = result;
  void pending();
  settle?.(result);
  settle = null;
  return true;
}

/** What the offer decided, or `none` when it has not within `timeoutMs`, which then stands. */
export function demoOfferOutcome(timeoutMs = DEMO_OFFER_WAIT_MS): Promise<DemoOfferOutcome> {
  const timer = setTimeout(() => settleDemoOffer('none'), timeoutMs);
  return pending().finally(() => clearTimeout(timer));
}

/** The answer so far, or null. For tests. */
export function demoOfferDecision(): DemoOfferOutcome | null {
  return decided;
}

/** Forget this page load's landing and answer. For tests. */
export function resetDemoOffer(): void {
  arrived = null;
  decided = null;
  outcome = null;
  settle = null;
}
