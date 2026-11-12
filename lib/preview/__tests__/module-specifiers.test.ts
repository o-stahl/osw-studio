import { describe, it, expect } from 'vitest';
import { MODULE_SCHEME, rewriteInlineModules, rewriteModuleSpecifiers } from '../module-specifiers';

/**
 * A module the preview loads from a blob URL has no path that `/lib/x.js` or `./x.js` could resolve
 * against, so the browser fails before it looks at the page's import map. The preview's copy of a
 * module names each project file it imports by a `MODULE_SCHEME` key, which the import map holds.
 */

const key = (path: string) => MODULE_SCHEME + path;

describe('rewriteModuleSpecifiers', () => {
  it('names project files by their key in static imports, re-exports and dynamic imports', async () => {
    const source = [
      "import a from '/lib/a.js';",
      'import "./side.js";',
      "export * from '../shared/re.js';",
      'export { x } from "./x.js";',
      "const d = await import('./dyn.js');",
    ].join('\n');
    expect(await rewriteModuleSpecifiers(source, '/scripts/main.js')).toBe([
      `import a from '${key('/lib/a.js')}';`,
      `import "${key('/scripts/side.js')}";`,
      `export * from '${key('/shared/re.js')}';`,
      `export { x } from "${key('/scripts/x.js')}";`,
      `const d = await import(${JSON.stringify(key('/scripts/dyn.js'))});`,
    ].join('\n'));
  });

  it('resolves dot segments, and stops at the project root', async () => {
    expect(await rewriteModuleSpecifiers("import a from '../../lib/./a.js';", '/a/b/main.js')).toBe(`import a from '${key('/lib/a.js')}';`);
    expect(await rewriteModuleSpecifiers("import a from '../../../a.js';", '/main.js')).toBe(`import a from '${key('/a.js')}';`);
  });

  it('leaves URLs, bare names, import.meta and computed imports alone', async () => {
    const source = [
      "import confetti from 'https://esm.sh/canvas-confetti';",
      "import lodash from 'lodash';",
      'console.log(import.meta.url);',
      'const m = await import(name);',
    ].join('\n');
    expect(await rewriteModuleSpecifiers(source, '/main.js')).toBe(source);
  });

  it('leaves what only looks like an import alone: strings, comments, templates and patterns', async () => {
    const source = [
      "const s = \"import y from '/no.js'\"; // import z from '/no2.js'",
      "/* import w from '/no3.js' */",
      "const t = `import q from '/no4.js'`;",
      "const r = /import k from '\\/no5.js'/;",
    ].join('\n');
    expect(await rewriteModuleSpecifiers(source, '/main.js')).toBe(source);
  });

  it('leaves a specifier with a query or a fragment alone', async () => {
    const source = "import a from './a.js?v=2';\nimport b from './b.js#x';";
    expect(await rewriteModuleSpecifiers(source, '/main.js')).toBe(source);
  });

  it('leaves a path it could not write back between the quotes alone', async () => {
    const source = 'import a from "./it\'s.js";';
    expect(await rewriteModuleSpecifiers(source, '/main.js')).toBe(source);
  });

  it('returns a source that does not parse as it was', async () => {
    const source = "import { from '/lib/a.js'";
    expect(await rewriteModuleSpecifiers(source, '/main.js')).toBe(source);
  });
});

describe('rewriteInlineModules', () => {
  it('names the project files an inline module imports by their key, resolved from the page', async () => {
    const html = "<script type=\"module\">import { a } from './lib.js'; import b from '../shared/b.js';</script>";
    expect(await rewriteInlineModules(html, '/pages/about.html')).toBe(
      `<script type="module">import { a } from '${key('/pages/lib.js')}'; import b from '${key('/shared/b.js')}';</script>`,
    );
  });

  it('leaves classic scripts and a module with a src alone', async () => {
    const html = "<script>import('./x.js')</script><script type=\"module\" src=\"./main.js\">import './y.js'</script>";
    expect(await rewriteInlineModules(html, '/pages/about.html')).toBe(html);
  });
});
