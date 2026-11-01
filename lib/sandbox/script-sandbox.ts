/**
 * The worker that runs Python and Lua projects, started inside a sandboxed frame.
 *
 * A worker takes the origin of the page that starts it. Started from the app page, project code
 * could read the app's IndexedDB and call its API with the session cookie. So the app starts a
 * hidden frame sandboxed without `allow-same-origin` (opaque origin), sends it the worker's source,
 * and the frame starts the worker from its own blob URL. Files go in and output comes out by
 * message, through the frame:
 *
 *   host → frame  `sandbox:start` { source }  once, then  `sandbox:post` { data }  per request
 *   frame → host  `sandbox:ready`, `sandbox:message` { data }, `sandbox:error` { error }
 *
 * The frame relays whatever the worker posts, and the worker runs project code, so the host reads
 * nothing it has not checked (`scriptWorkerResponse`). Pyodide and wasmoon load from their CDNs,
 * which answer an opaque origin.
 */

import { createSandboxedFrame, PROJECT_SANDBOX } from './index';
import type { ScriptWorkerResponse } from '@/lib/scripting/types';

const WORKER_SOURCE_URL = '/workers/script-worker.js';

/** The frame's whole document. It answers only its parent. */
export const SCRIPT_FRAME_HTML = '<!doctype html><html><head><meta charset="utf-8"><script>(function(){'
  + 'var p=window.parent,w=null;'
  + 'function up(m){p.postMessage(m,"*");}'
  + 'addEventListener("message",function(e){var d=e.data;if(e.source!==p||!d)return;'
  + 'if(d.type==="sandbox:start"&&!w){'
  + 'try{w=new Worker(URL.createObjectURL(new Blob([String(d.source)],{type:"text/javascript"})));}'
  + 'catch(err){up({type:"sandbox:error",error:String(err&&err.message||err)});return;}'
  + 'w.onmessage=function(m){up({type:"sandbox:message",data:m.data});};'
  + 'w.onerror=function(ev){up({type:"sandbox:error",error:String(ev.message||"Unknown error")});};'
  + '}else if(d.type==="sandbox:post"&&w){w.postMessage(d.data);}'
  + '});'
  + 'up({type:"sandbox:ready"});'
  + '})();</script></head><body></body></html>';

const TEXT_TYPES = new Set(['stdout', 'stderr', 'status', 'error']);

/** Output files are named by the worker, flat under `/output/`. */
const OUTPUT_FILE_PATH = /^\/output\/(?!\.\.?$)[^/\\]+$/;

/** A worker message as the host may act on it, rebuilt from its checked fields; null otherwise. */
export function scriptWorkerResponse(value: unknown): ScriptWorkerResponse | null {
  if (!value || typeof value !== 'object') return null;
  const msg = value as Record<string, unknown>;
  const type = msg.type;
  if (typeof type !== 'string') return null;
  if (TEXT_TYPES.has(type)) {
    return typeof msg.data === 'string'
      ? { type: type as 'stdout' | 'stderr' | 'status' | 'error', data: msg.data }
      : null;
  }
  if (type === 'complete') {
    return Number.isInteger(msg.exitCode) ? { type, exitCode: msg.exitCode as number } : null;
  }
  if (type === 'output-file') {
    return typeof msg.path === 'string' && OUTPUT_FILE_PATH.test(msg.path) && typeof msg.content === 'string'
      ? { type, path: msg.path, content: msg.content }
      : null;
  }
  return null;
}

let workerSource: Promise<string> | null = null;

function loadWorkerSource(): Promise<string> {
  if (!workerSource) {
    workerSource = fetch(WORKER_SOURCE_URL).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
    workerSource.catch(() => { workerSource = null; });
  }
  return workerSource;
}

export interface ScriptSandboxHandlers {
  onMessage: (msg: ScriptWorkerResponse) => void;
  onError: (message: string) => void;
}

/**
 * One frame with one worker inside, shaped like a `Worker`: `postMessage` and
 * `terminate`. Messages posted before the frame is up wait for it. Terminating removes the frame,
 * which ends the worker with it.
 */
export class ScriptSandbox {
  private frame: HTMLIFrameElement | null;
  private queue: unknown[] = [];
  private started = false;

  constructor(private handlers: ScriptSandboxHandlers) {
    const frame = createSandboxedFrame(PROJECT_SANDBOX);
    frame.style.display = 'none';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.srcdoc = SCRIPT_FRAME_HTML;
    this.frame = frame;
    window.addEventListener('message', this.onWindowMessage);
    document.body.appendChild(frame);
  }

  postMessage(data: unknown): void {
    if (!this.frame) return;
    if (this.started) this.send({ type: 'sandbox:post', data });
    else this.queue.push(data);
  }

  terminate(): void {
    window.removeEventListener('message', this.onWindowMessage);
    this.frame?.remove();
    this.frame = null;
    this.queue = [];
  }

  private send(message: unknown): void {
    this.frame?.contentWindow?.postMessage(message, '*');
  }

  private onWindowMessage = (event: MessageEvent) => {
    const frame = this.frame;
    if (!frame || event.source !== frame.contentWindow) return;
    const data = event.data as { type?: unknown; data?: unknown; error?: unknown } | null;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'sandbox:ready') {
      void this.start(frame);
    } else if (data.type === 'sandbox:message') {
      const msg = scriptWorkerResponse(data.data);
      if (msg) this.handlers.onMessage(msg);
    } else if (data.type === 'sandbox:error') {
      this.handlers.onError(typeof data.error === 'string' ? data.error : 'Unknown error');
    }
  };

  private async start(frame: HTMLIFrameElement): Promise<void> {
    if (this.started) return;
    let source: string;
    try {
      source = await loadWorkerSource();
    } catch (err) {
      if (this.frame === frame) this.handlers.onError('Failed to load the script runner: ' + String(err));
      return;
    }
    if (this.frame !== frame || this.started) return;
    this.started = true;
    this.send({ type: 'sandbox:start', source });
    for (const data of this.queue.splice(0)) this.send({ type: 'sandbox:post', data });
  }
}
