import { describe, it, expect, vi } from 'vitest';
import { compileStaticSite, TerminalRuntimeError } from '@/lib/publishing/compile-static-site';

function fakeVfs(runtime: string) {
  return {
    getProject: vi.fn().mockResolvedValue({ id: 'p1', name: 'P', settings: { runtime } }),
  } as any;
}

describe('compileStaticSite', () => {
  it('throws TerminalRuntimeError for python runtime', async () => {
    await expect(compileStaticSite(fakeVfs('python'), 'p1')).rejects.toBeInstanceOf(TerminalRuntimeError);
  });

  it('throws TerminalRuntimeError for lua runtime', async () => {
    await expect(compileStaticSite(fakeVfs('lua'), 'p1')).rejects.toBeInstanceOf(TerminalRuntimeError);
  });
});

describe('compileStaticSite, the exported site', () => {
  // The ZIP export and the Hugging Face Space publish both take their pages from here.
  it('leaves out the placeholder of a block nobody has built', async () => {
    const page = '<html><head></head><body>\n<h1>Site</h1>\n<div data-osw-block="hero-k3j9x2m1">Hero Section</div>\n</body></html>';
    const file = { id: 'f1', projectId: 'p1', path: '/index.html', name: 'index.html', type: 'html', content: page, size: page.length, createdAt: new Date(), updatedAt: new Date() };
    const vfs = {
      getProject: vi.fn().mockResolvedValue({ id: 'p1', name: 'P', settings: { runtime: 'static' } }),
      listFiles: vi.fn().mockResolvedValue([file]),
      listDirectory: vi.fn().mockResolvedValue([file]),
      readFile: vi.fn().mockResolvedValue(file),
      getAllFilesAndDirectories: vi.fn().mockResolvedValue([file]),
      getGeneratedFiles: () => [],
      clearGeneratedFiles: () => {},
      setGeneratedFile: () => {},
      isGeneratedPath: () => false,
      shouldExcludeFromExportPublic: () => false,
    } as any;
    URL.createObjectURL ??= (() => 'blob:x') as typeof URL.createObjectURL;
    URL.revokeObjectURL ??= (() => {}) as typeof URL.revokeObjectURL;

    const { files } = await compileStaticSite(vfs, 'p1');
    const index = files.find(f => f.path === 'index.html')!;
    expect(String(index.content)).toContain('<h1>Site</h1>');
    expect(String(index.content)).not.toContain('data-osw-block');
    expect(String(index.content)).not.toContain('Hero Section');
  });
});
