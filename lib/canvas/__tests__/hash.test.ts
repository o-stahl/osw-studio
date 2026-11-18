import { describe, it, expect, vi } from 'vitest';
import type { CompiledProject } from '@/lib/preview/types';
import type { VirtualFileSystem } from '@/lib/vfs';

/**
 * `hashText`, and the page signatures Canvas compiles with it: what decides which artboards reload
 * and settle again after a change. The project's compile is stubbed with the files a test gives it.
 */

const next = vi.hoisted(() => ({ compiled: null as CompiledProject | null }));
vi.mock('@/lib/preview/virtual-server', () => ({
  VirtualServer: class {
    async compileProject() { return next.compiled!; }
    cleanupBlobUrls() {}
  },
}));

import { hashText } from '../hash';
import { compileForCanvas } from '../project-compile';

describe('hashText', () => {
  it('tells apart two texts of the same length, and gives one text the same hash every time', () => {
    expect(hashText('ab')).not.toBe(hashText('ba'));
    expect(hashText('<h1>Hi</h1>')).not.toBe(hashText('<h1>Ho</h1>'));
    expect(hashText('<h1>Hi</h1>')).toBe(hashText('<h1>Hi</h1>'));
  });
});

describe('a page\'s signature', () => {
  /**
   * A compile of two pages, the home page linking `/site.css`. `version` names the blob URLs, which
   * every compile makes anew.
   */
  function compiled(version: string, home = '<h1>Hi</h1>', css = 'h1{color:red}'): CompiledProject {
    const url = (path: string) => `blob:http://localhost/${version}${path}`;
    const files = [
      { path: '/index.html', content: `<link rel="stylesheet" href="${url('/site.css')}">${home}`, mimeType: 'text/html' },
      { path: '/about.html', content: '<p>About</p>', mimeType: 'text/html' },
      { path: '/site.css', content: css, mimeType: 'text/css' },
    ];
    return {
      entryPoint: '/index.html',
      routes: [{ path: '/', file: '/index.html', title: 'Home' }, { path: '/about', file: '/about.html', title: 'About' }],
      files,
      blobUrls: new Map(files.map((f) => [f.path, url(f.path)])),
    };
  }

  async function signatures(project: CompiledProject): Promise<Record<string, string>> {
    next.compiled = project;
    const { project: canvas, dispose } = await compileForCanvas({} as VirtualFileSystem, 'p1', 'static');
    dispose();
    return Object.fromEntries([...canvas.compile.pages].map(([page, { signature }]) => [page, signature]));
  }

  it('stays the same across compiles of the same files, whose blob URLs differ', async () => {
    expect(await signatures(compiled('v2'))).toEqual(await signatures(compiled('v1')));
  });

  it('changes for the page whose content changed, and only that one', async () => {
    const before = await signatures(compiled('v1'));
    const after = await signatures(compiled('v2', '<h1>Ho</h1>'));
    expect(after['/index.html']).not.toBe(before['/index.html']);
    expect(after['/about.html']).toBe(before['/about.html']);
  });

  it('changes for a page whose stylesheet changed, and not for a page without it', async () => {
    const before = await signatures(compiled('v1'));
    const after = await signatures(compiled('v2', undefined, 'h1{color:tan}'));
    expect(after['/index.html']).not.toBe(before['/index.html']);
    expect(after['/about.html']).toBe(before['/about.html']);
  });
});
