/**
 * The page a preview frame is first given, and how the real page reaches it.
 *
 * The frame is sandboxed without `allow-same-origin`, so it runs on an opaque origin and cannot reach
 * the app: not its storage, not its IndexedDB, not its session. The cost is that the `blob:` URLs the
 * host made for the project's files do not load there. So the frame is given this shell, which asks
 * for the page (`preview:shell-ready`); the host answers with the HTML and every blob it refers to
 * (`preview:shell-content`); the shell makes its own URL for each blob, puts them in place of the
 * host's in the HTML and in any text asset that refers to another, and writes the page with
 * `document.open/write/close`. The window survives that, so the URLs it made stay valid.
 *
 * Text assets are rewritten in dependency order (a stylesheet after the images it names, a module
 * after the modules it imports), which works because a URL is only made once its contents are final.
 */

import type { PreviewStorageSnapshot } from './preview-storage';

export const SHELL_READY = 'preview:shell-ready';
export const SHELL_CONTENT = 'preview:shell-content';

export interface ShellAsset {
  url: string;
  blob: Blob;
  text: boolean;
}

function isTextType(type: string): boolean {
  return /^text\/|javascript|json|xml|svg/i.test(type);
}

/** The host's blob URLs, as the shell has to find them: `blob:<origin>/<uuid>`. */
export function blobUrlPrefix(origin: string): string {
  return `blob:${origin}/`;
}

function blobUrlPattern(origin: string): RegExp {
  const prefix = blobUrlPrefix(origin).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${prefix}[0-9a-fA-F-]+`, 'g');
}

export function previewShellHtml(loadId: number): string {
  const id = Math.trunc(loadId);
  return `<!doctype html><html><head><meta charset="utf-8"><script>(function(){`
    + `var id=${id},p=window.parent,done=false;`
    + `function fail(err){p.postMessage({type:'preview:shell-error',loadId:id,error:String(err&&err.message||err)},'*');}`
    + `addEventListener('message',function(e){var d=e.data;`
    + `if(done||e.source!==p||!d||d.type!=='${SHELL_CONTENT}'||d.loadId!==id)return;done=true;`
    + `var esc=d.prefix.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&'),re=new RegExp(esc+'[0-9a-fA-F-]+','g');`
    + `var made={},known={},texts=[];`
    + `d.assets.forEach(function(a){known[a.url]=1;if(a.text)texts.push(a);else made[a.url]=URL.createObjectURL(a.blob);});`
    + `function swap(t){return t.replace(re,function(u){return made[u]||u;});}`
    + `Promise.all(texts.map(function(a){return a.blob.text().then(function(t){return{a:a,t:t};});})).then(function(list){`
    + `while(list.length){var rest=[];list.forEach(function(x){`
    + `var waits=(x.t.match(re)||[]).some(function(u){return u!==x.a.url&&known[u]&&!made[u];});`
    + `if(waits)rest.push(x);else made[x.a.url]=URL.createObjectURL(new Blob([swap(x.t)],{type:x.a.blob.type}));});`
    + `if(rest.length===list.length){rest.forEach(function(x){made[x.a.url]=URL.createObjectURL(new Blob([swap(x.t)],{type:x.a.blob.type}));});rest=[];}`
    + `list=rest;}`
    + `window.__oswStorageSeed=d.storage||{};`
    + `var html=swap(d.html);document.open();document.write(html);document.close();`
    + `}).catch(fail);});`
    + `p.postMessage({type:'${SHELL_READY}',loadId:id},'*');`
    + `})();</script></head><body></body></html>`;
}

/**
 * Every blob the page needs: the ones it names, the ones those name, and the project's file map
 * (which the page's fetch interceptor resolves at run time). Read from the host's own URLs, which
 * it can still fetch. `cache` holds blobs across loads of the same compile; blob URLs never change
 * content.
 */
export async function collectShellAssets(
  html: string,
  blobUrls: Iterable<string>,
  origin: string,
  cache?: Map<string, Blob>,
): Promise<ShellAsset[]> {
  const pattern = blobUrlPattern(origin);
  const seen = new Set<string>();
  const queue: string[] = [];
  const add = (url: string) => {
    if (!seen.has(url) && url.startsWith(blobUrlPrefix(origin))) {
      seen.add(url);
      queue.push(url);
    }
  };
  for (const url of blobUrls) add(url);
  for (const url of html.match(pattern) ?? []) add(url);

  const assets: ShellAsset[] = [];
  while (queue.length) {
    const batch = queue.splice(0);
    const fetched = await Promise.all(batch.map(async (url) => {
      let blob = cache?.get(url);
      if (!blob) {
        try {
          blob = await (await fetch(url)).blob();
        } catch {
          return null; // revoked by a newer compile; the page will show a missing asset, as before
        }
        cache?.set(url, blob);
      }
      return { url, blob, text: isTextType(blob.type) };
    }));
    for (const asset of fetched) {
      if (!asset) continue;
      assets.push(asset);
      if (asset.text) for (const url of (await asset.blob.text()).match(pattern) ?? []) add(url);
    }
  }
  return assets;
}

/** Answer a shell's `preview:shell-ready` with the page. */
export async function sendShellContent(
  target: Window,
  loadId: number,
  html: string,
  blobUrls: Iterable<string>,
  cache?: Map<string, Blob>,
  storage?: PreviewStorageSnapshot,
): Promise<void> {
  const origin = window.location.origin;
  const assets = await collectShellAssets(html, blobUrls, origin, cache);
  target.postMessage({ type: SHELL_CONTENT, loadId, html, assets, prefix: blobUrlPrefix(origin), storage }, '*');
}

/**
 * Write a page into a sandboxed frame through the shell and wait for it to report its load (the
 * bridge's `preview:ready`). For the offscreen frames that render a project once, such as thumbnails.
 */
export function loadIntoShell(
  iframe: HTMLIFrameElement,
  html: string,
  blobUrls: Iterable<string>,
  timeoutMs: number,
  storage?: PreviewStorageSnapshot,
): Promise<void> {
  const loadId = 0;
  return new Promise<void>((resolve, reject) => {
    const finish = (err?: Error) => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const data = event.data as { type?: string; loadId?: number; error?: string } | null;
      if (!data || data.loadId !== loadId) return;
      if (data.type === SHELL_READY) {
        sendShellContent(iframe.contentWindow!, loadId, html, blobUrls, undefined, storage).catch((err) => finish(err));
      } else if (data.type === 'preview:ready') {
        finish();
      } else if (data.type === 'preview:shell-error') {
        finish(new Error(data.error || 'shell failed'));
      }
    };
    const timer = setTimeout(() => finish(new Error(`page did not load within ${timeoutMs}ms`)), timeoutMs);
    window.addEventListener('message', onMessage);
    iframe.srcdoc = previewShellHtml(loadId);
  });
}
