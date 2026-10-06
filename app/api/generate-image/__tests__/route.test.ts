import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { POST } from '@/app/api/generate-image/route';

function codexToken(accountId = 'acct-123'): string {
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).toString('base64url');
  return `header.${payload}.signature`;
}

afterEach(() => vi.unstubAllGlobals());

describe('/api/generate-image Codex image generation', () => {
  it('uses the Responses image_generation tool and returns its PNG', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response([
      'event: response.output_item.done',
      'data: {"item":{"type":"image_generation_call","result":"png-base64"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);

    const request = {
      json: async () => ({
        provider: 'openai-codex',
        apiKey: codexToken(),
        model: 'gpt-image-2-high',
        prompt: 'a lighthouse in a storm',
        image_config: { aspect_ratio: '16:9' },
      }),
    } as unknown as NextRequest;

    const response = await POST(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ image: 'data:image/png;base64,png-base64' });

    const [url, maybeInit] = fetchMock.mock.calls[0];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    const init = maybeInit!;
    const headers = init.headers as Headers;
    expect(headers.get('chatgpt-account-id')).toBe('acct-123');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-5.5');
    expect(body.tools[0]).toMatchObject({
      type: 'image_generation',
      model: 'gpt-image-2',
      quality: 'high',
      size: '1536x1024',
    });
    expect(body.tool_choice).toEqual({
      type: 'allowed_tools',
      mode: 'required',
      tools: [{ type: 'image_generation' }],
    });
  });
});

/**
 * A stalled upstream used to hang the tool call for good, which the agent showed as "stuck".
 * The route now carries a deadline and the caller's abort into every upstream fetch.
 */
function neverEndingBody(signal?: AbortSignal): Response {
  // A stream that emits one partial line and then never closes on its own. Like a real fetch, the
  // pending read rejects when the request's signal fires; that is what the route relies on.
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"partial":true}\n'));
      signal?.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

function requestFor(body: Record<string, unknown>, signal?: AbortSignal): NextRequest {
  return { json: async () => body, signal } as unknown as NextRequest;
}

describe('/api/generate-image gives up on a dead upstream', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it('times out a Codex stream that never finishes', async () => {
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '50');
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => neverEndingBody(init?.signal ?? undefined));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(requestFor({ provider: 'openai-codex', apiKey: codexToken(), model: 'gpt-image-2-low', prompt: 'x' }));

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/timed out/) });
    // The deadline reached the upstream call, which is what makes a real stream end.
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('times out an OpenAI-compatible provider that never answers', async () => {
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '50');
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    })));

    const response = await POST(requestFor({ provider: 'openrouter', apiKey: 'sk', model: 'm', prompt: 'x' }));

    expect(response.status).toBe(504);
  });

  it('recognises a cancellation by the signal, whatever the runtime names the error', async () => {
    // undici rejects a client-side cancellation as `ResponseAborted`, which is neither AbortError
    // nor TimeoutError. Judging by name alone let a cancelled fetch fall through as a server error.
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '60000');
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('closed'), { name: 'ResponseAborted' })));
      setTimeout(() => controller.abort(), 10);
    })));

    const response = await POST(requestFor({ provider: 'openai-codex', apiKey: codexToken(), model: 'gpt-image-2-low', prompt: 'x' }, controller.signal));

    expect(response.status).toBe(499);
  });

  it('stops when the caller has already gone, without waiting for the deadline', async () => {
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '60000');
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      if (init?.signal?.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    })));

    const response = await POST(requestFor({ provider: 'openai-codex', apiKey: codexToken(), model: 'gpt-image-2-low', prompt: 'x' }, controller.signal));

    expect(response.status).toBe(499);
  });
});

describe('/api/generate-image Pollinations image generation', () => {
  it('uses /v1/images/generations and returns the image with its type', async () => {
    const jpeg = '/9j/4AAQ';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: jpeg }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      json: async () => ({
        provider: 'pollinations', apiKey: 'sk_x', model: 'black-forest-labs/flux.1-schnell',
        prompt: 'a lighthouse', image_config: { aspect_ratio: '16:9' },
      }),
    } as unknown as NextRequest;

    const response = await POST(request);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ image: `data:image/jpeg;base64,${jpeg}` });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gen.pollinations.ai/v1/images/generations');
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'black-forest-labs/flux.1-schnell', prompt: 'a lighthouse', size: '1536x1024', response_format: 'b64_json',
    });
  });

  it('passes Pollinations\' own error message on', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Insufficient pollen' } }), { status: 402 })));
    const request = { json: async () => ({ provider: 'pollinations', apiKey: 'sk_x', model: 'm', prompt: 'p' }) } as unknown as NextRequest;
    const response = await POST(request);
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({ error: 'Insufficient pollen' });
  });
});


describe('/api/generate-image Pollinations details', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  const pollinations = (extra: Record<string, unknown> = {}) =>
    ({ json: async () => ({ provider: 'pollinations', apiKey: 'sk_x', model: 'm', prompt: 'p', ...extra }) }) as unknown as NextRequest;
  const ok = (b64: unknown) => vi.fn(async (_url: unknown, _init?: RequestInit) =>
    new Response(JSON.stringify({ data: b64 === undefined ? [] : [{ b64_json: b64 }] }), { status: 200 }));

  it('sends the key as a Bearer token', async () => {
    const fetchMock = ok('iVBORw0K');
    vi.stubGlobal('fetch', fetchMock);
    await POST(pollinations());
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_x');
  });

  it.each([
    ['UklGRiQA', 'image/webp'],
    ['R0lGODlh', 'image/gif'],
    ['iVBORw0K', 'image/png'],
  ])('labels base64 starting %s as %s', async (b64, type) => {
    vi.stubGlobal('fetch', ok(b64));
    const response = await POST(pollinations());
    await expect(response.json()).resolves.toEqual({ image: `data:${type};base64,${b64}` });
  });

  it('answers 422 when the reply carries no image', async () => {
    vi.stubGlobal('fetch', ok(undefined));
    const response = await POST(pollinations());
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: 'Model returned no image' });
  });

  it('words an error without a message by its status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream exploded', { status: 500 })));
    const response = await POST(pollinations());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Pollinations image request failed (500)' });
  });

  it('answers 499 when the caller cancels', async () => {
    vi.stubEnv('IMAGE_GEN_TIMEOUT_MS', '60000');
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('closed'), { name: 'ResponseAborted' })));
      setTimeout(() => controller.abort(), 10);
    })));
    const response = await POST(requestFor({ provider: 'pollinations', apiKey: 'sk_x', model: 'm', prompt: 'p' }, controller.signal));
    expect(response.status).toBe(499);
  });
});

describe('/api/generate-image OpenRouter image generation', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  const openrouter = (extra: Record<string, unknown> = {}) =>
    ({ json: async () => ({ provider: 'openrouter', apiKey: 'sk-or', model: 'qwen/qwen-image-3', prompt: 'p', ...extra }) }) as unknown as NextRequest;
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it('uses the Image API with the aspect ratio and resolution, and returns the image with its type', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => reply(200, { data: [{ b64_json: 'abc', media_type: 'image/webp' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(openrouter({ image_config: { aspect_ratio: '2:3', image_size: '2K' }, modalities: ['image'] }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ image: 'data:image/webp;base64,abc' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/images');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'qwen/qwen-image-3', prompt: 'p', aspect_ratio: '2:3', resolution: '2K' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or');
  });

  it('types the image from its bytes when the reply has no media type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { data: [{ b64_json: '/9j/4AAQ' }] })));
    const response = await POST(openrouter());
    await expect(response.json()).resolves.toEqual({ image: 'data:image/jpeg;base64,/9j/4AAQ' });
  });

  it('sends the request again without options the model refuses', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) =>
      JSON.parse(init!.body as string).resolution
        ? reply(400, { error: { message: 'resolution 4K is not supported' } })
        : reply(200, { data: [{ b64_json: 'iVBORw0K' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(openrouter({ image_config: { aspect_ratio: '1:1', image_size: '4K' } }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({ model: 'qwen/qwen-image-3', prompt: 'p' });
  });

  it('does not resend a refused request that carried no options', async () => {
    const fetchMock = vi.fn(async () => reply(400, { error: { message: 'Invalid model' } }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(openrouter());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid model' });
  });

  it('answers 422 when the reply carries no image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { data: [] })));
    const response = await POST(openrouter());
    expect(response.status).toBe(422);
  });

  it('leaves other OpenAI-compatible providers on chat completions', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      reply(200, { choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,x' } }] } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(requestFor({ provider: 'vercel', apiKey: 'k', model: 'google/gemini-3.1-flash-image', prompt: 'p' }));

    await expect(response.json()).resolves.toEqual({ image: 'data:image/png;base64,x' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://ai-gateway.vercel.sh/v1/chat/completions');
  });
});
