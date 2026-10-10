// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { answerFunctionCall, functionCallPath, runFunctionCall, type FunctionCall } from '../function-proxy';

vi.mock('@/lib/utils', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/**
 * Edge-function calls from the sandboxed preview go through the host: the frame's origin is `null`
 * and the function route answers no other origin. The host side must make only this deployment's
 * function calls; the frame side must turn fetch, XHR and form posts into those calls.
 */

const ORIGIN = 'http://app.test';

describe('functionCallPath', () => {
  it("accepts this deployment's functions, query included", () => {
    expect(functionCallPath('/api/deployments/d1/functions/contact?x=1', 'd1', ORIGIN)).toBe('/api/deployments/d1/functions/contact?x=1');
  });

  it('refuses anything else the frame might ask the host to fetch', () => {
    for (const path of [
      '/api/deployments/d2/functions/contact',       // another deployment
      '/api/deployments/d1/functions/../../../w/ws/sync/status', // climbs out
      '/api/w/ws/sync/status',
      '/api/deployments/d1/functions/',               // no function named
      'http://evil.test/api/deployments/d1/functions/x',
      '//evil.test/api/deployments/d1/functions/x',
      'api/deployments/d1/functions/x',
    ]) {
      expect(functionCallPath(path, 'd1', ORIGIN), path).toBeNull();
    }
    expect(functionCallPath('/api/deployments/d1/functions/x', null, ORIGIN)).toBeNull();
  });
});

describe('runFunctionCall', () => {
  const call = (over: Partial<FunctionCall> = {}): FunctionCall => ({
    type: 'preview:function-call', id: 3, path: '/api/deployments/d1/functions/echo', method: 'POST',
    headers: [['content-type', 'application/json']], body: new TextEncoder().encode('{"a":1}').buffer, ...over,
  });

  afterEach(() => vi.unstubAllGlobals());

  it('makes the call same-origin and answers with the response', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 201, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const reply = await runFunctionCall(call(), 'd1', ORIGIN);

    expect(fetchMock).toHaveBeenCalledWith(`${ORIGIN}/api/deployments/d1/functions/echo`, expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
    expect(reply).toMatchObject({ type: 'preview:function-response', id: 3, status: 201 });
    expect(new TextDecoder().decode(reply.body!)).toBe('{"ok":true}');
  });

  it('refuses a path outside the deployment without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const reply = await runFunctionCall(call({ path: '/api/w/ws/sync/status' }), 'd1', ORIGIN);
    expect(reply.error).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a no-content status with no body, which the frame can turn back into a Response', async () => {
    // `new Response(body, { status: 204 })` throws for any body but null, so the frame's fetch would fail.
    for (const status of [204, 304]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status })));
      const reply = await runFunctionCall(call(), 'd1', ORIGIN);
      expect(reply.body, String(status)).toBeNull();
      expect(() => new Response(reply.body, { status: reply.status })).not.toThrow();
    }
  });

  it('answers with the reason when the call cannot be made', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    expect(await runFunctionCall(call(), 'd1', ORIGIN)).toEqual({ type: 'preview:function-response', id: 3, error: 'network down' });
  });

  it('sends no body with GET or HEAD, as fetch would refuse one', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await runFunctionCall(call({ method: 'get' }), 'd1', ORIGIN);
    await runFunctionCall(call({ method: 'HEAD' }), 'd1', ORIGIN);
    expect(fetchMock.mock.calls.map(([, init]) => [init.method, init.body])).toEqual([['GET', undefined], ['HEAD', undefined]]);
  });
});

describe('answerFunctionCall', () => {
  const call: FunctionCall = {
    type: 'preview:function-call', id: 1, path: '/api/deployments/d1/functions/echo', method: 'GET', headers: [], body: null,
  };

  afterEach(() => vi.unstubAllGlobals());

  it('posts the answer to the frame, handing over its body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
    const target = { postMessage: vi.fn() };

    await answerFunctionCall(call, 'd1', target as unknown as Window, () => 4);

    const [reply, origin, transfer] = target.postMessage.mock.calls[0];
    expect(reply).toMatchObject({ type: 'preview:function-response', id: 1, status: 200 });
    expect([origin, transfer]).toEqual(['*', [reply.body]]);
  });

  it("drops the answer when the page that asked was replaced meanwhile, since the next page's call ids start over", async () => {
    let respond!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
    const target = { postMessage: vi.fn() };
    let loadId = 4;

    const answered = answerFunctionCall(call, 'd1', target as unknown as Window, () => loadId);
    await vi.waitFor(() => expect(respond).toBeDefined());
    loadId = 5;
    respond(new Response('late'));
    await answered;

    expect(target.postMessage).not.toHaveBeenCalled();
  });
});

describe('the frame side, in the compiled page', () => {
  let posted: Array<{ message: Record<string, unknown> }>;
  // Each test installs the interceptor, which replaces fetch and XMLHttpRequest and listens on the
  // window and document; all of it is put back after each test, so no test runs on another's.
  let saved: { fetch: typeof window.fetch; XMLHttpRequest: typeof window.XMLHttpRequest };
  let listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject, unknown]>;
  let pageErrors: unknown[];
  const onPageError = (event: ErrorEvent) => { pageErrors.push(event.error); };

  function recordListeners(target: Window | Document) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: unknown) => {
      if (type === 'message' || type === 'submit') listeners.push([target, type, fn, opts]);
      add(type, fn, opts as AddEventListenerOptions);
    });
  }

  async function interceptor(): Promise<string> {
    globalThis.indexedDB = new IDBFactory();
    let n = 0;
    URL.createObjectURL = (() => `blob:http://localhost/${++n}`) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    const { vfs } = await import('@/lib/vfs');
    const { VirtualServer } = await import('../virtual-server');
    await vfs.init();
    const project = await vfs.createProject('Fn', 'fixture');
    await vfs.createFile(project.id, '/index.html', '<html><head></head><body></body></html>', { silent: true });
    const compiled = await new VirtualServer(vfs as never, project.id, { runtime: 'static', deploymentId: 'd1' }).compileProject();
    const page = String(compiled.files.find((f: { path: string }) => f.path === '/index.html')!.content);
    return page.match(/<script>(\s*\/\/ VFS Asset Interceptor[\s\S]*?)<\/script>/)![1];
  }

  function answer(id: unknown, body: string, status = 200) {
    window.dispatchEvent(Object.assign(new Event('message'), {
      source: window.parent,
      data: { type: 'preview:function-response', id, status, statusText: 'OK', headers: [['content-type', 'application/json']], body: new TextEncoder().encode(body).buffer },
    }));
  }

  beforeEach(() => {
    posted = [];
    listeners = [];
    pageErrors = [];
    saved = { fetch: window.fetch, XMLHttpRequest: window.XMLHttpRequest };
    recordListeners(window);
    recordListeners(document);
    window.addEventListener('error', onPageError);
    vi.spyOn(window, 'postMessage').mockImplementation(((message: Record<string, unknown>) => { posted.push({ message }); }) as never);
  });

  afterEach(() => {
    window.removeEventListener('error', onPageError);
    // With the options it was added with: the form listener is a capturing one.
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts as EventListenerOptions);
    window.fetch = saved.fetch;
    window.XMLHttpRequest = saved.XMLHttpRequest;
    vi.restoreAllMocks();
  });

  it('hands fetch, XHR and form posts to a function to the host', async () => {
    const realFetch = vi.fn();
    window.fetch = realFetch as never;
    new Function(await interceptor())();

    // fetch
    const pending = window.fetch('/contact', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    const first = posted[0].message;
    expect(first).toMatchObject({ type: 'preview:function-call', path: '/api/deployments/d1/functions/contact', method: 'POST' });
    expect(new TextDecoder().decode(first.body as ArrayBuffer)).toBe('{"a":1}');
    answer(first.id, '{"sent":true}', 201);
    const res = await pending;
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sent: true });
    expect(realFetch).not.toHaveBeenCalled();

    // XHR
    const xhr = new window.XMLHttpRequest();
    const loaded = new Promise<void>((resolve) => { xhr.onload = () => resolve(); });
    xhr.open('GET', '/stats');
    xhr.send();
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].message).toMatchObject({ path: '/api/deployments/d1/functions/stats', method: 'GET' });
    answer(posted[1].message.id, '{"n":3}');
    await loaded;
    expect([xhr.readyState, xhr.status, xhr.responseText]).toEqual([4, 200, '{"n":3}']);
    expect(xhr.getResponseHeader('content-type')).toBe('application/json');

    // form post
    document.body.innerHTML = '<form action="/subscribe" method="post"><input name="email" value="a@b.c"></form>';
    const form = document.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(posted).toHaveLength(3));
    expect(posted[2].message).toMatchObject({ path: '/api/deployments/d1/functions/subscribe', method: 'POST' });
    expect(new TextDecoder().decode(posted[2].message.body as ArrayBuffer)).toBe('{"email":"a@b.c"}');
  });

  it('ignores a forged response from inside the frame', async () => {
    new Function(await interceptor())();
    const pending = window.fetch('/contact');
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    let settled = false;
    pending.then(() => { settled = true; }, () => { settled = true; });
    window.dispatchEvent(Object.assign(new Event('message'), {
      source: {}, data: { type: 'preview:function-response', id: posted[0].message.id, status: 200, body: null },
    }));
    await new Promise(r => setTimeout(r, 10));
    expect(settled).toBe(false);
  });

  it('rejects an aborted fetch and drops the late answer', async () => {
    new Function(await interceptor())();
    const controller = new AbortController();
    const pending = window.fetch('/contact', { signal: controller.signal });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // The call is gone, so the answer reaches nothing and raises nothing in the page.
    answer(posted[0].message.id, '{}');
    await new Promise(r => setTimeout(r, 10));
    expect(pageErrors).toEqual([]);
  });

  it('sends nothing for a fetch aborted straight after it was made', async () => {
    new Function(await interceptor())();
    const controller = new AbortController();
    const pending = window.fetch('/contact', { method: 'POST', body: 'x', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(posted).toHaveLength(0);
  });

  it('gives XHR the body in the responseType asked for, and aborts and times out like XHR', async () => {
    new Function(await interceptor())();

    const binary = new window.XMLHttpRequest();
    binary.responseType = 'arraybuffer';
    const loaded = new Promise<void>((resolve) => { binary.onload = () => resolve(); });
    binary.open('GET', '/bytes');
    binary.send();
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    answer(posted[0].message.id, 'abc');
    await loaded;
    expect(new TextDecoder().decode(binary.response as ArrayBuffer)).toBe('abc');

    const aborted = new window.XMLHttpRequest();
    const events: string[] = [];
    aborted.onabort = () => events.push('abort');
    aborted.onload = () => events.push('load');
    aborted.open('GET', '/slow');
    aborted.send();
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    aborted.abort();
    answer(posted[1].message.id, '{}');
    await new Promise(r => setTimeout(r, 10));
    expect(events).toEqual(['abort']);
    expect(aborted.status).toBe(0);

    const slow = new window.XMLHttpRequest();
    slow.timeout = 20;
    const timedOut = new Promise<void>((resolve) => { slow.ontimeout = () => resolve(); });
    slow.open('GET', '/slower');
    slow.send();
    await timedOut;
    expect(slow.readyState).toBe(4);
  });

  it('drops an XHR answer whose body was still being read when the request was aborted', async () => {
    new Function(await interceptor())();
    const xhr = new window.XMLHttpRequest();
    const events: string[] = [];
    xhr.onabort = () => events.push('abort');
    xhr.onload = () => events.push('load');
    xhr.open('GET', '/stream');
    xhr.send();
    await vi.waitFor(() => expect(posted).toHaveLength(1));

    // The answer arrives with a body that is still streaming in.
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    window.dispatchEvent(Object.assign(new Event('message'), {
      source: window.parent,
      data: { type: 'preview:function-response', id: posted[0].message.id, status: 200, statusText: 'OK', headers: [], body },
    }));
    await new Promise(r => setTimeout(r, 10));
    xhr.abort();
    stream.enqueue(new TextEncoder().encode('{"late":true}'));
    stream.close();
    await new Promise(r => setTimeout(r, 10));

    expect(events).toEqual(['abort']);
    expect([xhr.readyState, xhr.status, xhr.responseText]).toEqual([4, 0, '']);
  });

  it("lets a reused XHR report the real request's outcome after an edge call, and ignores a GET body", async () => {
    new Function(await interceptor())();
    const xhr = new window.XMLHttpRequest();
    const loaded = new Promise<void>((resolve) => { xhr.onload = () => resolve(); });
    xhr.open('GET', '/stats');
    xhr.send('');
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].message.body).toBeNull();
    answer(posted[0].message.id, '{"n":1}', 201);
    await loaded;
    expect(xhr.status).toBe(201);

    xhr.open('GET', 'https://example.test/data.json');
    expect(Object.getOwnPropertyNames(xhr)).not.toContain('status');
    expect(xhr.status).toBe(0);
  });
});
