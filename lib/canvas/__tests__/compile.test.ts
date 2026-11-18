import { describe, it, expect } from 'vitest';
import { canvasDocument, fromAssetTokens, newNonce, toAssetTokens, withOverrides } from '../compile';
import { canvasBridgeJs, FREEZE_MOTION_CSS, PAUSE_SHIM_JS, REVEAL_SHIM_JS } from '../bridge';
import { PLACEHOLDER_CSS } from '@/lib/semantic-blocks/placeholder';
import { generateNavigationScript } from '@/lib/preview/navigation-script';
import { generatePlacementScript } from '@/lib/preview/placement-script';

const blobUrls = new Map([
  ['/styles/main.css', 'blob:http://app/css-1'],
  ['/images/hero.png', 'blob:http://app/img-1'],
  ['/images/hero.png.bak', 'blob:http://app/img-2'],
  ['/scripts/site.js', 'blob:http://app/js-1'],
]);

const PAGE = '<!doctype html><html><head><title>x</title><link rel="stylesheet" href="styles/main.css"><style>.hero{min-height:100vh}</style></head>'
  + '<body><main data-osw-src="/index.html:120"><img src="images/hero.png" loading="lazy"></main><script src="scripts/site.js"></script></body></html>';

const scripts = (html: string) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({ attrs: m[1], body: m[2] }));

/** The navigation script carrying the canvas bridge for this mode, height and load, as a frame gets it. */
const bridgeBody = (mode: 'live' | 'settle' | 'still', deviceHeight: number, loadId: number) =>
  scripts(generateNavigationScript('/index.html', false, canvasBridgeJs(mode, deviceHeight, loadId)))[0].body;
const PLACEMENT_BODY = scripts(generatePlacementScript('/index.html'))[0].body;

describe('a live artboard document', () => {
  const doc = canvasDocument({ page: '/index.html', html: PAGE, blobUrls, mode: 'live', deviceHeight: 900, loadId: 7 });

  it('puts the preview bridge first, then the file map, the canvas rules and the shims, ahead of the page', () => {
    const head = doc.slice(doc.indexOf('<head>') + 6);
    expect(head.startsWith('<script data-osw-bridge>')).toBe(true);
    const order = ['data-osw-bridge', '__oswVfsBlobUrls', '<style data-osw-canvas>', 'data-osw-shim', '<title>'].map((s) => head.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(doc).toContain(REVEAL_SHIM_JS);
    expect(doc).toContain(PAUSE_SHIM_JS);
  });

  it('pins vh to the device height, loads lazy images at once and points the files at blobs', () => {
    expect(doc).toContain(':root{--osw-vh:9px}');
    expect(doc).toContain('.hero{min-height:calc(100 * var(--osw-vh))}');
    expect(doc).toContain('loading="eager"');
    expect(doc).toContain('href="blob:http://app/css-1"');
    expect(doc).toContain('src="blob:http://app/js-1"');
  });

  it('keeps the page\'s scripts and ends the body with the navigation script carrying the canvas bridge, then the placement script', () => {
    const [navigation, placement] = scripts(doc).slice(-2);
    expect(navigation.body).toBe(bridgeBody('live', 900, 7));
    expect(placement.body).toBe(PLACEMENT_BODY);
    expect(doc.indexOf('src="blob:http://app/js-1"')).toBeLessThan(doc.lastIndexOf(navigation.body));
  });

  it('gives a settle frame\'s bridge the load it was built for', () => {
    const settle = canvasDocument({ page: '/index.html', html: PAGE, blobUrls, mode: 'settle', deviceHeight: 900, loadId: 8 });
    expect(scripts(settle).map((s) => s.body)).toContain(bridgeBody('settle', 900, 8));
  });

  it('takes Semantic blocks only when live', () => {
    const settle = canvasDocument({ page: '/index.html', html: PAGE, blobUrls, mode: 'settle', deviceHeight: 900, loadId: 8 });
    expect(settle).not.toContain(PLACEMENT_BODY);
  });

  it('gives Semantic block placeholders their look in every mode, ahead of the page\'s own styles', () => {
    const settle = canvasDocument({ page: '/index.html', html: PAGE, blobUrls, mode: 'settle', deviceHeight: 900, loadId: 8 });
    const still = canvasDocument({ page: '/index.html', html: PAGE, blobUrls, mode: 'still', deviceHeight: 900, loadId: 9, nonce: 'n1' });
    for (const built of [doc, settle, still]) {
      const rules = built.slice(built.indexOf('<style data-osw-canvas>'));
      expect(rules.slice(0, rules.indexOf('</style>'))).toContain(PLACEHOLDER_CSS);
      expect(built.indexOf(PLACEHOLDER_CSS)).toBeLessThan(built.indexOf('<style>.hero'));
    }
  });

  it('does not freeze motion on a live page, and does in a settle frame', () => {
    expect(doc).not.toContain(FREEZE_MOTION_CSS);
    const settle = canvasDocument({ page: '/index.html', html: PAGE, blobUrls, mode: 'settle', deviceHeight: 900, loadId: 8 });
    expect(settle).toContain(FREEZE_MOTION_CSS);
    expect(settle).not.toContain(PAUSE_SHIM_JS);
  });
});

describe('a still document', () => {
  const snapshot = '<!doctype html><html><head><link rel="stylesheet" href="osw-asset:/styles/main.css"></head>'
    + '<body><main data-osw-src="/index.html:120" onclick="alert(1)"><img src="osw-asset:/images/hero.png"></main><script>window.evil = 1</script></body></html>';
  const doc = canvasDocument({ page: '/index.html', html: snapshot, blobUrls, mode: 'still', deviceHeight: 667, loadId: 9, nonce: 'abc123' });

  it('runs nothing but the bridge, which the CSP lets through by its nonce', () => {
    const head = doc.slice(doc.indexOf('<head>') + 6);
    expect(head.startsWith('<meta http-equiv="Content-Security-Policy" content="script-src \'nonce-abc123\'">')).toBe(true);
    const list = scripts(doc);
    expect(list).toHaveLength(1);
    expect(list[0].attrs).toBe(' nonce="abc123"');
    expect(doc).not.toContain('window.evil');
  });

  it('gets this compile\'s URLs for the files its snapshot names', () => {
    expect(doc).toContain('href="blob:http://app/css-1"');
    expect(doc).toContain('src="blob:http://app/img-1"');
    expect(doc).toContain(':root{--osw-vh:6.67px}');
    expect(doc).toContain(FREEZE_MOTION_CSS);
  });

  it('refuses to be built without a nonce', () => {
    expect(() => canvasDocument({ page: '/index.html', html: snapshot, blobUrls, mode: 'still', deviceHeight: 667, loadId: 9 })).toThrow();
  });
});

describe('newNonce', () => {
  it('is 16 random bytes as hex, a new one each time', () => {
    const nonces = Array.from({ length: 4 }, () => newNonce());
    for (const nonce of nonces) expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(nonces).size).toBe(4);
  });
});

describe('asset tokens', () => {
  it('name files instead of a compile\'s blob URLs, and come back as the next compile\'s', () => {
    const html = '<img src="blob:http://app/img-2"><img src="blob:http://app/img-1">';
    const tokens = toAssetTokens(html, blobUrls);
    expect(tokens).toBe('<img src="osw-asset:/images/hero.png.bak"><img src="osw-asset:/images/hero.png">');
    const next = new Map([['/images/hero.png', 'blob:http://app/new-1'], ['/images/hero.png.bak', 'blob:http://app/new-2']]);
    expect(fromAssetTokens(tokens, next)).toBe('<img src="blob:http://app/new-2"><img src="blob:http://app/new-1">');
  });
});

describe('withOverrides', () => {
  const PAGE = '<html><head><link rel="stylesheet" href="blob:h/main"><link rel="stylesheet" href="blob:h/ov"></head><body></body></html>';

  it('puts the Inspector\'s copy in a <style> where the link to the file was', () => {
    const out = withOverrides(PAGE, 'blob:h/ov', '.x { color: red; }');
    expect(out).toBe('<html><head><link rel="stylesheet" href="blob:h/main"><style data-osw-overrides>.x { color: red; }</style></head><body></body></html>');
  });

  it('marks the link when there is no newer copy, so the frame can swap one in later', () => {
    expect(withOverrides(PAGE, 'blob:h/ov', null)).toContain('<link data-osw-overrides rel="stylesheet" href="blob:h/ov">');
    expect(withOverrides(PAGE, 'blob:h/missing', null)).toBe(PAGE);
  });

  it('replaces a copy swapped in earlier, which a snapshot of a live page carries', () => {
    const snap = '<head><style data-osw-overrides>.old {}</style></head>';
    expect(withOverrides(snap, 'osw-asset:/overrides.css', '.new {}')).toBe('<head><style data-osw-overrides>.new {}</style></head>');
    // With nothing newer held, the page goes back to the compile's file.
    expect(withOverrides(snap, 'osw-asset:/overrides.css', null))
      .toBe('<head><link rel="stylesheet" href="osw-asset:/overrides.css" data-osw-overrides></head>');
  });

  it('adds the copy at the end of the head of a page with no link, and keeps a closing style tag inert', () => {
    const out = withOverrides('<head><title>t</title></head>', null, '.x { content: "</style><b>"; }');
    expect(out).toBe('<head><title>t</title><style data-osw-overrides>.x { content: "<\\/style><b>"; }</style></head>');
  });
});

describe('canvasDocument with overrides', () => {
  it('builds a live page with the newer copy in place of the file', () => {
    const blobUrls = new Map([['/overrides.css', 'blob:h/ov']]);
    const html = '<html><head><link rel="stylesheet" href="/overrides.css"></head><body></body></html>';
    const doc = canvasDocument({ page: '/index.html', html, blobUrls, mode: 'live', deviceHeight: 900, loadId: 1, overrides: '.x{}' });
    expect(doc).toContain('<style data-osw-overrides>.x{}</style>');
    expect(doc).not.toContain('href="blob:h/ov"');
  });

  it('builds a still from a snapshot with the newer copy too', () => {
    const blobUrls = new Map([['/overrides.css', 'blob:h/ov']]);
    const snap = '<html><head><link rel="stylesheet" href="osw-asset:/overrides.css"></head><body></body></html>';
    const doc = canvasDocument({ page: '/index.html', html: snap, blobUrls, mode: 'still', deviceHeight: 900, loadId: 1, nonce: 'n', overrides: '.x{}' });
    expect(doc).toContain('<style data-osw-overrides>.x{}</style>');
    const plain = canvasDocument({ page: '/index.html', html: snap, blobUrls, mode: 'still', deviceHeight: 900, loadId: 1, nonce: 'n' });
    expect(plain).toContain('<link data-osw-overrides rel="stylesheet" href="blob:h/ov">');
  });
});
