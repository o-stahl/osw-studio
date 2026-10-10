// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { previewBridgeJs } from '../preview-bridge';
import { clearPreviewStorage, getPreviewStorage, PREVIEW_STORAGE_LIMIT, setPreviewStorageArea, storageReportProject } from '../preview-storage';

/**
 * A project's own storage in the preview. The frame runs on an opaque origin, where the real
 * `localStorage`, `sessionStorage` and `document.cookie` throw; the bridge puts in-memory stand-ins
 * in their place, seeded by the host and reported back to it, per project.
 */

describe('the host store', () => {
  beforeEach(() => clearPreviewStorage());

  it('keeps each project apart, and hands out copies', () => {
    setPreviewStorageArea('p1', 'local', { todos: '[1]' });
    setPreviewStorageArea('p2', 'local', { todos: '[2]' });
    const p1 = getPreviewStorage('p1');
    p1.local.todos = 'changed';
    expect(getPreviewStorage('p1').local).toEqual({ todos: '[1]' });
    expect(getPreviewStorage('p2').local).toEqual({ todos: '[2]' });
    expect(getPreviewStorage('p3')).toEqual({ local: {}, session: {}, cookie: {} });
  });

  it('drops a report that is not one string map for a known area, or is over the limit', () => {
    expect(setPreviewStorageArea('p1', 'indexedDB', {})).toBe(false);
    expect(setPreviewStorageArea('p1', 'local', { n: 1 })).toBe(false);
    expect(setPreviewStorageArea('p1', 'local', ['x'])).toBe(false);
    expect(setPreviewStorageArea('p1', 'local', { big: 'x'.repeat(PREVIEW_STORAGE_LIMIT + 1) })).toBe(false);
    expect(getPreviewStorage('p1').local).toEqual({});
  });

  it("keeps a report only from the document on screen, for that document's project", () => {
    const page = { loadId: 7, projectId: 'p1' };
    expect(storageReportProject(7, 7, page)).toBe('p1');
    // The page being replaced reports late: it would overwrite what the new one starts from.
    expect(storageReportProject(6, 7, page)).toBeNull();
    // A newer load has begun and its page is not in place yet.
    expect(storageReportProject(7, 8, page)).toBeNull();
    expect(storageReportProject(8, 8, page)).toBeNull();
    expect(storageReportProject(7, 7, null)).toBeNull();
    expect(storageReportProject('7', 7, page)).toBeNull();
  });
});

describe('the stand-ins in the frame', () => {
  let posted: Array<Record<string, unknown>>;
  let listeners: Array<[string, EventListenerOrEventListenerObject]>;
  const real: Record<string, PropertyDescriptor | undefined> = {};

  function opaqueOrigin() {
    for (const [target, name] of [[window, 'localStorage'], [window, 'sessionStorage'], [document, 'cookie']] as const) {
      real[name] = Object.getOwnPropertyDescriptor(target, name);
      Object.defineProperty(target, name, {
        configurable: true,
        get() { throw new DOMException('The document is sandboxed', 'SecurityError'); },
        set() { throw new DOMException('The document is sandboxed', 'SecurityError'); },
      });
    }
  }

  function runBridge(seed?: unknown) {
    (window as unknown as { __oswStorageSeed?: unknown }).__oswStorageSeed = seed;
    new Function(previewBridgeJs(4))();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    posted = [];
    listeners = [];
    // Each bridge run listens on the window; they are removed after each test, so a pagehide
    // reaches only the bridge that test ran.
    const add = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
      listeners.push([type, fn]);
      add(type, fn, opts as AddEventListenerOptions);
    });
    vi.spyOn(window, 'postMessage').mockImplementation(((m: Record<string, unknown>) => { posted.push(m); }) as never);
    opaqueOrigin();
  });

  afterEach(() => {
    for (const [type, fn] of listeners) window.removeEventListener(type, fn);
    delete (window as unknown as Record<string, unknown>).localStorage;
    delete (window as unknown as Record<string, unknown>).sessionStorage;
    delete (document as unknown as Record<string, unknown>).cookie;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts from the seed the host sent, and reports changes per area', () => {
    runBridge({ local: { todos: '["milk"]' }, session: {}, cookie: { theme: 'dark' } });

    expect(localStorage.getItem('todos')).toBe('["milk"]');
    expect(document.cookie).toBe('theme=dark');
    expect((window as unknown as { __oswStorageSeed?: unknown }).__oswStorageSeed).toBeUndefined();

    localStorage.setItem('todos', '["milk","eggs"]');
    sessionStorage.setItem('step', '2');
    vi.advanceTimersByTime(60);

    expect(posted).toContainEqual({ type: 'preview:storage', loadId: 4, area: 'local', data: { todos: '["milk","eggs"]' } });
    expect(posted).toContainEqual({ type: 'preview:storage', loadId: 4, area: 'session', data: { step: '2' } });
  });

  it('reports a burst of writes once, and at once when flushed before a navigation', () => {
    runBridge();
    for (let i = 0; i < 500; i++) localStorage.setItem(`k${i}`, 'v');
    expect(posted.filter((m) => (m as { type?: string }).type === 'preview:storage')).toHaveLength(0);
    (window as unknown as { __oswFlushStorage: () => void }).__oswFlushStorage();
    const reports = posted.filter((m) => (m as { type?: string }).type === 'preview:storage');
    expect(reports).toHaveLength(1);
    expect(Object.keys((reports[0] as { data: object }).data)).toHaveLength(500);
  });

  it('behaves like Storage for the ways code usually reaches it', () => {
    runBridge();
    localStorage.setItem('a', '1');
    (localStorage as unknown as Record<string, string>).b = '2';
    expect([localStorage.length, localStorage.key(0), (localStorage as unknown as Record<string, string>).a]).toEqual([2, 'a', '1']);
    expect(Object.keys(localStorage)).toEqual(['a', 'b']);
    expect(localStorage.getItem('missing')).toBeNull();
    localStorage.removeItem('a');
    delete (localStorage as unknown as Record<string, string>).b;
    expect(localStorage.length).toBe(0);
    localStorage.setItem('x', '1');
    localStorage.clear();
    expect(localStorage.length).toBe(0);
  });

  it('refuses a write past the limit, the way a full browser storage does', () => {
    runBridge();
    expect(() => localStorage.setItem('big', 'x'.repeat(PREVIEW_STORAGE_LIMIT + 1))).toThrow(/quota/i);
    expect(localStorage.getItem('big')).toBeNull();
  });

  it('keeps the old value of a key whose new value does not fit', () => {
    runBridge({ local: { draft: 'kept' } });
    expect(() => localStorage.setItem('draft', 'x'.repeat(PREVIEW_STORAGE_LIMIT))).toThrow(/quota/i);
    expect(localStorage.getItem('draft')).toBe('kept');
    vi.advanceTimersByTime(60);
    expect(posted.filter((m) => m.type === 'preview:storage')).toEqual([]);
  });

  it('reports pending changes at once when the page goes away', () => {
    runBridge();
    localStorage.setItem('cart', '[3]');
    expect(posted.filter((m) => m.type === 'preview:storage')).toEqual([]);
    window.dispatchEvent(new Event('pagehide'));
    expect(posted).toContainEqual({ type: 'preview:storage', loadId: 4, area: 'local', data: { cart: '[3]' } });
  });

  it('keeps cookies by name and lets an expired one go', () => {
    runBridge();
    document.cookie = 'a=1; path=/';
    document.cookie = 'b=2';
    document.cookie = 'a=3; max-age=3600';
    expect(document.cookie).toBe('a=3; b=2');
    document.cookie = 'b=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    expect(document.cookie).toBe('a=3');
    document.cookie = 'a=4; Max-Age=0';
    expect(document.cookie).toBe('');
  });

  it('leaves real storage alone where the frame can use it', () => {
    for (const name of ['localStorage', 'sessionStorage'] as const) {
      Object.defineProperty(window, name, real[name] ?? { configurable: true, value: { real: true } });
    }
    const before = window.localStorage;
    runBridge();
    expect(window.localStorage).toBe(before);
  });
});
