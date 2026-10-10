// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { blobUrlPrefix, collectShellAssets, loadIntoShell, previewShellHtml, SHELL_CONTENT } from '../preview-shell';

/**
 * The preview frame cannot load the host's `blob:` URLs, so it is given a shell that makes its own
 * and writes the page. These run the shell's script in jsdom with `createObjectURL` and
 * `document.write` stubbed: what it swaps, in what order, and who it listens to. The host side
 * (`loadIntoShell`, which the thumbnails use) runs against a stand-in frame window.
 */

const ORIGIN = 'http://app.test';
const host = (n: number) => `${blobUrlPrefix(ORIGIN)}0000000${n}-aaaa-bbbb-cccc-dddddddddddd`;

let minted: Array<{ url: string; type: string; text: Promise<string> }>;
let written: string[];
let posted: unknown[];
let listeners: Array<[string, EventListenerOrEventListenerObject]>;

function runShell(loadId: number) {
  const script = previewShellHtml(loadId).match(/<script>([\s\S]*?)<\/script>/)![1];
  new Function(script)();
}

function deliver(data: Record<string, unknown>, source: unknown = window.parent) {
  window.dispatchEvent(Object.assign(new Event('message'), { source, data }));
}

// jsdom's Blob has no text().
if (!Blob.prototype.text) {
  Blob.prototype.text = function (this: Blob) {
    return new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(this);
    });
  };
}

async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
}

beforeEach(() => {
  minted = [];
  written = [];
  posted = [];
  listeners = [];
  const add = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject) => {
    listeners.push([type, fn]);
    add(type, fn);
  });
  let n = 0;
  vi.stubGlobal('URL', Object.assign(Object.create(URL), {
    createObjectURL: (blob: Blob) => {
      const url = `blob:null/frame-${++n}`;
      minted.push({ url, type: blob.type, text: blob.text() });
      return url;
    },
  }));
  vi.spyOn(document, 'open').mockImplementation((() => document) as never);
  vi.spyOn(document, 'write').mockImplementation((html: string) => { written.push(html); });
  vi.spyOn(document, 'close').mockImplementation(() => {});
  vi.spyOn(window, 'postMessage').mockImplementation((m: unknown) => { posted.push(m); });
});

afterEach(() => {
  for (const [type, fn] of listeners) window.removeEventListener(type, fn);
  delete (window as unknown as { __oswStorageSeed?: unknown }).__oswStorageSeed;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('previewShellHtml', () => {
  it('asks for its page as soon as it runs', () => {
    runShell(5);
    expect(posted).toEqual([{ type: 'preview:shell-ready', loadId: 5 }]);
  });

  it("writes the page with the frame's own URLs in place of the host's, nested ones included", async () => {
    runShell(5);
    const img = new Blob(['png'], { type: 'image/png' });
    const css = new Blob([`.hero{background:url(${host(1)})}`], { type: 'text/css' });
    deliver({
      type: SHELL_CONTENT, loadId: 5, prefix: blobUrlPrefix(ORIGIN),
      html: `<link href="${host(2)}"><img src="${host(1)}"><a href="${host(9)}">not an asset</a>`,
      // Listed with the stylesheet first, to show it still waits for the image it names.
      assets: [{ url: host(2), blob: css, text: true }, { url: host(1), blob: img, text: false }],
    });
    await settle();

    const imageUrl = minted.find(m => m.type === 'image/png')!.url;
    const cssEntry = minted.find(m => m.type === 'text/css')!;
    expect(await cssEntry.text).toBe(`.hero{background:url(${imageUrl})}`);
    expect(written).toEqual([`<link href="${cssEntry.url}"><img src="${imageUrl}"><a href="${host(9)}">not an asset</a>`]);
  });

  it('makes a module after the module it imports, whatever order they arrive in', async () => {
    runShell(5);
    const main = new Blob([`import "${host(4)}";`], { type: 'text/javascript' });
    const dep = new Blob(['export const x = 1;'], { type: 'text/javascript' });
    deliver({
      type: SHELL_CONTENT, loadId: 5, prefix: blobUrlPrefix(ORIGIN),
      html: `<script type="module" src="${host(3)}"></script>`,
      assets: [{ url: host(3), blob: main, text: true }, { url: host(4), blob: dep, text: true }],
    });
    await settle();

    const texts = await Promise.all(minted.map(m => m.text));
    const depUrl = minted[texts.indexOf('export const x = 1;')].url;
    expect(texts).toContain(`import "${depUrl}";`);
  });

  it('still writes the page when two text assets name each other', async () => {
    // Neither can wait for the other's URL; without a way out the shell loops and the frame hangs
    // (and so would this run: the loop is synchronous).
    runShell(5);
    const a = new Blob([`@import url(${host(6)});`], { type: 'text/css' });
    const b = new Blob([`@import url(${host(5)});`], { type: 'text/css' });
    deliver({
      type: SHELL_CONTENT, loadId: 5, prefix: blobUrlPrefix(ORIGIN),
      html: `<link href="${host(5)}"><link href="${host(6)}">`,
      assets: [{ url: host(5), blob: a, text: true }, { url: host(6), blob: b, text: true }],
    });
    await settle();

    expect(minted).toHaveLength(2);
    expect(written).toEqual([`<link href="${minted[0].url}"><link href="${minted[1].url}">`]);
  });

  it("hands the page the project's storage before writing it", async () => {
    const seen: unknown[] = [];
    vi.mocked(document.write).mockImplementation(() => {
      seen.push((window as unknown as { __oswStorageSeed?: unknown }).__oswStorageSeed);
    });
    runShell(5);
    const storage = { local: { todos: '["milk"]' }, session: {}, cookie: { theme: 'dark' } };
    deliver({ type: SHELL_CONTENT, loadId: 5, prefix: blobUrlPrefix(ORIGIN), html: '<p>x</p>', assets: [], storage });
    await settle();

    expect(seen).toEqual([storage]);
  });

  it('ignores content from anyone but the host, or for another load', async () => {
    runShell(5);
    const page = { type: SHELL_CONTENT, prefix: blobUrlPrefix(ORIGIN), html: '<p>x</p>', assets: [] };
    deliver({ ...page, loadId: 5 }, {});
    deliver({ ...page, loadId: 4 });
    await settle();
    expect(written).toEqual([]);

    deliver({ ...page, loadId: 5 });
    await settle();
    expect(written).toEqual(['<p>x</p>']);
  });

  it('writes the page once, whatever arrives after', async () => {
    runShell(5);
    const page = { type: SHELL_CONTENT, loadId: 5, prefix: blobUrlPrefix(ORIGIN), assets: [] };
    deliver({ ...page, html: '<p>first</p>' });
    deliver({ ...page, html: '<p>second</p>' });
    await settle();
    expect(written).toEqual(['<p>first</p>']);
  });
});

describe('collectShellAssets', () => {
  it('gathers the file map, what the page names, and what those name in turn', async () => {
    const blobs = new Map<string, Blob>([
      [host(1), new Blob([`@import url(${host(3)});`], { type: 'text/css' })],
      [host(2), new Blob(['x'], { type: 'image/png' })],
      [host(3), new Blob(['body{}'], { type: 'text/css' })],
    ]);
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { fetched.push(url); return { blob: async () => blobs.get(url)! }; }));

    const cache = new Map<string, Blob>();
    const assets = await collectShellAssets(`<link href="${host(1)}"><img src="blob:http://elsewhere/x">`, [host(2)], ORIGIN, cache);

    expect(assets.map(a => [a.url, a.text])).toEqual([[host(2), false], [host(1), true], [host(3), true]]);
    expect(fetched.sort()).toEqual([host(1), host(2), host(3)].sort());

    fetched.length = 0;
    await collectShellAssets(`<link href="${host(1)}">`, [host(2)], ORIGIN, cache);
    expect(fetched).toEqual([]);
  });

  it('leaves out a blob that can no longer be read, and sends the rest', async () => {
    // A newer compile revoked it; the page shows one missing asset rather than none at all.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === host(2)) throw new TypeError('Failed to fetch');
      return { blob: async () => new Blob(['x'], { type: 'image/png' }) };
    }));
    const cache = new Map<string, Blob>();

    const assets = await collectShellAssets(`<img src="${host(1)}"><img src="${host(2)}">`, [], ORIGIN, cache);

    expect(assets.map(a => a.url)).toEqual([host(1)]);
    expect([...cache.keys()]).toEqual([host(1)]);
  });
});

describe('loadIntoShell', () => {
  const origin = window.location.origin;
  const asset = `${blobUrlPrefix(origin)}00000001-aaaa-bbbb-cccc-dddddddddddd`;
  const image = new Blob(['png'], { type: 'image/png' });

  function fakeFrame() {
    const contentWindow = { postMessage: vi.fn() };
    const iframe = { contentWindow, srcdoc: '' } as unknown as HTMLIFrameElement;
    return { iframe, contentWindow };
  }
  const from = (source: unknown, data: Record<string, unknown>) =>
    window.dispatchEvent(Object.assign(new Event('message'), { source, data }));

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => image })));
  });

  it('writes the shell, answers it with the page, and resolves when the page has loaded', async () => {
    const { iframe, contentWindow } = fakeFrame();
    const storage = { local: { a: '1' }, session: {}, cookie: {} };
    let loaded = false;
    const pending = loadIntoShell(iframe, `<img src="${asset}">`, [asset], 1000, storage).then(() => { loaded = true; });
    expect(iframe.srcdoc).toBe(previewShellHtml(0));

    from(contentWindow, { type: 'preview:shell-ready', loadId: 0 });
    await settle();
    expect(contentWindow.postMessage).toHaveBeenCalledWith({
      type: SHELL_CONTENT, loadId: 0, html: `<img src="${asset}">`, prefix: blobUrlPrefix(origin), storage,
      assets: [{ url: asset, blob: image, text: false }],
    }, '*');
    expect(loaded).toBe(false);

    from(contentWindow, { type: 'preview:ready', loadId: 0 });
    await pending;
    expect(loaded).toBe(true);
  });

  it('listens only to its own frame, for its own load', async () => {
    const { iframe, contentWindow } = fakeFrame();
    let loaded = false;
    const pending = loadIntoShell(iframe, '<p>x</p>', [], 1000).then(() => { loaded = true; });

    from({}, { type: 'preview:shell-ready', loadId: 0 });
    from({}, { type: 'preview:ready', loadId: 0 });
    from(contentWindow, { type: 'preview:ready', loadId: 1 });
    await settle();
    expect(contentWindow.postMessage).not.toHaveBeenCalled();
    expect(loaded).toBe(false);

    from(contentWindow, { type: 'preview:ready', loadId: 0 });
    await pending;
    expect(loaded).toBe(true);
  });

  it("rejects with the shell's reason when it cannot build the page", async () => {
    const { iframe, contentWindow } = fakeFrame();
    const pending = loadIntoShell(iframe, '<p>x</p>', [], 1000);
    from(contentWindow, { type: 'preview:shell-error', loadId: 0, error: 'blob is gone' });
    await expect(pending).rejects.toThrow('blob is gone');
  });

  it('rejects when the page cannot be handed to the frame', async () => {
    const { iframe, contentWindow } = fakeFrame();
    contentWindow.postMessage.mockImplementation(() => { throw new DOMException('could not be cloned', 'DataCloneError'); });
    const pending = loadIntoShell(iframe, '<p>x</p>', [], 1000);
    from(contentWindow, { type: 'preview:shell-ready', loadId: 0 });
    await expect(pending).rejects.toThrow('could not be cloned');
  });

  it('gives up on a page that never loads', async () => {
    vi.useFakeTimers();
    try {
      const { iframe } = fakeFrame();
      const pending = loadIntoShell(iframe, '<p>x</p>', [], 500);
      const outcome = expect(pending).rejects.toThrow('within 500ms');
      vi.advanceTimersByTime(500);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops listening once settled', async () => {
    const { iframe, contentWindow } = fakeFrame();
    const pending = loadIntoShell(iframe, '<p>x</p>', [], 1000);
    from(contentWindow, { type: 'preview:ready', loadId: 0 });
    await pending;

    from(contentWindow, { type: 'preview:shell-ready', loadId: 0 });
    await settle();
    expect(contentWindow.postMessage).not.toHaveBeenCalled();
  });
});
