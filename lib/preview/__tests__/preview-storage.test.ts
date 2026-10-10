// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { previewBridgeJs } from '../preview-bridge';
import { clearPreviewStorage, getPreviewStorage, PREVIEW_STORAGE_LIMIT, setPreviewStorageArea } from '../preview-storage';

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
});

describe('the stand-ins in the frame', () => {
  let posted: Array<Record<string, unknown>>;
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
    vi.spyOn(window, 'postMessage').mockImplementation(((m: Record<string, unknown>) => { posted.push(m); }) as never);
    opaqueOrigin();
  });

  afterEach(() => {
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

    // At once, not after a pause: a write made just before a link click has to reach the host
    // before the navigation it asks for starts the next page.
    localStorage.setItem('todos', '["milk","eggs"]');
    sessionStorage.setItem('step', '2');

    expect(posted).toContainEqual({ type: 'preview:storage', loadId: 4, area: 'local', data: { todos: '["milk","eggs"]' } });
    expect(posted).toContainEqual({ type: 'preview:storage', loadId: 4, area: 'session', data: { step: '2' } });
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

  it('keeps cookies by name and lets an expired one go', () => {
    runBridge();
    document.cookie = 'a=1; path=/';
    document.cookie = 'b=2';
    document.cookie = 'a=3; max-age=3600';
    expect(document.cookie).toBe('a=3; b=2');
    document.cookie = 'b=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    expect(document.cookie).toBe('a=3');
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
