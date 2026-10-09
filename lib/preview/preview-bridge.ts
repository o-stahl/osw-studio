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
 */
export function previewBridgeScript(loadId: number): string {
  const id = Math.trunc(loadId);
  return `<script>(function(){var id=${id},p=window.parent,t=0;`
    + `addEventListener('load',function(){p.postMessage({type:'preview:ready',loadId:id},'*');});`
    + `addEventListener('scroll',function(){if(t)return;t=setTimeout(function(){t=0;`
    + `p.postMessage({type:'preview:scroll',loadId:id,x:scrollX,y:scrollY},'*');},100);},{passive:true});`
    + `})();</script>`;
}
