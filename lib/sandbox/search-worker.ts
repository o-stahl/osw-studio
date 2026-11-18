import { Worker } from 'node:worker_threads';
import type { LineMatcher, LineMatches } from '@/lib/vfs/shell/types';

/**
 * Line matching for `rg` and `grep` on the server, where the shell runs in the process that serves
 * every workspace. The pattern comes from whoever runs the command, and one such as `(=+)+$` takes
 * time that doubles with each character of a line it almost matches. A regular expression cannot be
 * interrupted, so the matching runs in a worker thread that is stopped at the time limit.
 *
 * Here with the app's other workers: this one runs no project code and shares no browser origin,
 * but every place that starts a worker is in this folder (`./__tests__/guard.test.ts`). It runs
 * only the matching below. Imported only by server code, so the browser never loads it; there,
 * `findLineMatches` in `lib/vfs/shell/commands/search-shared.ts` does the same work in the page.
 */

/** How long one search's matching may run before it is stopped and answered with an error. */
const SEARCH_TIME_LIMIT_MS = 5_000;

/**
 * The worker, as source: Next bundles server code, so there is no file path to start it from. It
 * selects lines exactly as `findLineMatches` does, which a test holds the two to.
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
parentPort.once('message', (job) => {
  const regex = new RegExp(job.source, job.flags);
  const every = job.only ? new RegExp(job.source, job.flags + 'g') : null;
  const found = job.texts.map((lines) => {
    const selected = [];
    for (let i = 0; i < lines.length; i++) {
      if (job.max !== null && selected.length >= job.max) break;
      if (regex.test(lines[i]) !== job.invert) selected.push(i);
    }
    if (!every) return { lines: selected };
    return {
      lines: selected,
      parts: selected.map((i) => Array.from(lines[i].matchAll(every), (match) => match[0]).filter((part) => part !== '')),
    };
  });
  parentPort.postMessage(found);
});
`;

/** A {@link LineMatcher} that matches in a worker and stops it after `limitMs`. */
export function workerLineMatcher(limitMs: number = SEARCH_TIME_LIMIT_MS): LineMatcher {
  return (job) => new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    let settled = false;
    /** The first outcome wins; the worker is stopped whichever it is. */
    const settle = (then: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      then();
    };
    const timer = setTimeout(() => settle(() => resolve({ ok: false, limitMs })), limitMs);
    worker.once('message', (found: LineMatches[]) => settle(() => resolve({ ok: true, found })));
    worker.once('error', (error) => settle(() => reject(error)));
    worker.once('exit', (code) => settle(() => reject(new Error(`the search worker stopped with exit code ${code}`))));
    worker.postMessage(job);
  });
}
