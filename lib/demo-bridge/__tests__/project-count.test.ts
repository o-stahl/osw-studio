// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { DEMO_PROJECTS_COOKIE, readDemoProjectCount, writeDemoProjectCount } from '../project-count';

/** The demo's project count, for a bridge that cannot read the projects themselves (Safari). */
afterEach(() => {
  document.cookie = `${DEMO_PROJECTS_COOKIE}=; path=/; max-age=0`;
  vi.restoreAllMocks();
});

describe('the demo project count', () => {
  it('reads back what was written, as a whole number of at least zero', () => {
    writeDemoProjectCount(3);
    expect(readDemoProjectCount()).toBe(3);
    writeDemoProjectCount(2.9);
    expect(readDemoProjectCount()).toBe(2);
    writeDemoProjectCount(-4);
    expect(readDemoProjectCount()).toBe(0);
  });

  it('is none when there is no cookie, or not a count, and ignores a name that only ends the same', () => {
    expect(readDemoProjectCount()).toBe(0);
    document.cookie = `x${DEMO_PROJECTS_COOKIE}=7; path=/`;
    expect(readDemoProjectCount()).toBe(0);
    document.cookie = `x${DEMO_PROJECTS_COOKIE}=; path=/; max-age=0`;
    document.cookie = `${DEMO_PROJECTS_COOKIE}=lots; path=/`;
    expect(readDemoProjectCount()).toBe(0);
  });

  it('is written for the whole host, kept long, Lax, and Secure on https', () => {
    const set = vi.spyOn(Document.prototype, 'cookie', 'set');
    writeDemoProjectCount(1);
    expect(set.mock.calls[0][0]).toBe(`${DEMO_PROJECTS_COOKIE}=1; Path=/; Max-Age=34560000; SameSite=Lax`);
    vi.stubGlobal('location', { ...window.location, protocol: 'https:' });
    try {
      writeDemoProjectCount(1);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(set.mock.calls[1][0]).toMatch(/; Secure$/);
  });
});
