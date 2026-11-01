import { describe, it, expect } from 'vitest';
import { processHtml, HtmlProcessingOptions } from '@/lib/publishing/html-processor';
import { PublishSettings } from '@/lib/vfs/types';

/**
 * A page can ship its own <title>, description and Open Graph defaults, and the SEO settings are one
 * set for the whole deployment. So for anything written per page the page's tag wins and the setting
 * only fills a gap: overriding would give every page in a site the same title and description. What
 * the settings do replace is the handful of tags that describe the deployment rather than the page,
 * and the robots directives, which are a deliberate switch over the whole thing.
 *
 * Either way the page ends up with one of each tag, which is the defect this started from: settings
 * were appended, so a page carrying its own title published with two.
 */

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Page title</title>
    <meta name="description" content="Page description">
    <meta content="Page OG title" property="og:title">
    <meta property='og:type' content='website'>
    <meta name="twitter:card" content="summary">
    <meta property="og:site_name" content="Papertop">
    <meta data-name="description" content="not a description tag">
    <link rel="canonical" href="https://old.example/">
    <script type="application/ld+json">{"@type":"WebApplication","name":"Papertop"}</script>
</head>
<body>
    <p><title>stays in the body</title></p>
    <meta name="description" content="a body meta is not touched">
</body>
</html>`;

/**
 * A page that carries no tag of its own, only a look-alike attribute, and whose body holds copies of
 * the tags the settings do replace. With settings appended these two were covered by the main page's
 * decoys; now that a setting fills a gap, a false match suppresses it instead of deleting a tag, and
 * that only shows on a page with the gap.
 */
const DECOY_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta data-name="description" content="not a description tag">
    <meta property="og:url" content="https://stale.example/">
</head>
<body>
    <meta property="og:url" content="a body og:url is not touched">
    <meta name="robots" content="index, follow">
    <p><title>a title in the body is not the page's title</title></p>
</body>
</html>`;

function options(seo: PublishSettings['seo']): HtmlProcessingOptions {
  return {
    publishSettings: {
      underConstruction: false, headScripts: [], bodyScripts: [], cdnLinks: [],
      analytics: { enabled: false, provider: 'builtin', privacyMode: true },
      seo,
      compliance: {
        enabled: false, bannerPosition: 'bottom', bannerStyle: 'bar', message: '',
        acceptButtonText: 'Accept', declineButtonText: 'Decline', mode: 'opt-in', blockAnalytics: true,
      },
      settingsVersion: 1,
    },
    projectId: 'p1',
    baseUrl: 'https://papertop.app',
    deploymentId: 'd1',
  };
}

const head = (html: string) => html.slice(0, html.indexOf('</head>'));
const count = (text: string, re: RegExp) => (text.match(re) || []).length;

describe('SEO settings over a page with its own tags', () => {
  it('leaves the page\'s own title, description and canonical in place, once each', () => {
    const out = processHtml(PAGE, options({
      title: 'Papertop', description: 'An OS in a tab', canonical: 'https://papertop.app/',
    }));
    const h = head(out);

    expect(count(h, /<title>/g)).toBe(1);
    expect(h).toContain('<title>Page title</title>');
    expect(count(h, /\sname="description"/g)).toBe(1);
    expect(h).toContain('content="Page description"');
    expect(count(h, /rel="canonical"/g)).toBe(1);
    expect(h).toContain('href="https://old.example/"');
  });

  it('fills in the tags the page does not carry', () => {
    const out = processHtml(PAGE, options({
      title: 'Papertop', description: 'An OS in a tab', keywords: ['os', 'tab'],
      ogImage: 'https://papertop.app/assets/og.png',
    }));
    const h = head(out);

    // The page has no keywords, og:image, og:description or twitter:title of its own.
    expect(h).toContain('<meta name="keywords" content="os, tab">');
    expect(h).toContain('property="og:image" content="https://papertop.app/assets/og.png"');
    expect(h).toContain('property="og:description" content="An OS in a tab"');
    expect(h).toContain('name="twitter:title" content="Papertop"');
    // And it does carry og:title, so that one is left as the page wrote it.
    expect(count(h, /property=["']og:title["']/g)).toBe(1);
    expect(h).toContain('Page OG title');
  });

  it('replaces the tags that describe the deployment rather than the page', () => {
    const out = processHtml(PAGE, options({ title: 'Papertop', noIndex: true, noFollow: true }));
    const h = head(out);

    expect(count(h, /property=["']og:type["']/g)).toBe(1);
    expect(count(h, /name="twitter:card"/g)).toBe(1);
    expect(count(h, /property="og:url"/g)).toBe(1);
    // og:url names the page's canonical address, so a shared link and a search result agree.
    expect(h).toContain('property="og:url" content="https://old.example/"');
    expect(count(h, /name="robots"/g)).toBe(1);
    expect(h).toContain('content="noindex, nofollow"');
  });

  it('uses the OG fields for the social tags, and the meta text when they are unset', () => {
    const withOg = head(processHtml(PAGE, options({
      title: 'Papertop', description: 'An OS in a tab',
      ogTitle: 'Papertop for social', ogDescription: 'Shared wording',
    })));
    // og:title is the page's own, so the setting lands on twitter:title, which the page lacks.
    expect(withOg).toContain('name="twitter:title" content="Papertop for social"');
    expect(withOg).toContain('property="og:description" content="Shared wording"');
    expect(withOg).toContain('name="twitter:description" content="Shared wording"');

    const withoutOg = head(processHtml(PAGE, options({ title: 'Papertop', description: 'An OS in a tab' })));
    expect(withoutOg).toContain('name="twitter:title" content="Papertop"');
    expect(withoutOg).toContain('property="og:description" content="An OS in a tab"');
  });

  it('publishes the chosen Twitter card type', () => {
    expect(head(processHtml(PAGE, options({ title: 'P', twitterCard: 'summary' }))))
      .toContain('name="twitter:card" content="summary"');
    expect(head(processHtml(PAGE, options({ title: 'P', twitterCard: 'summary_large_image' }))))
      .toContain('name="twitter:card" content="summary_large_image"');
    // Unset keeps the large card, which is what every deployment published before the field was read.
    expect(head(processHtml(PAGE, options({ title: 'P' }))))
      .toContain('name="twitter:card" content="summary_large_image"');
  });

  it('fills a tag the page only looks like it has', () => {
    const out = processHtml(DECOY_PAGE, options({ description: 'An OS in a tab' }));
    const h = head(out);

    // `data-name="description"` is not a description tag, so the setting still applies.
    expect(h).toContain('<meta name="description" content="An OS in a tab">');
    expect(h).toContain('<meta data-name="description" content="not a description tag">');
    expect(count(h, /\sname="description"/g)).toBe(1);
  });

  it('fills a tag the page carries only in its body', () => {
    const out = processHtml(DECOY_PAGE, options({ title: 'Papertop' }));

    // Only <head> decides whether the page already has the tag, so the body copy does not count.
    expect(head(out)).toContain('<title>Papertop</title>');
    expect(out.slice(out.indexOf('</head>'))).toContain("a title in the body is not the page's title");
  });

  it('replaces a deployment tag in the head and leaves the body copy alone', () => {
    const out = processHtml(DECOY_PAGE, options({ title: 'Papertop', noIndex: true }));
    const h = head(out);
    const body = out.slice(out.indexOf('</head>'));

    expect(count(h, /property="og:url"/g)).toBe(1);
    expect(h).toContain('content="https://papertop.app"');
    expect(h).not.toContain('https://stale.example/');
    expect(body).toContain('content="a body og:url is not touched"');
    expect(body).toContain('<meta name="robots" content="index, follow">');
  });

  it('leaves tags it doesn’t set, and the body, alone', () => {
    const out = processHtml(PAGE, options({ title: 'Papertop', description: 'An OS in a tab' }));

    expect(out).toContain('<meta property="og:site_name" content="Papertop">');
    expect(out).toContain('<meta data-name="description" content="not a description tag">');
    expect(out).toContain('application/ld+json');
    expect(out).toContain('<p><title>stays in the body</title></p>');
    expect(out).toContain('content="a body meta is not touched"');
  });

  it('changes nothing without SEO settings', () => {
    expect(processHtml(PAGE, options({}))).toBe(PAGE);
  });
});

describe('og:url', () => {
  const page = (headExtra: string) => `<!DOCTYPE html><html><head><title>t</title>${headExtra}</head><body>
    <link rel="canonical" href="https://body.example/"></body></html>`;
  const ogUrl = (html: string) => /property="og:url" content="([^"]*)"/.exec(head(html))?.[1];

  it('is where the page is served when it has no canonical link of its own', () => {
    for (const [pagePath, url] of [
      ['index.html', 'https://papertop.app'],
      ['/mahjong.html', 'https://papertop.app/mahjong'],
      ['docs/index.html', 'https://papertop.app/docs/'],
    ]) {
      expect(ogUrl(processHtml(page(''), { ...options({ title: 'P' }), pagePath }))).toBe(url);
    }
  });

  it('is the page\'s canonical link, in either quote style, when it has one', () => {
    expect(ogUrl(processHtml(page('<link href="https://papertop.app/mahjong" rel="canonical">'), { ...options({ title: 'P' }), pagePath: 'x.html' })))
      .toBe('https://papertop.app/mahjong');
    expect(ogUrl(processHtml(page("<link rel='canonical' href='https://papertop.app/sudoku'>"), { ...options({ title: 'P' }), pagePath: 'x.html' })))
      .toBe('https://papertop.app/sudoku');
  });

  it('takes the link as a browser reads it, so its references are written once', () => {
    expect(ogUrl(processHtml(page('<link rel="canonical" href="https://papertop.app/?a=1&amp;b=2">'), { ...options({ title: 'P' }), pagePath: 'x.html' })))
      .toBe('https://papertop.app/?a=1&amp;b=2');
  });

  it('resolves a relative canonical link against where the page is served', () => {
    expect(ogUrl(processHtml(page('<link rel="canonical" href="/mahjong">'), { ...options({ title: 'P' }), pagePath: 'x.html' })))
      .toBe('https://papertop.app/mahjong');
    expect(ogUrl(processHtml(page('<link rel="canonical" href="intro">'), { ...options({ title: 'P' }), pagePath: 'docs/index.html' })))
      .toBe('https://papertop.app/docs/intro');
  });

  it('resolves a relative canonical link on the root page inside a deployment served under a path', () => {
    const underPath = { ...options({ title: 'P' }), baseUrl: 'https://studio.example/deployments/abc', pagePath: 'index.html' };
    expect(ogUrl(processHtml(page('<link rel="canonical" href="about">'), underPath))).toBe('https://studio.example/deployments/abc/about');
    expect(ogUrl(processHtml(page('<link rel="canonical" href="./">'), underPath))).toBe('https://studio.example/deployments/abc/');
    expect(ogUrl(processHtml(page(''), underPath))).toBe('https://studio.example/deployments/abc');
  });

  it('takes a canonical link it cannot decode or resolve as written', () => {
    // Decoding the reference or resolving the host would throw, failing the whole publish.
    for (const [href, url] of [
      ['https://x/&#99999999;', 'https://x/&amp;#99999999;'],
      ['//[bad', '//[bad'],
    ]) {
      expect(ogUrl(processHtml(page(`<link rel="canonical" href="${href}">`), { ...options({ title: 'P' }), pagePath: 'x.html' })), href)
        .toBe(url);
    }
  });

  it('is the canonical the settings add when the page has none', () => {
    const h = processHtml(page(''), { ...options({ title: 'P', canonical: 'https://papertop.app/home' }), pagePath: 'x.html' });
    expect(ogUrl(h)).toBe('https://papertop.app/home');
    expect(head(h)).toContain('<link rel="canonical" href="https://papertop.app/home">');
  });

  it('is the site\'s root without a page path', () => {
    expect(ogUrl(processHtml(page(''), options({ title: 'P' })))).toBe('https://papertop.app');
  });
});

