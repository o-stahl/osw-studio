import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { processHtml } from '@/lib/publishing/html-processor';
import type { AnalyticsConfig, ComplianceConfig, PublishSettings } from '@/lib/vfs/types';

// jsdom has no type declarations in this project; this is the part of its API used here.
type PageWindow = Window & typeof globalThis;
type Jsdom = {
  JSDOM: new (html: string, options: {
    url: string; runScripts: 'dangerously'; pretendToBeVisual: boolean; virtualConsole: unknown;
    beforeParse: (window: PageWindow) => void;
  }) => { window: PageWindow };
  VirtualConsole: new () => { on(event: 'jsdomError', listener: (error: Error) => void): void };
};
const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom') as Jsdom;

/**
 * A published page's analytics, run as a visitor's browser runs it: the scripts the build adds are
 * executed in a DOM, and what they load or send is what is checked.
 *
 * Each provider in the analytics settings gets its own tag, in the head. Where the compliance
 * settings block analytics until the visitor agrees, none of them, the built-in tracker included,
 * loads or sends anything before that answer, or after a no.
 */

const PAGE = '<!DOCTYPE html><html><head><title>Bakery</title></head><body><h1>Bread</h1></body></html>';

function settings(analytics: Partial<AnalyticsConfig>, compliance: Partial<ComplianceConfig> = {}): PublishSettings {
  return {
    underConstruction: false, headScripts: [], bodyScripts: [], cdnLinks: [], seo: {},
    analytics: { enabled: true, provider: 'builtin', privacyMode: true, ...analytics },
    compliance: {
      enabled: false, bannerPosition: 'bottom', bannerStyle: 'bar', message: 'We use cookies.',
      acceptButtonText: 'Accept', declineButtonText: 'Decline', mode: 'opt-in', blockAnalytics: true,
      ...compliance,
    },
    settingsVersion: 1,
  };
}

const publish = (s: PublishSettings) =>
  processHtml(PAGE, { publishSettings: s, projectId: 'p1', baseUrl: 'https://bakery.test', deploymentId: 'd1' });

type Visit = { window: PageWindow; sent: string[]; errors: string[] };

/** Loads the page with its scripts running, after an earlier answer to the consent banner if given. */
async function visit(html: string, consent?: 'accepted' | 'declined'): Promise<Visit> {
  const sent: string[] = [];
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(html, {
    url: 'https://bakery.test/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (consent) window.localStorage.setItem('osw_consent_d1', consent);
      (window as unknown as { fetch: (url: string) => Promise<unknown> }).fetch = (url) => { sent.push(String(url)); return Promise.resolve({ ok: true }); };
      window.HTMLCanvasElement.prototype.getContext = (() => ({ fillText() {} })) as never;
      window.HTMLCanvasElement.prototype.toDataURL = () => 'data:,';
    },
  });
  if (dom.window.document.readyState !== 'complete') {
    await new Promise((resolve) => dom.window.addEventListener('load', resolve, { once: true }));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { window: dom.window, sent, errors };
}

const loaded = (v: Visit, src: string) =>
  [...v.window.document.querySelectorAll('script[src]')].some((s) => s.getAttribute('src')!.startsWith(src));
const flag = (v: Visit, name: string) => (v.window as unknown as Record<string, unknown>)[name];

describe('third-party analytics in a published page', () => {
  it('loads Google Tag Manager with its container id', async () => {
    const v = await visit(publish(settings({ provider: 'gtm', trackingId: 'GTM-ABC123' })));
    expect(loaded(v, 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123')).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it('loads Google Analytics 4 and configures its measurement id', async () => {
    const v = await visit(publish(settings({ provider: 'ga4', trackingId: 'G-ABC123' })));
    expect(loaded(v, 'https://www.googletagmanager.com/gtag/js?id=G-ABC123')).toBe(true);
    const layer = (flag(v, 'dataLayer') as ArrayLike<unknown>[]).map((args) => Array.from(args));
    expect(layer).toContainEqual(['config', 'G-ABC123']);
    expect(v.errors).toEqual([]);
  });

  it('loads Plausible for its domain', async () => {
    const v = await visit(publish(settings({ provider: 'plausible', trackingId: 'bakery.test' })));
    const tag = v.window.document.querySelector('script[src="https://plausible.io/js/script.js"]');
    expect(tag?.getAttribute('data-domain')).toBe('bakery.test');
    expect(v.errors).toEqual([]);
  });

  it('runs a custom script', async () => {
    const v = await visit(publish(settings({ provider: 'custom', customScript: '<script>window.customRan = true;</script>' })));
    expect(flag(v, 'customRan')).toBe(true);
  });

  it('puts each provider in the head', () => {
    const providers: Array<[Partial<AnalyticsConfig>, string]> = [
      [{ provider: 'gtm', trackingId: 'GTM-ABC123' }, 'GTM-ABC123'],
      [{ provider: 'ga4', trackingId: 'G-ABC123' }, 'G-ABC123'],
      [{ provider: 'plausible', trackingId: 'bakery.test' }, 'plausible.io'],
      [{ provider: 'custom', customScript: '<script>window.customRan = true;</script>' }, 'customRan'],
    ];
    for (const [analytics, mark] of providers) {
      const html = publish(settings(analytics));
      const at = html.indexOf(mark);
      expect(at, analytics.provider).toBeGreaterThan(-1);
      expect(at, analytics.provider).toBeLessThan(html.indexOf('</head>'));
    }
  });

  it('adds no tag for a provider without its id, and none while analytics is off', () => {
    expect(publish(settings({ provider: 'gtm', trackingId: ' ' }))).not.toContain('googletagmanager');
    expect(publish(settings({ provider: 'ga4', trackingId: 'G-ABC123', enabled: false }))).not.toContain('googletagmanager');
  });

  it('keeps a tracking id inside its string', async () => {
    for (const trackingId of ["GTM-1');window.pwned=1;('", 'GTM-1"</script><script>window.pwned=1</script>']) {
      const v = await visit(publish(settings({ provider: 'gtm', trackingId })));
      expect(flag(v, 'pwned'), trackingId).toBeUndefined();
    }
  });
});

describe('analytics and the visitor\'s consent', () => {
  const opted = (mode: 'opt-in' | 'opt-out', blockAnalytics = true) => ({ enabled: true, mode, blockAnalytics });
  const pageview = (v: Visit) => v.sent.includes('/api/analytics/track');

  it('sends no built-in pageview before an opt-in answer, or after a no', async () => {
    const html = publish(settings({ provider: 'builtin' }, opted('opt-in')));
    expect(pageview(await visit(html))).toBe(false);
    expect(pageview(await visit(html, 'declined'))).toBe(false);
    expect(pageview(await visit(html, 'accepted'))).toBe(true);
  });

  it('loads no third-party analytics before an opt-in answer, or after a no', async () => {
    const html = publish(settings({ provider: 'ga4', trackingId: 'G-ABC123' }, opted('opt-in')));
    const gtag = 'https://www.googletagmanager.com/gtag/js';
    expect(loaded(await visit(html), gtag)).toBe(false);
    expect(loaded(await visit(html, 'declined'), gtag)).toBe(false);
    expect(loaded(await visit(html, 'accepted'), gtag)).toBe(true);
  });

  it('runs no custom script before an opt-in answer, and runs it after a yes', async () => {
    const html = publish(settings({ provider: 'custom', customScript: '<script>window.customRan = true;</script>' }, opted('opt-in')));
    expect(flag(await visit(html), 'customRan')).toBeUndefined();
    expect(flag(await visit(html, 'accepted'), 'customRan')).toBe(true);
  });

  it('loads analytics until a no where the banner is opt-out, and whatever the answer when it does not block', async () => {
    const optOut = publish(settings({ provider: 'builtin' }, opted('opt-out')));
    expect(pageview(await visit(optOut))).toBe(true);
    expect(pageview(await visit(optOut, 'declined'))).toBe(false);
    const unblocked = publish(settings({ provider: 'builtin' }, opted('opt-in', false)));
    expect(pageview(await visit(unblocked, 'declined'))).toBe(true);
  });
});
