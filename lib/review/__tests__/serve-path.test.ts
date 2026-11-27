import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { folderSlashRedirect, resolveReviewFilePath, reviewMimeType } from '../serve-path';

/**
 * A review build is served by a route rather than a file server, so the containment a file server
 * would have given for free has to be done here. The segments arrive off the wire from a caller who
 * needed no account to reach this route, and they are joined onto a directory that sits next to
 * every other deployment's databases.
 */

let root: string;
let outside: string;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osws-review-serve-'));
  root = path.join(dir, 'deployments', 'dep-1', 'review-build');
  outside = dir;

  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<html>home</html>');
  fs.writeFileSync(path.join(root, 'about.html'), '<html>about</html>');
  fs.writeFileSync(path.join(root, 'assets', 'app.css'), 'body{}');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'index.html'), '<html>docs</html>');

  // A real file at every level a traversal could land on. Without these the traversal cases pass on
  // nothing being there rather than on the path being refused, which is not the property under test:
  // the deployment directory really does hold this deployment's databases, and the one above it
  // holds every other tenant's.
  for (const ancestor of [
    path.join(dir, 'deployments', 'dep-1'),
    path.join(dir, 'deployments'),
    dir,
  ]) {
    fs.writeFileSync(path.join(ancestor, 'SECRET.txt'), 'SECRET-MARKER');
  }
});

afterEach(() => {
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('resolveReviewFilePath', () => {
  it('resolves an ordinary path inside the review root', async () => {
    expect(await resolveReviewFilePath(root, ['assets', 'app.css'])).toBe(
      path.join(root, 'assets', 'app.css')
    );
    expect(await resolveReviewFilePath(root, ['index.html'])).toBe(path.join(root, 'index.html'));
  });

  it('serves index.html for an empty path', async () => {
    expect(await resolveReviewFilePath(root, [])).toBe(path.join(root, 'index.html'));
  });

  it('returns null for a file that is simply not there', async () => {
    expect(await resolveReviewFilePath(root, ['nope.css'])).toBeNull();
  });

  describe('traversal', () => {
    it('refuses segments that climb out of the review root', async () => {
      expect(await resolveReviewFilePath(root, ['..', 'SECRET.txt'])).toBeNull();
      expect(await resolveReviewFilePath(root, ['assets', '..', '..', '..', 'SECRET.txt'])).toBeNull();
    });

    /**
     * Next 16 percent-decodes each dynamic segment before the handler sees it, so `%2e%2e%2f` in the
     * URL arrives as one segment whose *text* is `../` — the router's own path normalization never
     * saw a `..` segment to strip. Verified against a running dev server: a request for
     * `/x/a/%2e%2e%2fb` yields params `['a', '../b']`, while `/x/a/%2e%2e/b` (a real slash) is
     * normalized away to `['b']` before matching. So the encoded form reaches disk-joining code
     * intact and this is the case that has to be caught here, not upstream.
     */
    it('refuses an encoded traversal, which arrives already decoded inside one segment', async () => {
      expect(await resolveReviewFilePath(root, ['../SECRET.txt'])).toBeNull();
      expect(await resolveReviewFilePath(root, ['assets/../../SECRET.txt'])).toBeNull();
      expect(await resolveReviewFilePath(root, ['../../../SECRET.txt'])).toBeNull();
    });

    it('refuses a traversal that climbs past the filesystem root', async () => {
      // `path.resolve` clamps at `/`, so enough `..` lands on an absolute path that really exists.
      expect(await resolveReviewFilePath(root, [`${'../'.repeat(40)}etc/passwd`])).toBeNull();
    });

    it('refuses a sibling directory that merely shares a name prefix', async () => {
      fs.mkdirSync(path.join(outside, 'deployments', 'dep-1', 'review-build-old'), { recursive: true });
      fs.writeFileSync(
        path.join(outside, 'deployments', 'dep-1', 'review-build-old', 'SECRET.txt'),
        'SECRET-MARKER'
      );

      expect(await resolveReviewFilePath(root, ['../review-build-old/SECRET.txt'])).toBeNull();
    });

    it('treats a double-encoded traversal as the ordinary filename it decodes to', async () => {
      // One decode leaves `%2e%2e%2fb`, which names no file and traverses nowhere.
      expect(await resolveReviewFilePath(root, ['%2e%2e%2fSECRET.txt'])).toBeNull();
    });

    it('refuses a NUL byte rather than letting it reach fs', async () => {
      expect(await resolveReviewFilePath(root, ['index.html\0.css'])).toBeNull();
    });
  });

  describe('fallbacks, matching the public deployment route', () => {
    it('falls back to .html for an extensionless path', async () => {
      expect(await resolveReviewFilePath(root, ['about'])).toBe(path.join(root, 'about.html'));
    });

    it('falls back to index.html for a directory', async () => {
      expect(await resolveReviewFilePath(root, ['docs'])).toBe(path.join(root, 'docs', 'index.html'));
      expect(await resolveReviewFilePath(root, ['docs', ''])).toBe(path.join(root, 'docs', 'index.html'));
    });

    it('prefers an exact hit over either fallback', async () => {
      fs.writeFileSync(path.join(root, 'docs.html'), '<html>docs page</html>');
      fs.writeFileSync(path.join(root, 'about'), 'raw');

      // `try_files {path} {path}.html {path}/index.html` — exact first, then .html, then index.
      expect(await resolveReviewFilePath(root, ['about'])).toBe(path.join(root, 'about'));
      expect(await resolveReviewFilePath(root, ['docs'])).toBe(path.join(root, 'docs.html'));
    });
  });
});

describe('reviewMimeType', () => {
  it('maps known extensions and falls back to octet-stream', () => {
    expect(reviewMimeType('page.html')).toBe('text/html');
    expect(reviewMimeType('app.css')).toBe('text/css');
    expect(reviewMimeType('bundle.js')).toBe('application/javascript');
    expect(reviewMimeType('logo.svg')).toBe('image/svg+xml');
    expect(reviewMimeType('font.woff2')).toBe('font/woff2');
    expect(reviewMimeType('archive.zip')).toBe('application/octet-stream');
    expect(reviewMimeType('noextension')).toBe('application/octet-stream');
  });

  it('reads the extension off the file name, not the directories above it', () => {
    // The route has an absolute path in hand, and tmp/deployment directories do contain dots.
    expect(reviewMimeType('/deployments/dep.1/review-build/page.html')).toBe('text/html');
    expect(reviewMimeType('/deployments/dep.css/review-build/logo.png')).toBe('image/png');
    expect(reviewMimeType('/deployments/dep.html/review-build/LICENSE')).toBe(
      'application/octet-stream'
    );
  });
});

describe('folderSlashRedirect', () => {
  const req = (url: string) => new Request(url);

  it("sends a folder's page asked for without its slash to the slash form, relative to where it is", () => {
    const res = folderSlashRedirect(req('https://s.example.com/deployments/d1/docs?x=1'), '/root/d1/docs/index.html', ['docs']);
    expect(res?.status).toBe(308);
    expect(res?.headers.get('location')).toBe('docs/?x=1');
  });

  it('leaves a request that has the slash, a page file, and an explicit index.html alone', () => {
    expect(folderSlashRedirect(req('https://s.example.com/deployments/d1/docs/'), '/root/d1/docs/index.html', ['docs', ''])).toBeNull();
    expect(folderSlashRedirect(req('https://s.example.com/deployments/d1/about'), '/root/d1/about.html', ['about'])).toBeNull();
    expect(folderSlashRedirect(req('https://s.example.com/deployments/d1/docs/index.html'), '/root/d1/docs/index.html', ['docs', 'index.html'])).toBeNull();
  });
});
