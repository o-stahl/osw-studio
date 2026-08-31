/**
 * Image generation via the project's image-generation model, used by the
 * `generate-image` shell command. Calls the /api/generate-image route and
 * returns the decoded image bytes (base64 + mime type) for the VFS to store.
 */

import type { ProviderId } from '@/lib/llm/providers/types';
import { apiFetch } from '@/lib/api/backend-status';
import { logger } from '@/lib/utils';

export interface GenerateImageOptions {
  provider: ProviderId;
  apiKey: string;
  model: string;
  prompt: string;
  aspectRatio?: string; // e.g. "16:9", "1:1"
  imageSize?: string;   // e.g. "0.5K", "1K", "2K", "4K"
  modalities?: string[]; // model's declared output modalities, e.g. ['image'] or ['image','text']
}

export interface GeneratedImage {
  base64: string;    // base64 payload (no data: prefix)
  mimeType: string;  // e.g. "image/png"
}

/** Throws on failure so the caller can surface the message to the agent. */
export async function generateImage(opts: GenerateImageOptions): Promise<GeneratedImage> {
  const apiKey = opts.provider === 'openai-codex' && typeof window !== 'undefined'
    ? await (await import('@/lib/auth/codex-auth')).ensureValidCodexToken()
    : opts.apiKey;
  const image_config: Record<string, string> = {};
  if (opts.aspectRatio) image_config.aspect_ratio = opts.aspectRatio;
  if (opts.imageSize) image_config.image_size = opts.imageSize;

  const response = await apiFetch('/api/generate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: opts.provider,
      apiKey,
      model: opts.model,
      prompt: opts.prompt,
      image_config,
      ...(opts.modalities ? { modalities: opts.modalities } : {}),
    }),
  });

  const data = await response.json().catch((e) => {
    logger.debug('[generateImage] non-JSON response body', e);
    return {} as { error?: string; image?: string };
  });
  if (!response.ok) {
    throw new Error(data?.error || `Image generation failed (${response.status})`);
  }

  const url: string = data?.image || '';
  const match = url.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) {
    throw new Error('Image generation returned an unexpected response');
  }
  return { mimeType: match[1], base64: match[2] };
}
