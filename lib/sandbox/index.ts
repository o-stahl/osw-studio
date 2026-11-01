/**
 * Where project code runs.
 *
 * A project's code is not the studio's: it may come from a template, an import, another person or
 * a model. It runs only inside a frame sandboxed without `allow-same-origin`, which gives it an
 * opaque origin: it cannot read the app's storage or IndexedDB, and a request it makes to the app's
 * API goes out cross-origin, which middleware refuses (`lib/web/origin-guard.ts`). Workers count
 * too: a worker the app page starts shares the app's origin, so project scripts run in a worker
 * started inside such a frame (`./script-sandbox.ts`).
 *
 * `lib/sandbox/__tests__/guard.test.ts` fails on a `Worker`, `SharedWorker` or iframe created
 * anywhere else, so a new place that runs project code has to come through here.
 */

/** HTML pages: the live preview. Forms submit, as a page expects. */
export const PREVIEW_SANDBOX = 'allow-scripts allow-forms';

/** Everything else that runs project code: thumbnails, captures, the script runner. */
export const PROJECT_SANDBOX = 'allow-scripts';

/** A detached iframe, sandboxed. The caller styles it and puts it in the document. */
export function createSandboxedFrame(sandbox: typeof PREVIEW_SANDBOX | typeof PROJECT_SANDBOX = PROJECT_SANDBOX): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', sandbox);
  return frame;
}
