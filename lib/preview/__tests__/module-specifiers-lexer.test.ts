import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * The lexer behind `rewriteModuleSpecifiers` where a browser does not run it as usual. It needs no
 * WebAssembly, and a lexer that cannot be loaded at all leaves each module as written rather than
 * failing the compile, export or publish that asked for it.
 */

afterEach(() => {
  vi.doUnmock('es-module-lexer');
  vi.doUnmock('es-module-lexer/js');
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('rewriteModuleSpecifiers', () => {
  it('names project files by their key with WebAssembly unavailable', async () => {
    vi.stubGlobal('WebAssembly', undefined);
    const { MODULE_SCHEME, rewriteModuleSpecifiers } = await import('../module-specifiers');

    expect(await rewriteModuleSpecifiers("import a from './a.js';", '/main.js')).toBe(`import a from '${MODULE_SCHEME}/a.js';`);
  });

  it('leaves the source as written when the lexer cannot be loaded', async () => {
    const fail = () => { throw new Error('Loading chunk failed'); };
    vi.doMock('es-module-lexer', fail);
    vi.doMock('es-module-lexer/js', fail);
    const { rewriteModuleSpecifiers } = await import('../module-specifiers');

    const source = "import a from './a.js';";
    expect(await rewriteModuleSpecifiers(source, '/main.js')).toBe(source);
  });
});
