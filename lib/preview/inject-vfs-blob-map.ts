/**
 * Put the blob-URL map where a compiled page's asset interceptor can find it.
 *
 * The interceptor resolves runtime requests — a `fetch`, a script setting `img.src` — through
 * `window.__oswVfsBlobUrls`. Compiled pages do not carry the map themselves: it is identical for
 * every page, so a project of several hundred pages used to hold several hundred copies of it.
 * Whoever renders a compiled page supplies it instead, which means every renderer has to, and a
 * renderer that forgets loses runtime assets with no error and nothing to search for.
 *
 * Used by the thumbnail capture. `components/preview/multipage-preview.tsx` builds the same script
 * inline because it injects it together with its per-load bridge; the two have to stay in step.
 */
export function injectVfsBlobMap(html: string, blobUrls: ReadonlyMap<string, string>): string {
  // The escape keeps a path containing `</script` from closing the tag it is written inside.
  const json = JSON.stringify(Object.fromEntries(blobUrls)).replace(/</g, '\\u003c');
  const script = `<script>window.__oswVfsBlobUrls = ${json};</script>`;

  // Into <head> so it runs before the page's own scripts, which may ask for an asset immediately.
  return html.includes('<head>')
    ? html.replace('<head>', '<head>' + script)
    : script + html;
}
