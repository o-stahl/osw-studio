// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// jsdom has no blob URLs: each one stands for the blob it was made from, so a test can read it.
const blobs = new Map<string, Blob>();
let blobCounter = 0;
URL.createObjectURL = ((blob: Blob) => {
  const url = `blob:http://localhost/${++blobCounter}`;
  blobs.set(url, blob);
  return url;
}) as typeof URL.createObjectURL;
URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
// jsdom's Blob has no text().
const text = (blob: Blob) => new Promise<string>((resolve) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.readAsText(blob);
});

/**
 * Project modules that import each other, as the preview compiles them. The preview runs each module
 * from its blob, so the blob names the files it imports by the import map's `MODULE_SCHEME` keys; the
 * compiled file keeps its source, since export and publishing take that, not the blob. An exported
 * page runs its modules from their files, so it carries no keys.
 */
describe('compileProject with modules that import each other', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    blobs.clear();
  });

  const main = "import { value } from '/lib/utils.js';\nimport { a } from './a.js';\nexport const v = value + a;";

  async function createProject() {
    const { vfs } = await import('@/lib/vfs');
    await vfs.init();
    const project = await vfs.createProject('Modules', 'fixture');
    await vfs.updateProject({ ...project, settings: { ...project.settings, runtime: 'static' } });
    await vfs.createFile(project.id, '/index.html', '<html><head></head><body><script type="module" src="/scripts/main.js"></script></body></html>', { silent: true });
    await vfs.createFile(project.id, '/scripts/main.js', main, { silent: true });
    await vfs.createFile(project.id, '/scripts/a.js', 'export const a = 1;', { silent: true });
    await vfs.createFile(project.id, '/lib/utils.js', 'export const value = 41;', { silent: true });
    return { vfs, project };
  }

  async function compile() {
    const { vfs, project } = await createProject();
    const { VirtualServer } = await import('../virtual-server');
    const { MODULE_SCHEME } = await import('../module-specifiers');
    const compiled = await new VirtualServer(vfs as never, project.id, { runtime: 'static', blobModules: true }).compileProject();
    return { compiled, main, MODULE_SCHEME };
  }

  it('names the files a module imports by their import-map key, in its blob only', async () => {
    const { compiled, main, MODULE_SCHEME } = await compile();

    const blob = blobs.get(compiled.blobUrls.get('/scripts/main.js')!)!;
    expect(await text(blob)).toBe(
      `import { value } from '${MODULE_SCHEME}/lib/utils.js';\nimport { a } from '${MODULE_SCHEME}/scripts/a.js';\nexport const v = value + a;`,
    );
    expect(compiled.files.find((f) => f.path === '/scripts/main.js')!.content).toBe(main);
  });

  it('puts every module under its key in the page\'s import map', async () => {
    const { compiled, MODULE_SCHEME } = await compile();

    const html = compiled.files.find((f) => f.path === '/index.html')!.content as string;
    const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]).imports;
    for (const path of ['/scripts/main.js', '/scripts/a.js', '/lib/utils.js']) {
      expect(imports[MODULE_SCHEME + path], path).toBe(compiled.blobUrls.get(path));
    }
  });

  it('leaves the keys out of an exported page and its modules', async () => {
    const { vfs, project } = await createProject();
    const { compileStaticSite } = await import('@/lib/publishing/compile-static-site');
    const { MODULE_SCHEME } = await import('../module-specifiers');

    const { files } = await compileStaticSite(vfs as never, project.id);

    const html = files.find((f) => f.path === 'index.html')!.content as string;
    expect(html).toContain('<script type="module" src="/scripts/main.js">');
    expect(html).not.toContain(MODULE_SCHEME);
    expect(files.find((f) => f.path === 'scripts/main.js')!.content).toBe(main);
  });
});

/**
 * A site in folders: a page in `/pages/` reaching its stylesheet, its module and a neighbour by
 * relative paths, and modules importing a JSON file and a stylesheet. The preview resolves each
 * from the page's or module's own folder, as a browser does; export keeps what was written.
 */
describe('compileProject with a site in folders', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    blobs.clear();
  });

  const about = '<html><head><link href="../styles/main.css" rel="stylesheet"></head><body>'
    + '<script type="module" src="../scripts/about.js"></script>'
    + "<script type=\"module\">import { local } from './local.js'; document.title = local;</script></body></html>";

  async function createSite() {
    const { vfs } = await import('@/lib/vfs');
    await vfs.init();
    const project = await vfs.createProject('Folders', 'fixture');
    await vfs.updateProject({ ...project, settings: { ...project.settings, runtime: 'static' } });
    const files: Record<string, string> = {
      '/index.html': '<html><head></head><body><script type="module" src="scripts/about.js"></script></body></html>',
      '/pages/about.html': about,
      '/pages/local.js': "export const local = 'local';",
      '/scripts/about.js': "import cfg from '../data/config.json' with { type: 'json' };\nimport sheet from '../styles/theme.css' with { type: 'css' };\nexport const name = cfg.name;",
      '/data/config.json': '{ "name": "osws" }',
      '/styles/main.css': 'body { color: red; }',
      '/styles/theme.css': 'h1 { color: blue; }',
    };
    for (const [path, content] of Object.entries(files)) await vfs.createFile(project.id, path, content, { silent: true });
    return { vfs, project };
  }

  it('points a page in a folder at its module, names its neighbour by key, and maps JSON and stylesheets', async () => {
    const { vfs, project } = await createSite();
    const { VirtualServer } = await import('../virtual-server');
    const { MODULE_SCHEME } = await import('../module-specifiers');
    const compiled = await new VirtualServer(vfs as never, project.id, { runtime: 'static', blobModules: true }).compileProject();

    const html = compiled.files.find((f) => f.path === '/pages/about.html')!.content as string;
    expect(html).toContain(`<script type="module" src="${compiled.blobUrls.get('/scripts/about.js')}">`);
    expect(html).toContain(`import { local } from '${MODULE_SCHEME}/pages/local.js'`);
    const imports = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]).imports;
    for (const path of ['/data/config.json', '/styles/theme.css', '/pages/local.js']) {
      expect(compiled.blobUrls.get(path), path).toMatch(/^blob:/);
      expect(imports[MODULE_SCHEME + path], path).toBe(compiled.blobUrls.get(path));
    }
  });

  it('leaves stylesheet links, and in an export the inline module, as written', async () => {
    const { vfs, project } = await createSite();
    const { VirtualServer } = await import('../virtual-server');
    const { compileStaticSite } = await import('@/lib/publishing/compile-static-site');
    const { MODULE_SCHEME } = await import('../module-specifiers');

    const compiled = await new VirtualServer(vfs as never, project.id, { runtime: 'static', blobModules: true }).compileProject();
    expect(compiled.files.find((f) => f.path === '/pages/about.html')!.content).toContain('<link href="../styles/main.css" rel="stylesheet">');

    const { files } = await compileStaticSite(vfs as never, project.id);
    const exported = files.find((f) => f.path === 'pages/about.html')!.content as string;
    expect(exported).toContain('<link href="../styles/main.css" rel="stylesheet">');
    expect(exported).toContain('<script type="module" src="/scripts/about.js">');
    expect(exported).toContain("import { local } from './local.js'");
    expect(exported).not.toContain(MODULE_SCHEME);
  });
});

