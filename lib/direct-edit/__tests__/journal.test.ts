import { describe, it, expect } from 'vitest';
import { EditJournal, newestHistory, type JournalFiles } from '../journal';

/** The project's files in memory, with a log of what the journal wrote. */
function memory(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  const log: string[] = [];
  let failOn: string | null = null;
  const store: JournalFiles = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content, silent) => {
      if (path === failOn) throw new Error('disk full');
      files.set(path, content);
      log.push(`${silent ? 'silent ' : ''}write ${path}`);
    },
    remove: async (path, silent) => {
      files.delete(path);
      log.push(`${silent ? 'silent ' : ''}remove ${path}`);
    },
  };
  return { files, log, store, failAt: (path: string) => { failOn = path; } };
}

/** A clock the test moves by hand. */
function clock() {
  let t = 1000;
  return { now: () => t, tick: (ms = 1) => { t += ms; } };
}

describe('EditJournal', () => {
  it('undoes a write by putting back what was there, and removes a file the write created', async () => {
    const m = memory({ '/index.html': '<p data-osw-id="a">', '/overrides.css': 'new' });
    const j = new EditJournal(m.store);
    j.record('g1', 'style', { path: '/index.html', before: '<p>', after: '<p data-osw-id="a">', silent: false });
    j.record('g1', 'style', { path: '/overrides.css', before: null, after: 'new', silent: true });

    const out = await j.undo();

    expect(out.ok).toBe(true);
    expect(m.files.get('/index.html')).toBe('<p>');
    expect(m.files.has('/overrides.css')).toBe(false);
    // Written back as each was written: the stylesheet without a change event, the page with one.
    expect(m.log).toEqual(['silent remove /overrides.css', 'write /index.html']);
  });

  it('redoes what it undid', async () => {
    const m = memory({ '/overrides.css': 'b' });
    const j = new EditJournal(m.store);
    j.record('g1', 'style', { path: '/overrides.css', before: 'a', after: 'b', silent: true });
    await j.undo();
    expect(m.files.get('/overrides.css')).toBe('a');
    expect((await j.redo()).ok).toBe(true);
    expect(m.files.get('/overrides.css')).toBe('b');
  });

  it('makes one entry of the writes one gesture made, from its first before to its last after', async () => {
    const m = memory({ '/overrides.css': 'c' });
    const j = new EditJournal(m.store);
    j.record('scrub', 'style', { path: '/overrides.css', before: 'a', after: 'b', silent: true });
    j.record('scrub', 'style', { path: '/overrides.css', before: 'b', after: 'c', silent: true });
    await j.undo();
    expect(m.files.get('/overrides.css')).toBe('a');
    expect(j.undoAt()).toBeNull();
  });

  it('drops what was undone once a new gesture is recorded', async () => {
    const m = memory({ '/overrides.css': 'b' });
    const j = new EditJournal(m.store);
    j.record('g1', 'style', { path: '/overrides.css', before: 'a', after: 'b', silent: true });
    await j.undo();
    j.record('g2', 'style', { path: '/overrides.css', before: 'a', after: 'z', silent: true });
    m.files.set('/overrides.css', 'z');
    expect(j.redoAt()).toBeNull();
    expect((await j.redo())).toEqual({ ok: false, reason: 'empty' });
    // g1 is gone, not waiting behind g2: once g2 is undone there is nothing older.
    expect((await j.undo()).ok).toBe(true);
    expect(await j.undo()).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses to undo over a write it did not make, and empties', async () => {
    const m = memory({ '/overrides.css': 'b' });
    const j = new EditJournal(m.store);
    j.record('g1', 'style', { path: '/overrides.css', before: 'a', after: 'b', silent: true });
    m.files.set('/overrides.css', 'the agent wrote this');

    expect(await j.undo()).toEqual({ ok: false, reason: 'changed', path: '/overrides.css' });
    expect(m.files.get('/overrides.css')).toBe('the agent wrote this');
    expect(m.log).toEqual([]);
    expect(j.undoAt()).toBeNull();
  });

  it('checks every file before writing any, so a refusal leaves all of them alone', async () => {
    const m = memory({ '/index.html': 'stamped', '/overrides.css': 'rule' });
    const j = new EditJournal(m.store);
    j.record('g1', 'style', { path: '/index.html', before: 'plain', after: 'stamped', silent: false });
    j.record('g1', 'style', { path: '/overrides.css', before: '', after: 'rule', silent: true });
    m.files.set('/index.html', 'edited in the code editor');

    expect((await j.undo()).ok).toBe(false);
    expect(m.files.get('/overrides.css')).toBe('rule');
  });

  it('refuses to redo over a write made after the undo', async () => {
    const m = memory({ '/overrides.css': 'b' });
    const j = new EditJournal(m.store);
    j.record('g1', 'style', { path: '/overrides.css', before: 'a', after: 'b', silent: true });
    await j.undo();
    m.files.set('/overrides.css', 'someone else');
    expect(await j.redo()).toEqual({ ok: false, reason: 'changed', path: '/overrides.css' });
    expect(m.files.get('/overrides.css')).toBe('someone else');
  });

  it('reports a write that failed part way, with what it did write, and empties', async () => {
    const m = memory({ '/index.html': 'stamped', '/overrides.css': 'rule' });
    const j = new EditJournal(m.store);
    j.record('g1', 'style', { path: '/index.html', before: 'plain', after: 'stamped', silent: false });
    j.record('g1', 'style', { path: '/overrides.css', before: '', after: 'rule', silent: true });
    m.failAt('/index.html');

    const out = await j.undo();
    expect(out).toEqual({
      ok: false,
      reason: 'failed',
      path: '/index.html',
      written: [{ path: '/overrides.css', content: '', silent: true }],
    });
    expect(j.undoAt()).toBeNull();
  });

  it('dates entries by when they were made and undone', async () => {
    const c = clock();
    const m = memory({ '/overrides.css': 'b' });
    const j = new EditJournal(m.store, c.now);
    j.record('g1', 'style', { path: '/overrides.css', before: 'a', after: 'b', silent: true });
    expect(j.undoAt()).toBe(1000);
    c.tick(5);
    await j.undo();
    expect(j.redoAt()).toBe(1005);
    expect(j.undoAt()).toBeNull();
  });

  it('dates a redone entry by when it was redone', async () => {
    const c = clock();
    const m = memory({ '/overrides.css': 'b' });
    const j = new EditJournal(m.store, c.now);
    j.record('g1', 'style', { path: '/overrides.css', before: 'a', after: 'b', silent: true });
    c.tick(5);
    await j.undo();
    c.tick(5);
    await j.redo();
    expect(j.undoAt()).toBe(1010);
  });

  it('takes one entry back for two undos asked for at once', async () => {
    const c = clock();
    const m = memory({ '/overrides.css': 'c' });
    const j = new EditJournal(m.store, c.now);
    j.record('g1', 'style', { path: '/overrides.css', before: 'a', after: 'b', silent: true });
    c.tick();
    j.record('g2', 'style', { path: '/overrides.css', before: 'b', after: 'c', silent: true });

    const [first, second] = await Promise.all([j.undo(), j.undo()]);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'empty' });
    expect(m.files.get('/overrides.css')).toBe('b');
    // g1 is still the one to undo next.
    expect(j.undoAt()).toBe(1000);
  });

  it('lets the oldest entries go past its byte limit', async () => {
    const m = memory({ '/a.css': 'xxxx', '/b.css': 'yyyy' });
    const j = new EditJournal(m.store, Date.now, 10);
    j.record('g1', 'style', { path: '/a.css', before: 'aaaa', after: 'xxxx', silent: true });
    j.record('g2', 'style', { path: '/b.css', before: 'bbbb', after: 'yyyy', silent: true });
    await j.undo();
    expect(m.files.get('/b.css')).toBe('bbbb');
    // g1 went to make room; there is nothing older to undo.
    expect(await j.undo()).toEqual({ ok: false, reason: 'empty' });
    expect(m.files.get('/a.css')).toBe('xxxx');
  });
});

describe('newestHistory', () => {
  it('picks whichever history changed last, and neither when both are empty', () => {
    expect(newestHistory(5, 9)).toBe('edit');
    expect(newestHistory(9, 5)).toBe('layout');
    expect(newestHistory(null, 5)).toBe('edit');
    expect(newestHistory(5, null)).toBe('layout');
    expect(newestHistory(null, null)).toBeNull();
  });
});
