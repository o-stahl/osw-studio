// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), loadIntoShell: vi.fn(), captureIframeScreenshot: vi.fn() }));
vi.mock('@/lib/api/backend-status', () => ({ apiFetch: mocks.apiFetch }));
// jsdom cannot run a sandboxed frame; the shell itself is covered in lib/preview/__tests__/preview-shell.test.ts.
vi.mock('@/lib/preview/preview-shell', () => ({ loadIntoShell: mocks.loadIntoShell }));
vi.mock('../screenshot', () => ({ captureIframeScreenshot: mocks.captureIframeScreenshot }));

import { captureDeploymentPage, pageForCapture } from '../deployment-thumbnail';

/**
 * A published page is captured from its built HTML in a sandboxed shell (SEC-6): its assets load
 * from the site's own URL through a `<base>`, which has to come before anything that names a URL,
 * and the bridge that answers the capture request comes with it.
 */
describe('pageForCapture', () => {
  const url = 'https://sunny.inst-1.oswstudio.com/about.html';

  it('puts the base and the bridge first in the head', () => {
    const out = pageForCapture('<html><head><link rel="stylesheet" href="/s.css"></head><body></body></html>', url);
    const head = out.slice(out.indexOf('<head>') + 6);
    expect(head.startsWith(`<base href="${url}">`)).toBe(true);
    expect(head.indexOf('data-osw-bridge')).toBeLessThan(head.indexOf('<link'));
  });

  it('adds a head where the page has none', () => {
    expect(pageForCapture('<html><body>x</body></html>', url)).toMatch(/^<html><head><base href=/);
    expect(pageForCapture('<p>x</p>', url)).toMatch(/^<base href=/);
  });

  it('never takes a <header> for the head', () => {
    const out = pageForCapture('<html><body><header>nav</header></body></html>', url);
    expect(out).toMatch(/^<html><head><base href=/);
    expect(out).toContain('<header>nav</header>');
    expect(pageForCapture('<html><head lang="en"><header></header>', url)).toMatch(/^<html><head lang="en"><base href=/);
  });

  it('cannot be broken out of by the URL', () => {
    expect(pageForCapture('<head></head>', 'https://x.test/?a=1&b="><script>bad()</script>'))
      .toMatch(/^<head><base href="https:\/\/x\.test\/\?a=1&amp;b=&quot;>&lt;script>bad\(\)&lt;\/script>"><script data-osw-bridge>/);
  });
});

describe('captureDeploymentPage', () => {
  const page = { html: '<html><head></head><body>hi</body></html>', url: 'https://sunny.inst-1.oswstudio.com/about.html' };
  /** The frame the page was rendered in, as it was while rendering. */
  let rendered: { html: string; sandbox: string | null; attached: boolean } | null;

  beforeEach(() => {
    vi.clearAllMocks();
    rendered = null;
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => page });
    mocks.loadIntoShell.mockImplementation(async (iframe: HTMLIFrameElement, html: string) => {
      rendered = { html, sandbox: iframe.getAttribute('sandbox'), attached: iframe.isConnected };
    });
    mocks.captureIframeScreenshot.mockResolvedValue('data:image/jpeg;base64,x');
  });

  it('renders the built page in a frame that cannot reach the studio, and captures it', async () => {
    expect(await captureDeploymentPage('d 1', { pagePath: '/about' })).toBe('data:image/jpeg;base64,x');

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/deployment-pages/d%201?path=%2Fabout');
    expect(rendered).toEqual({ html: pageForCapture(page.html, page.url), sandbox: 'allow-scripts', attached: true });
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('captures at the size and quality asked for', async () => {
    await captureDeploymentPage('d1', { captureWidth: 800, captureHeight: 600, outputWidth: 400, quality: 0.5, fullPage: true });
    expect(mocks.captureIframeScreenshot).toHaveBeenCalledWith(expect.any(HTMLIFrameElement), 800, 600, 400, 0.5, true, true, 2500);
  });

  it('returns nothing when the page cannot be had, without rendering anything', async () => {
    // The status decides, not whether the body happens to parse.
    mocks.apiFetch.mockResolvedValue({ ok: false, status: 502, json: async () => page });
    expect(await captureDeploymentPage('d1')).toBeNull();
    expect(mocks.loadIntoShell).not.toHaveBeenCalled();
    mocks.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await captureDeploymentPage('d1')).toBeNull();
    expect(mocks.loadIntoShell).not.toHaveBeenCalled();
  });

  it('returns nothing, and leaves no frame behind, when the page does not load', async () => {
    mocks.loadIntoShell.mockRejectedValue(new Error('page did not load within 15000ms'));
    expect(await captureDeploymentPage('d1')).toBeNull();
    expect(mocks.captureIframeScreenshot).not.toHaveBeenCalled();
    expect(document.querySelector('iframe')).toBeNull();
  });
});
