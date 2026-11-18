import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `whenFilesSynced`: what a page rendered for the server waits on, so it renders the files a pull
 * from the server is bringing rather than the ones the tab had before it.
 */

const vfs = vi.hoisted(() => ({
  fileExists: vi.fn(async () => false),
  createFile: vi.fn(async (_projectId: string, _path: string, _content: unknown, _opts?: unknown) => ({})),
  updateFile: vi.fn(async () => ({})),
  deleteFile: vi.fn(async () => undefined),
}));
vi.mock('@/lib/vfs', () => ({ vfs }));
vi.mock('@/lib/vfs/save-manager', () => ({
  saveManager: { runWithSuppressedDirty: async (_projectId: string, fn: () => Promise<void>) => fn() },
}));
vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { handleFilesChanged, whenFilesSynced } from '../file-sync-handler';

/** Each call to the files route, answered when the test says. */
let answers: { path: string; land: () => void }[] = [];

beforeEach(() => {
  answers = [];
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn((_url: string, init: { body: string }) => {
    const { paths } = JSON.parse(init.body) as { paths: string[] };
    return new Promise((resolve) => {
      answers.push({
        path: paths[0],
        land: () => resolve({ ok: true, json: async () => ({ files: [{ path: paths[0], content: 'from the server' }], deleted: [] }) }),
      });
    });
  }));
});

/** Lets every queued promise callback run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Whether `promise` has settled, read after a flush. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; });
  await flush();
  return done;
}

describe('whenFilesSynced', () => {
  it('waits for a pull under way, and settles once its files are written', async () => {
    void handleFilesChanged({ sourceProjectId: 'p-one', paths: ['/index.html'], taskId: 't1' });
    const synced = whenFilesSynced('p-one');

    expect(await settled(synced)).toBe(false);
    expect(answers).toHaveLength(1);

    answers[0].land();
    await synced;
    expect(vfs.createFile).toHaveBeenCalledWith('p-one', '/index.html', 'from the server', { silent: true });
  });

  it('waits for every pull already asked for, which run one after another', async () => {
    void handleFilesChanged({ sourceProjectId: 'p-two', paths: ['/a.html'], taskId: 't1' });
    void handleFilesChanged({ sourceProjectId: 'p-two', paths: ['/b.html'], taskId: 't2' });
    const synced = whenFilesSynced('p-two');
    await flush();
    expect(answers.map((a) => a.path)).toEqual(['/a.html']);

    answers[0].land();
    await flush();
    expect(answers.map((a) => a.path)).toEqual(['/a.html', '/b.html']);
    expect(await settled(synced)).toBe(false);

    answers[1].land();
    await synced;
    expect(vfs.createFile.mock.calls.map((call) => call[1])).toEqual(['/a.html', '/b.html']);
  });

  it('settles at once for a project with no pull asked for', async () => {
    expect(await settled(whenFilesSynced('p-untouched'))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
