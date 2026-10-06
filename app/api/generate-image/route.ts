import { NextRequest, NextResponse } from 'next/server';
import { ProviderId } from '@/lib/llm/providers/types';
import { getProvider } from '@/lib/llm/providers/registry';
import { CODEX_BASE_URL, createCodexHeaders, getCodexAccountId } from '@/lib/llm/codex-utils';
import { OPENROUTER_ATTRIBUTION } from '@/lib/llm/request-builder';
import { imageGenTimeoutMs } from '@/lib/llm/image-gen-timeout';

/**
 * Image generation runs long, and an upstream that stalls or never closes its stream left nothing
 * to break the wait: the agent sat on the tool call for good, which read as "stuck". Every
 * upstream fetch here carries a deadline (`imageGenTimeoutMs`) and the caller's own abort, so Stop
 * in the chat ends it and a dead upstream ends itself.
 */
function deadlineSignal(request: NextRequest): AbortSignal {
  const timeout = AbortSignal.timeout(imageGenTimeoutMs());
  return request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
}

/** The response for an upstream call that was cut short, by the caller or by the deadline. */
function abortedResponse(request: NextRequest): NextResponse {
  if (request.signal?.aborted) {
    return NextResponse.json({ error: 'Image generation was cancelled' }, { status: 499 });
  }
  return NextResponse.json(
    { error: `Image generation timed out after ${Math.round(imageGenTimeoutMs() / 1000)}s. Try again, or pick another image model.` },
    { status: 504 },
  );
}

/**
 * Whether a rejected upstream call was cut short by our signal. Judged by the signal, not the
 * error's name: undici reports a client-side cancellation as `ResponseAborted`, a signal abort
 * as `AbortError`, and the deadline as `TimeoutError`, and a name check missed the first of
 * those in practice while the fetch had in fact been cancelled.
 */
function wasCutShort(signal: AbortSignal, err: unknown): boolean {
  if (signal.aborted) return true;
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

const CODEX_IMAGE_QUALITIES: Record<string, string> = {
  'gpt-image-2-low': 'low',
  'gpt-image-2-medium': 'medium',
  'gpt-image-2-high': 'high',
};

function codexImageSize(aspectRatio?: string): string {
  if (aspectRatio === '16:9' || aspectRatio === 'landscape') return '1536x1024';
  if (aspectRatio === '9:16' || aspectRatio === 'portrait') return '1024x1536';
  return '1024x1024';
}

/** Base64 image data's type, read from its first bytes. */
function base64ImageType(b64: string): string {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('UklGR')) return 'image/webp';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  return 'image/png';
}

/**
 * Pollinations generates images through its OpenAI-compatible `/v1/images/generations`, which
 * answers with base64 data, not through chat completions.
 */
async function generatePollinationsImage(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  aspectRatio: string | undefined,
  signal: AbortSignal,
): Promise<NextResponse> {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, size: codexImageSize(aspectRatio), response_format: 'b64_json' }),
    signal,
  });
  if (!response.ok) {
    const error = await upstreamError(response, `Pollinations image request failed (${response.status})`);
    return NextResponse.json({ error }, { status: response.status });
  }
  const data = await response.json();
  const b64: unknown = data?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !b64) return NextResponse.json({ error: 'Model returned no image' }, { status: 422 });
  return NextResponse.json({ image: `data:${base64ImageType(b64)};base64,${b64}` });
}

/** An upstream error body's message, else `fallback`. */
async function upstreamError(response: Response, fallback: string): Promise<string> {
  try {
    const err = await response.json();
    const detail = err?.error?.message || err?.error || err?.message;
    if (typeof detail === 'string' && detail) return detail;
  } catch { /* use the fallback */ }
  return fallback;
}

/**
 * OpenRouter generates images through its Image API, `/images`, which serves every image model it
 * lists. Image models added since the API launched are served only there, and refuse chat
 * completions. Aspect ratio and resolution are enums that differ per model, so a request whose
 * options the model refuses is sent once more without them.
 */
async function generateOpenRouterImage(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  imageConfig: { aspect_ratio?: string; image_size?: string } | undefined,
  signal: AbortSignal,
): Promise<NextResponse> {
  const options: Record<string, string> = {};
  if (imageConfig?.aspect_ratio) options.aspect_ratio = imageConfig.aspect_ratio;
  if (imageConfig?.image_size) options.resolution = imageConfig.image_size;

  const request = (body: Record<string, string>) => fetch(`${baseUrl.replace(/\/$/, '')}/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...OPENROUTER_ATTRIBUTION },
    body: JSON.stringify(body),
    signal,
  });

  let response = await request({ model, prompt, ...options });
  if (response.status === 400 && Object.keys(options).length > 0) {
    await response.body?.cancel();
    response = await request({ model, prompt });
  }
  if (!response.ok) {
    const error = await upstreamError(response, `OpenRouter image request failed (${response.status})`);
    return NextResponse.json({ error }, { status: response.status });
  }
  const data = await response.json();
  const image = data?.data?.[0];
  const b64: unknown = image?.b64_json;
  if (typeof b64 !== 'string' || !b64) return NextResponse.json({ error: 'Model returned no image' }, { status: 422 });
  const type = typeof image.media_type === 'string' && image.media_type.startsWith('image/')
    ? image.media_type
    : base64ImageType(b64);
  return NextResponse.json({ image: `data:${type};base64,${b64}` });
}

function extractCodexImage(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    let found: string | undefined;
    for (const item of value) found = extractCodexImage(item) || found;
    return found;
  }
  if (!value || typeof value !== 'object') return undefined;

  const record = value as Record<string, unknown>;
  let found = record.type === 'image_generation_call' && typeof record.result === 'string'
    ? record.result
    : typeof record.partial_image_b64 === 'string' ? record.partial_image_b64 : undefined;
  for (const child of Object.values(record)) found = extractCodexImage(child) || found;
  return found;
}

async function collectCodexImage(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let image: string | undefined;

  const flushEvent = () => {
    const raw = dataLines.join('\n').trim();
    dataLines = [];
    if (!raw || raw === '[DONE]') return;
    try { image = extractCodexImage(JSON.parse(raw)) || image; } catch { /* ignore malformed events */ }
  };
  const consumeLine = (line: string) => {
    const clean = line.replace(/\r$/, '');
    if (!clean) flushEvent();
    else if (clean.startsWith('data:')) dataLines.push(clean.slice(5).trimStart());
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach(consumeLine);
    if (done) break;
  }
  if (buffer) consumeLine(buffer);
  flushEvent();
  return image;
}

async function generateCodexImage(
  apiKey: string,
  model: string,
  prompt: string,
  aspectRatio: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const quality = CODEX_IMAGE_QUALITIES[model];
  if (!quality) {
    return NextResponse.json({ error: `Unsupported Codex image model: ${model}` }, { status: 400 });
  }

  let headers: Headers;
  try {
    headers = createCodexHeaders(undefined, getCodexAccountId(apiKey), apiKey);
  } catch {
    return NextResponse.json({ error: 'ChatGPT session is invalid. Re-authenticate in Settings.' }, { status: 401 });
  }
  headers.set('Content-Type', 'application/json');

  const response = await fetch(`${CODEX_BASE_URL}/codex/responses`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: 'gpt-5.5',
      store: false,
      instructions: 'Fulfill the request by using the image_generation tool.',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      }],
      tools: [{
        type: 'image_generation',
        model: 'gpt-image-2',
        size: codexImageSize(aspectRatio),
        quality,
        output_format: 'png',
        background: 'opaque',
        partial_images: 1,
      }],
      tool_choice: {
        type: 'allowed_tools',
        mode: 'required',
        tools: [{ type: 'image_generation' }],
      },
      stream: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    let detail = body;
    try { detail = JSON.parse(body)?.error?.message || body; } catch { /* use raw body */ }
    if (response.status === 400 && detail.trim() === "Tool choice 'image_generation' not found in 'tools' parameter.") {
      detail = 'Image generation is not enabled for this ChatGPT account. Choose another image provider.';
    }
    return NextResponse.json({ error: detail || `Codex image request failed (${response.status})` }, { status: response.status });
  }

  // The signal cancels the body stream as well as the connection, so a stalled SSE read ends here
  // rather than looping forever.
  const image = await collectCodexImage(response);
  if (!image) return NextResponse.json({ error: 'Codex returned no generated image' }, { status: 422 });
  return NextResponse.json({ image: `data:image/png;base64,${image}` });
}

/**
 * Image generation. Codex, OpenRouter and Pollinations have their own image endpoints; any other
 * provider goes through an OpenAI-compatible chat-completions endpoint with the
 * `modalities: ["image"]` extension. The
 * generated image comes back at choices[0].message.images[0].image_url.url as a
 * base64 data URL, which we return verbatim for the caller to decode and store.
 */
export async function POST(request: NextRequest) {
  try {
    const { provider, apiKey, model, prompt, image_config, modalities } = await request.json();

    if (!model || !prompt) {
      return NextResponse.json({ error: 'model and prompt are required' }, { status: 400 });
    }

    const selectedProvider: ProviderId = provider || 'openrouter';
    const providerConfig = getProvider(selectedProvider);
    if (providerConfig.apiKeyRequired && !apiKey && !providerConfig.usesOAuth) {
      return NextResponse.json(
        { error: `${providerConfig.name} API key is required. Set it in settings.` },
        { status: 400 },
      );
    }

    const signal = deadlineSignal(request);

    if (selectedProvider === 'openai-codex') {
      try {
        return await generateCodexImage(apiKey, model, prompt, image_config?.aspect_ratio, signal);
      } catch (err) {
        if (wasCutShort(signal, err)) return abortedResponse(request);
        throw err;
      }
    }

    const baseUrl = providerConfig.baseUrl || 'https://openrouter.ai/api/v1';

    if (selectedProvider === 'openrouter') {
      try {
        return await generateOpenRouterImage(baseUrl, apiKey, model, prompt, image_config, signal);
      } catch (err) {
        if (wasCutShort(signal, err)) return abortedResponse(request);
        throw err;
      }
    }

    if (selectedProvider === 'pollinations') {
      try {
        return await generatePollinationsImage(baseUrl, apiKey, model, prompt, image_config?.aspect_ratio, signal);
      } catch (err) {
        if (wasCutShort(signal, err)) return abortedResponse(request);
        throw err;
      }
    }

    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

    // Request the model's actual output modalities. Image-only models (FLUX,
    // Seedream, Grok Imagine, GPT Image) reject 'text' with "No endpoints found
    // that support the requested output modalities"; multimodal models (Gemini)
    // require 'text' alongside 'image'. The caller passes the model's declared
    // modalities; fall back to image-only when unknown.
    const requestedModalities =
      Array.isArray(modalities) && modalities.length > 0 ? modalities : ['image'];

    const body: {
      model: string;
      messages: { role: string; content: string }[];
      modalities: string[];
      image_config?: Record<string, unknown>;
    } = {
      model,
      messages: [{ role: 'user', content: prompt }],
      modalities: requestedModalities,
    };
    if (image_config && typeof image_config === 'object' && Object.keys(image_config).length > 0) {
      body.image_config = image_config;
    }

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (wasCutShort(signal, err)) return abortedResponse(request);
      throw err;
    }

    if (!response.ok) {
      let detail = '';
      try {
        const err = await response.json();
        detail = err?.error?.message || err?.error || '';
      } catch { /* ignore */ }
      return NextResponse.json(
        { error: detail || `${providerConfig.name} image request failed (${response.status})` },
        { status: response.status },
      );
    }

    const data = await response.json();
    const message = data?.choices?.[0]?.message;
    const url: string | undefined = message?.images?.[0]?.image_url?.url;

    if (!url) {
      // The model may have replied with text (e.g. a refusal) instead of an image.
      const text = typeof message?.content === 'string' ? message.content.trim() : '';
      return NextResponse.json(
        { error: text ? `Model returned text instead of an image: ${text.slice(0, 300)}` : 'Model returned no image' },
        { status: 422 },
      );
    }

    return NextResponse.json({ image: url });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Image generation failed' },
      { status: 500 },
    );
  }
}
