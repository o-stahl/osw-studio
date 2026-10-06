import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Every open tab receives an image request. Only the tab whose claim is granted generates the image
 * (each generation is billed), and its answer names the request it belongs to.
 */

const generateImage = vi.fn();
const imageModelFor = vi.fn();
vi.mock('@/lib/llm/image-gen', () => ({
  generateImage: (...args: unknown[]) => generateImage(...args),
  imageModelFor: (...args: unknown[]) => imageModelFor(...args),
}));
vi.mock('@/lib/llm/models/project-assignment', () => ({ getProjectAssignment: async () => ({}) }));
vi.mock('@/lib/config/storage', () => ({ configManager: { getProviderApiKey: () => 'k' } }));

import { handleImageRequested } from '../image-delegation-handler';

let posts: Array<{ url: string; body: Record<string, unknown> }>;

function stubServer(granted: boolean) {
  posts = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(url.endsWith('/image-claim') ? { granted } : { ok: true }));
  });
}

beforeEach(() => {
  generateImage.mockReset().mockResolvedValue({ base64: 'iVBOR', mimeType: 'image/png' });
  imageModelFor.mockReset().mockReturnValue({ ref: { provider: 'openrouter', model: 'img' }, modalities: ['image'] });
});
afterEach(() => vi.unstubAllGlobals());

describe('handleImageRequested', () => {
  it('generates and answers the request it claimed', async () => {
    stubServer(true);
    await handleImageRequested({ taskId: 't1', requestId: 'r1', prompt: 'a lighthouse' });
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(posts.map((p) => p.url)).toEqual(['/api/server-generate/image-claim', '/api/server-generate/image-result']);
    expect(posts[1].body).toEqual({ taskId: 't1', requestId: 'r1', base64: 'iVBOR', mimeType: 'image/png' });
  });

  it('does nothing when another tab claimed it first', async () => {
    stubServer(false);
    await handleImageRequested({ taskId: 't1', requestId: 'r1', prompt: 'a lighthouse' });
    expect(generateImage).not.toHaveBeenCalled();
    expect(posts.map((p) => p.url)).toEqual(['/api/server-generate/image-claim']);
  });

  it('generates with the project image model, its key, the prompt and the requested shape', async () => {
    stubServer(true);
    await handleImageRequested({ taskId: 't1', requestId: 'r1', prompt: 'a lighthouse', aspectRatio: '16:9', imageSize: '1K' });
    expect(generateImage).toHaveBeenCalledWith({
      provider: 'openrouter', apiKey: 'k', model: 'img', prompt: 'a lighthouse',
      aspectRatio: '16:9', imageSize: '1K', modalities: ['image'],
    });
  });

  // The paused server run is waiting on this request; an answer saying why lets it move on now
  // rather than after its three-minute timeout.
  it('answers with the reason when generation fails', async () => {
    stubServer(true);
    generateImage.mockRejectedValueOnce(new Error('quota exceeded'));
    await handleImageRequested({ taskId: 't1', requestId: 'r1', prompt: 'a lighthouse' });
    expect(posts[1]).toEqual({ url: '/api/server-generate/image-result', body: { taskId: 't1', requestId: 'r1', error: 'quota exceeded' } });
  });

  it('answers with the reason when the project has no image model', async () => {
    stubServer(true);
    imageModelFor.mockReturnValueOnce(null);
    await handleImageRequested({ taskId: 't1', requestId: 'r1', prompt: 'a lighthouse' });
    expect(generateImage).not.toHaveBeenCalled();
    expect(posts[1].body).toEqual({ taskId: 't1', requestId: 'r1', error: 'no image-generation model is configured for this project' });
  });

  it('settles quietly when the answer cannot be posted', async () => {
    posts = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith('/image-result')) throw new Error('offline');
      return new Response(JSON.stringify({ granted: true }));
    });
    await expect(handleImageRequested({ taskId: 't1', requestId: 'r1', prompt: 'a lighthouse' })).resolves.toBeUndefined();
  });
});
