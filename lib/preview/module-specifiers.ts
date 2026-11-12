import type { ImportSpecifier } from 'es-module-lexer/js';

/**
 * The preview runs each project module from a blob URL, which has no path for `/lib/x.js` or
 * `./x.js` to resolve against: the browser fails ("base scheme isn't hierarchical") before it looks
 * at the page's import map. So the preview's copy of a module names each project file it imports by
 * a key under this scheme, and the import map maps every key to that file's blob.
 */
export const MODULE_SCHEME = 'osws-module:';

/** The project path a `/`, `./` or `../` specifier names from `fromPath`; null for anything else. */
function projectPath(specifier: string, fromPath: string): string | null {
  if (!/^\.{0,2}\//.test(specifier) || /[?#]/.test(specifier)) return null;
  const joined = specifier.startsWith('/') ? specifier : fromPath.slice(0, fromPath.lastIndexOf('/') + 1) + specifier;
  const parts: string[] = [];
  for (const segment of joined.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment && segment !== '.') parts.push(segment);
  }
  return '/' + parts.join('/');
}

/**
 * `source`, the module at `path`, with every static import, re-export and dynamic import of a
 * project file naming it by its `MODULE_SCHEME` key. Anything else, a source that does not parse,
 * and every source while the lexer cannot be loaded, is left as written.
 */
export async function rewriteModuleSpecifiers(source: string, path: string): Promise<string> {
  if (!/\b(?:import|export)\b/.test(source)) return source;
  let imports: readonly ImportSpecifier[];
  try {
    // The lexer's asm.js build: it needs neither WebAssembly nor eval.
    const { parse } = await import('es-module-lexer/js');
    [imports] = parse(source);
  } catch {
    return source;
  }

  let out = '';
  let last = 0;
  for (const entry of imports) {
    // `n` is the specifier's value; a computed dynamic import and import.meta have none.
    if (entry.n === undefined) continue;
    const target = projectPath(entry.n, path);
    if (!target) continue;
    const key = MODULE_SCHEME + target;
    if (entry.d === -1) {
      // A static import's range is the specifier between its quotes.
      if (/['"\\\n]/.test(key)) continue;
      out += source.slice(last, entry.s) + key;
    } else {
      // A dynamic import's range is its whole string literal.
      out += source.slice(last, entry.s) + JSON.stringify(key);
    }
    last = entry.e;
  }
  return last === 0 ? source : out + source.slice(last);
}

/**
 * `html`, a page at `pagePath`, with each inline `<script type="module">` naming the project files it
 * imports by their `MODULE_SCHEME` key, resolved from the page. The preview writes every page into
 * the same frame, whose address is not the page's, so a relative import there would resolve from
 * the wrong folder. A module with a `src` and a classic script are left as they are.
 */
export async function rewriteInlineModules(html: string, pagePath: string): Promise<string> {
  const parts: Array<string | Promise<string>> = [];
  let last = 0;
  for (const match of html.matchAll(/(<script\b([^>]*)>)([\s\S]*?)(<\/script\s*>)/gi)) {
    const [whole, open, attrs, code, close] = match;
    if (!/(?:^|\s)type\s*=\s*(["']?)module\1(?:\s|$)/i.test(attrs) || /(?:^|\s)src\s*=/i.test(attrs)) continue;
    parts.push(html.slice(last, match.index), open, rewriteModuleSpecifiers(code, pagePath), close);
    last = match.index + whole.length;
  }
  if (last === 0) return html;
  parts.push(html.slice(last));
  return (await Promise.all(parts)).join('');
}
