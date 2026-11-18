import { describe, it, expect } from 'vitest';
import { pageDependencies } from '../project-compile';

/**
 * Which files a page uses: what tells Canvas which artboards a changed file affects, and what each
 * page's signature is made from.
 */

const blob = (path: string) => `blob:http://localhost/${encodeURIComponent(path)}`;
const PATHS = ['/index.html', '/about.html', '/styles/main.css', '/styles/base.css', '/img/logo.png', '/scripts/app.js', '/scripts/util.js', '/overrides.css', '/data.json', '/fonts/a.woff2'];
const blobUrls = new Map(PATHS.map((p) => [p, blob(p)]));

describe('pageDependencies', () => {
  it('follows links, scripts, images, imports and partials from a page', () => {
    const html = '<link rel="stylesheet" href="styles/main.css"><link rel="stylesheet" href="/overrides.css">' +
      '<script src="/scripts/util.js"></script>' +
      '<img src="/img/logo.png"><nav data-osw-src="/templates/nav.hbs:0"></nav><h1 data-osw-src="/index.html:40"></h1>';
    const texts = new Map([
      ['/styles/main.css', '@import url("base.css");\n.hero { background: url(../img/logo.png) }'],
      ['/styles/base.css', '@font-face { src: url("/fonts/a.woff2") }'],
      ['/scripts/util.js', 'export const x = 1;'],
      ['/data.json', '{}'],
    ]);
    expect([...pageDependencies('/index.html', html, blobUrls, texts, true)].sort()).toEqual([
      '/data.json', '/fonts/a.woff2', '/img/logo.png', '/index.html', '/overrides.css',
      '/scripts/util.js', '/styles/base.css', '/styles/main.css', '/templates/nav.hbs',
    ]);
  });

  it('follows module imports rather than the import map, which names every file', () => {
    const map = `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(PATHS.map((p) => [p, blob(p)])) })}</script>`;
    const html = `${map}<script type="module">import { start } from './scripts/app.js'; start();</script>`;
    const texts = new Map([
      ['/scripts/app.js', "import { x } from './util.js';\nexport const start = () => import('/data.json', { with: { type: 'json' } });"],
      ['/scripts/util.js', 'export const x = 1;'],
      ['/data.json', '{}'],
    ]);
    expect([...pageDependencies('/index.html', html, blobUrls, texts, false)].sort()).toEqual(['/data.json', '/index.html', '/scripts/app.js', '/scripts/util.js']);
  });

  it('leaves out what a page does not use', () => {
    const uses = pageDependencies('/about.html', '<p>About</p><script src="/scripts/app.js"></script>', blobUrls, new Map(), false);
    expect([...uses].sort()).toEqual(['/about.html', '/scripts/app.js']);
  });

  it('counts /data.json only for a Handlebars page, whose templates read it', () => {
    const texts = new Map([['/data.json', '{}']]);
    expect([...pageDependencies('/about.html', '<p>About</p>', blobUrls, texts, false)]).toEqual(['/about.html']);
    expect([...pageDependencies('/about.html', '<p>About</p>', blobUrls, texts, true)].sort()).toEqual(['/about.html', '/data.json']);
  });
});
