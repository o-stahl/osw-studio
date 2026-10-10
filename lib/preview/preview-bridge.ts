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
 * - `preview:scroll` while scrolling, at most every 100 ms, so a recompile can put the reader back.
 * - `preview:capture`: runs the screenshot runtime the host sends (`lib/preview/frame-capture.ts`)
 *   and posts the result back. Only the host may ask.
 * - Storage: see `STORAGE_SHIM_JS`.
 */

import { PREVIEW_STORAGE_LIMIT } from './preview-storage';

/** Marks the bridge's `<script>` tag. */
export const PREVIEW_BRIDGE_ATTR = 'data-osw-bridge';

/**
 * In-memory `localStorage`, `sessionStorage` and `document.cookie`, installed only where the real
 * ones throw (the preview's opaque origin). Seeded from `window.__oswStorageSeed`, which the shell
 * sets before writing the page; every change is reported as `preview:storage` with the whole area,
 * and kept by the host per project (`lib/preview/preview-storage.ts`).
 */
const STORAGE_SHIM_JS = `
var seed=window.__oswStorageSeed||{};try{delete window.__oswStorageSeed;}catch(e){}
var LIMIT=${PREVIEW_STORAGE_LIMIT};
function report(area,data){post({type:'preview:storage',loadId:id,area:area,data:Object.assign({},data)});}
function throws(read){try{read();return false;}catch(e){return true;}}
function makeStorage(area){
var data=Object.assign(Object.create(null),seed[area]||{});
function size(){var n=0;for(var k in data)n+=k.length+data[k].length;return n;}
var api={
getItem:function(k){k=String(k);return k in data?data[k]:null;},
setItem:function(k,v){k=String(k);v=String(v);var had=k in data,prev=data[k];data[k]=v;
if(size()>LIMIT){if(had)data[k]=prev;else delete data[k];
throw new DOMException('The quota has been exceeded.','QuotaExceededError');}report(area,data);},
removeItem:function(k){k=String(k);if(k in data){delete data[k];report(area,data);}},
clear:function(){for(var k in data)delete data[k];report(area,data);},
key:function(i){var ks=Object.keys(data);return i>=0&&i<ks.length?ks[i]:null;}};
return new Proxy({},{
get:function(t,p){if(typeof p!=='string')return undefined;if(p==='length')return Object.keys(data).length;
if(Object.prototype.hasOwnProperty.call(api,p))return api[p];return p in data?data[p]:undefined;},
set:function(t,p,v){api.setItem(p,v);return true;},
deleteProperty:function(t,p){api.removeItem(p);return true;},
has:function(t,p){return p in data||Object.prototype.hasOwnProperty.call(api,p);},
ownKeys:function(){return Object.keys(data);},
getOwnPropertyDescriptor:function(t,p){return p in data?{value:data[p],writable:true,enumerable:true,configurable:true}:undefined;}});}
if(throws(function(){return window.localStorage;}))Object.defineProperty(window,'localStorage',{value:makeStorage('local'),configurable:true});
if(throws(function(){return window.sessionStorage;}))Object.defineProperty(window,'sessionStorage',{value:makeStorage('session'),configurable:true});
if(throws(function(){return document.cookie;})){
var jar=Object.assign({},seed.cookie||{});
Object.defineProperty(document,'cookie',{configurable:true,
get:function(){return Object.keys(jar).map(function(k){return k?k+'='+jar[k]:jar[k];}).join('; ');},
set:function(v){var parts=String(v).split(';'),nv=parts[0],i=nv.indexOf('=');
var name=i<0?'':nv.slice(0,i).trim(),val=i<0?nv.trim():nv.slice(i+1).trim(),gone=false;
parts.slice(1).forEach(function(a){var kv=a.split('='),n=kv[0].trim().toLowerCase(),x=(kv.slice(1).join('=')||'').trim();
if(n==='max-age'&&Number(x)<=0)gone=true;if(n==='expires'&&Date.parse(x)<Date.now())gone=true;});
if(gone)delete jar[name];else jar[name]=val;report('cookie',jar);}});}
`;

export function previewBridgeJs(loadId: number): string {
  const id = Math.trunc(loadId);
  return `(function(){var id=${id},p=window.parent,t=0;`
    + `function post(m,x){p.postMessage(m,'*',x||[]);}`
    + STORAGE_SHIM_JS
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

const HEAD_TAG = /<head(?:\s[^>]*)?>/i;
const HTML_TAG = /<html(?:\s[^>]*)?>/i;

/** `markup` first in the document's `<head>`, making one when there is none. Never `<header>`. */
export function prependToHead(html: string, markup: string): string {
  if (HEAD_TAG.test(html)) return html.replace(HEAD_TAG, (tag) => tag + markup);
  if (HTML_TAG.test(html)) return html.replace(HTML_TAG, (tag) => `${tag}<head>${markup}</head>`);
  return markup + html;
}
