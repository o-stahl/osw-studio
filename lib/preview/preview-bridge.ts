/**
 * The first script in every document the preview writes.
 *
 * The host does not read the frame: project code runs there, so the frame is kept from reaching the
 * app, and what the host needs to know about the document is reported by message instead. It is
 * the first thing in `<head>`, so it is registered before any project script can stop it.
 *
 * - `preview:ready` on the document's load event, carrying the `loadId` it was written with. The
 *   host pairs it with the iframe's own load event; a load nothing reports for is a page that is
 *   not ours.
 * - `preview:scroll`, trailing after scrolling stops, so a recompile can put the reader back.
 * - `preview:capture`: runs the screenshot runtime the host sends (`lib/preview/frame-capture.ts`)
 *   and posts the result back. Only the host may ask.
 */

/** Marks the bridge's `<script>`, so a frame that already has one is not given a second. */
export const PREVIEW_BRIDGE_ATTR = 'data-osw-bridge';

export function previewBridgeJs(loadId: number): string {
  const id = Math.trunc(loadId);
  return `(function(){var id=${id},p=window.parent,t=0;`
    + `function post(m,x){p.postMessage(m,'*',x||[]);}`
    + `addEventListener('load',function(){post({type:'preview:ready',loadId:id});});`
    + `addEventListener('scroll',function(){if(t)return;t=setTimeout(function(){t=0;`
    + `post({type:'preview:scroll',loadId:id,x:scrollX,y:scrollY});},100);},{passive:true});`
    + `addEventListener('message',function(e){var d=e.data;`
    + `if(e.source!==p||!d||d.type!=='preview:capture'||typeof d.runtime!=='string')return;`
    + `try{new Function('msg','post',d.runtime)(d,post);}`
    + `catch(err){post({type:'preview:capture-result',reqId:d.reqId,error:String(err)});}});`
    + `})();`;
}

export function previewBridgeScript(loadId: number): string {
  return `<script ${PREVIEW_BRIDGE_ATTR}>${previewBridgeJs(loadId)}</script>`;
}
