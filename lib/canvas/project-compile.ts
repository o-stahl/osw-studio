import type { VirtualFileSystem } from '@/lib/vfs';
import { VirtualServer } from '@/lib/preview/virtual-server';
import type { CompiledProject } from '@/lib/preview/types';
import type { ProjectRuntime } from '@/lib/vfs/types';
import { canvasSupport } from '@/lib/runtimes/registry';
import { pinViewportUnits } from './viewport-units';
import { toAssetTokens } from './compile';
import { pointPageAtBlobs, resolveFromPage } from '@/lib/preview/page-references';
import { hashText as hash } from './hash';
import type { CanvasCompile } from './engine';
import type { CanvasPage } from './types';

export interface CanvasProject {
  compile: CanvasCompile;
  pages: CanvasPage[];
  /** For turning a link's path into a page: what `navigate` messages carry. */
  routes: CompiledProject['routes'];
}

const asText = (content: string | ArrayBuffer) => (typeof content === 'string' ? content : '');

/**
 * Canvas's own compile of the project: with provenance where elements can be traced to source, and
 * with every stylesheet's `vh` pinned to the device height (`viewport-units.ts`), so an artboard as
 * tall as its page does not grow a screen-sized hero with it. `dispose` revokes the blob URLs it
 * made; whoever holds the result calls it when done with it.
 */
export async function compileForCanvas(
  fs: VirtualFileSystem,
  projectId: string,
  runtime: ProjectRuntime,
): Promise<{ project: CanvasProject; dispose: () => void }> {
  const server = new VirtualServer(fs, projectId, { runtime, provenance: canvasSupport(runtime) === 'edit', blobModules: true });
  const compiled = await server.compileProject();

  const blobUrls = new Map(compiled.blobUrls);
  const pinned: string[] = [];
  for (const file of compiled.files) {
    const text = asText(file.content);
    if (/\.css$/i.test(file.path) && text) {
      const url = URL.createObjectURL(new Blob([pinViewportUnits(text)], { type: 'text/css' }));
      pinned.push(url);
      blobUrls.set(file.path, url);
    }
  }
  const texts = new Map(compiled.files.map((f) => [f.path, asText(f.content)]));
  const deps = new Map<string, ReadonlySet<string>>();
  const pages = new Map<string, { html: string; signature: string }>();
  for (const route of compiled.routes) {
    const html = texts.get(route.file);
    if (html === undefined) continue;
    const uses = pageDependencies(route.file, html, compiled.blobUrls, texts, runtime === 'handlebars');
    deps.set(route.file, uses);
    // Hashed with blob URLs as file names: every compile makes new ones (the import map carries
    // them), and a page that did not change must not reload. A stylesheet or script counts only on
    // the pages that use it, so changing one reloads those and leaves the rest.
    let assetText = '';
    for (const path of [...uses].sort()) if (/\.(css|m?js|json)$/i.test(path)) assetText += `${path}\n${toAssetTokens(texts.get(path) ?? '', compiled.blobUrls)}\n`;
    pages.set(route.file, { html, signature: `${hash(toAssetTokens(html, compiled.blobUrls))}.${hash(assetText)}` });
  }

  // The home page first, then the rest in path order.
  const home = (file: string) => (file === '/index.html' ? 0 : 1);
  return {
    project: {
      compile: { blobUrls, pages, deps },
      pages: compiled.routes
        .filter((r) => pages.has(r.file))
        .sort((a, b) => home(a.file) - home(b.file) || a.file.localeCompare(b.file))
        .map((r) => ({ file: r.file, title: r.title || r.file })),
      routes: compiled.routes,
    },
    dispose: () => {
      server.cleanupBlobUrls();
      for (const url of pinned) URL.revokeObjectURL(url);
    },
  };
}

/** The page a link's path names, the way Live Preview resolves one (`loadPage`). */
export function pageForPath(routes: CompiledProject['routes'], pages: readonly CanvasPage[], path: string): string | null {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const route = routes.find((r) => r.path === normalized);
  const candidates = route
    ? [route.file]
    : normalized === '/'
      ? ['/index.html']
      : normalized.endsWith('.html')
        ? [normalized]
        : normalized.endsWith('/')
          ? [`${normalized}index.html`]
          : [`${normalized}.html`, `${normalized}/index.html`];
  return candidates.find((file) => pages.some((p) => p.file === file)) ?? null;
}

/**
 * A page's import map, which names every project file a module could import, so read as references
 * it would make every page use every file. Modules are followed by their own imports instead.
 */
const IMPORT_MAP = /<script\b[^>]*\btype\s*=\s*["']?importmap["']?[^>]*>[\s\S]*?<\/script\s*>/gi;
/** A module specifier: `import … from '…'`, `export … from '…'`, `import '…'`, `import('…')`. */
const MODULE_SPEC = /\b(?:import|export)\s*(?:[\w*{}\s,$]+?\s*from\s*)?\(?\s*["']([^"'\n]+)["']/g;

/** `@import` and `url()` references in a stylesheet. */
const CSS_REF = /@import\s+(?:url\()?\s*["']?([^"')\s;]+)|url\(\s*["']?([^"')\s]+)/g;
/** A provenance attribute's file: `data-osw-src="/templates/nav.hbs:12"`. */
const SRC_FILE = /data-osw-src="([^"]+):\d+"/g;

/**
 * The project files a compiled page uses: the page, the files its markup came from (its partials,
 * by provenance), what it references (stylesheets, scripts, images, by the same rules a render
 * points them at files, and module imports), and what those reference in turn (`@import`,
 * `url()`, module imports). The import map is not read: it names every file.
 * A Handlebars page also uses `/data.json`. This is what tells Canvas which artboards a changed
 * file affects.
 */
export function pageDependencies(
  page: string,
  html: string,
  blobUrls: ReadonlyMap<string, string>,
  texts: ReadonlyMap<string, string>,
  handlebars: boolean,
): Set<string> {
  const uses = new Set<string>([page]);
  for (const m of html.matchAll(SRC_FILE)) uses.add(m[1]);
  if (handlebars && texts.has('/data.json')) uses.add('/data.json');

  const byUrl = new Map<string, string>();
  for (const [path, url] of blobUrls) if (url) byUrl.set(url, path);
  const named = (text: string) => {
    const found: string[] = [];
    for (const [url, path] of byUrl) if (text.includes(url)) found.push(path);
    return found;
  };

  const isFile = (path: string) => texts.has(path) || blobUrls.has(path);
  /** The project files a module's imports (or a page's inline module scripts) name. */
  const imported = (text: string, from: string) => {
    const found: string[] = [];
    for (const m of text.matchAll(MODULE_SPEC)) {
      const spec = m[1].split(/[?#]/)[0];
      if (!/^\.{0,2}\//.test(spec)) continue;
      const resolved = resolveFromPage(from, spec);
      if (isFile(resolved)) found.push(resolved);
    }
    return found;
  };

  const markup = html.replace(IMPORT_MAP, '');
  const queue = [...named(pointPageAtBlobs(markup, page, blobUrls)), ...imported(markup, page)];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (uses.has(path)) continue;
    uses.add(path);
    const text = texts.get(path);
    if (!text || !/\.(css|m?js)$/i.test(path)) continue;
    queue.push(...named(text));
    if (/\.m?js$/i.test(path)) queue.push(...imported(text, path));
    if (/\.css$/i.test(path)) {
      for (const m of text.matchAll(CSS_REF)) {
        const ref = m[1] ?? m[2];
        if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue;
        const resolved = resolveFromPage(path, ref.split(/[?#]/)[0]);
        if (isFile(resolved)) queue.push(resolved);
      }
    }
  }
  return uses;
}
