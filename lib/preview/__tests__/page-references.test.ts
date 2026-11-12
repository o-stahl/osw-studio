import { describe, it, expect } from 'vitest';
import { pointPageAtBlobs, resolveFromPage } from '../page-references';

/**
 * A page's references to stylesheets, scripts and images, as the preview finds their files. A
 * browser resolves a relative reference from the page's own folder, so a page in `/pages/` reaches
 * `/styles/main.css` by `../styles/main.css`. Pages were resolved from the project root, which a
 * reference that leaves its folder never matched; the root stays as the fallback, so a reference
 * that only works from the root keeps working.
 */

describe('resolveFromPage', () => {
  it('resolves from the page\'s folder, a leading slash from the root, and stops at the root', () => {
    expect(resolveFromPage('/pages/about.html', '../styles/main.css')).toBe('/styles/main.css');
    expect(resolveFromPage('/pages/about.html', './lib.js')).toBe('/pages/lib.js');
    expect(resolveFromPage('/pages/about.html', 'lib.js')).toBe('/pages/lib.js');
    expect(resolveFromPage('/pages/about.html', '/scripts/app.js')).toBe('/scripts/app.js');
    expect(resolveFromPage('/index.html', '../../x.js')).toBe('/x.js');
  });
});

describe('pointPageAtBlobs', () => {
  const blobs = new Map([
    ['/styles/main.css', 'blob:x/1'],
    ['/scripts/about.js', 'blob:x/2'],
    ['/images/logo.png', 'blob:x/3'],
    ['/pages/local.js', 'blob:x/4'],
    ['/cdn.test/y.js', 'blob:x/5'],
  ]);

  it('points a page in a folder at the files its relative references name', () => {
    const html = '<link href="../styles/main.css" rel="stylesheet"><script src="../scripts/about.js"></script><img src=\'../images/logo.png\'><script src="./local.js"></script>';
    expect(pointPageAtBlobs(html, '/pages/about.html', blobs)).toBe(
      '<link href="blob:x/1" rel="stylesheet"><script src="blob:x/2"></script><img src=\'blob:x/3\'><script src="blob:x/4"></script>',
    );
  });

  it('falls back to the root for a reference only the root resolves', () => {
    expect(pointPageAtBlobs('<link href="styles/main.css">', '/pages/about.html', blobs)).toBe('<link href="blob:x/1">');
  });

  it('leaves external references, a project file of the same name included, and unknown files alone', () => {
    const html = '<script src="https://cdn.test/x.js"></script><script src="//cdn.test/y.js"></script><link href="missing.css">';
    expect(pointPageAtBlobs(html, '/index.html', blobs)).toBe(html);
  });
});
