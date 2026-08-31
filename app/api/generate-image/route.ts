import { NextRequest, NextResponse } from 'next/server';
import { ProviderId } from '@/lib/llm/providers/types';
import { getProvider } from '@/lib/llm/providers/registry';
import { CODEX_BASE_URL, createCodexHeaders, getCodexAccountId } from '@/lib/llm/codex-utils';

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

export function extractCodexImage(value: unknown): string | undefined {
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
  aspectRatio?: string,
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

  const image = await collectCodexImage(response);
  if (!image) return NextResponse.json({ error: 'Codex returned no generated image' }, { status: 422 });
  return NextResponse.json({ image: `data:image/png;base64,${image}` });
}

/**
 * Image generation via an OpenAI-compatible chat-completions endpoint with the
 * `modalities: ["image"]` extension (OpenRouter and compatible providers). The
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

    if (selectedProvider === 'openai-codex') {
      return generateCodexImage(apiKey, model, prompt, image_config?.aspect_ratio);
    }

    const baseUrl = providerConfig.baseUrl || 'https://openrouter.ai/api/v1';
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

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

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
