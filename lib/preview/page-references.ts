/**
 * `ref` as a browser resolves it from a page or stylesheet at `fromPath`: against that file's folder,
 * or against the root for a reference that starts with `/`. A `..` above the root stays at the root.
 */
export function resolveFromPage(fromPath: string, ref: string): string {
  const base = ref.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
  const out: string[] = [];
  for (const part of [...base, ...ref.split('/')]) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}

/** A URL with a scheme (`https:`, `data:`, `blob:`) or a protocol-relative one: not a project file. */
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * The blob URL a page's reference names: the file it resolves to from the page's folder, or, for a
 * reference that only matches from the project root, that file.
 */
function blobFor(ref: string, pagePath: string, blobUrls: ReadonlyMap<string, string>): string | undefined {
  if (EXTERNAL.test(ref)) return undefined;
  return blobUrls.get(resolveFromPage(pagePath, ref)) ?? blobUrls.get(resolveFromPage('/', ref));
}

/**
 * `html`, a compiled page at `pagePath`, with the stylesheets, scripts and images it names pointed at
 * their blob URLs, for a renderer to load. A compile leaves stylesheet links as written, so that an
 * exported page keeps them; whoever renders the page points them here.
 */
export function pointPageAtBlobs(html: string, pagePath: string, blobUrls: ReadonlyMap<string, string>): string {
  const point = (match: string, attr: string, quote: string, ref: string) => {
    const blobUrl = blobFor(ref, pagePath, blobUrls);
    return blobUrl ? `${attr}=${quote}${blobUrl}${quote}` : match;
  };
  return html
    .replace(/(href)=(["'])([^"']+\.css)\2/g, (m, attr, q, ref) => point(m, attr, q, ref))
    .replace(/(src)=(["'])([^"']+\.m?js)\2/g, (m, attr, q, ref) => point(m, attr, q, ref))
    .replace(/(src)=(["'])([^"']+\.(?:png|jpe?g|gif|svg|webp))\2/gi, (m, attr, q, ref) => point(m, attr, q, ref));
}
