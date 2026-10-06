// lib/server-generate/image-delegation-handler.ts
import { configManager } from '@/lib/config/storage';
import { getProjectAssignment } from '@/lib/llm/models/project-assignment';
import { generateImage, imageModelFor } from '@/lib/llm/image-gen';

/**
 * Runs a server-delegated image generation in the browser, which holds the project's image model
 * and its key, and posts the image back so the paused server-side run can continue. Each open tab
 * receives the request; the first to claim it is the one that generates.
 */
export async function handleImageRequested(data: {
  taskId: string;
  requestId: string;
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
}): Promise<void> {
  const { taskId, requestId, prompt, aspectRatio, imageSize } = data;

  // Every open tab receives the request; only the one that claims it generates the image.
  const claim = await fetch('/api/server-generate/image-claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, requestId }),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!claim?.granted) return;

  let body: Record<string, string>;
  try {
    const model = imageModelFor(await getProjectAssignment());
    if (!model) throw new Error('no image-generation model is configured for this project');
    const image = await generateImage({
      provider: model.ref.provider,
      apiKey: configManager.getProviderApiKey(model.ref.provider) || '',
      model: model.ref.model,
      prompt: typeof prompt === 'string' ? prompt : '',
      aspectRatio,
      imageSize,
      modalities: model.modalities,
    });
    body = { base64: image.base64, mimeType: image.mimeType };
  } catch (e) {
    body = { error: e instanceof Error ? e.message : String(e) };
  }

  try {
    await fetch('/api/server-generate/image-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, requestId, ...body }),
    });
  } catch {
    // The server's own timeout tells the agent to continue without the image.
  }
}
