import type { ShellEnv, ShellResult } from '../types';
import type { SourceImage } from '@/lib/llm/image-gen';
import { normalizePath, writeBase64File } from '../runtime';
import { arrayBufferToBase64 } from '@/lib/vfs/binary-encoding';

const USAGE = 'Usage: generate-image [--out <path>] [--aspect <ratio>] [--size <0.5K|1K|2K|4K>] [--image <path>] "<prompt>"';

const SOURCE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
/** A source image's size limit: it travels as base64 inside a JSON request. */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/** A project image file as a source image, or what is wrong with it. */
async function readSource(env: ShellEnv, given: string): Promise<SourceImage | string> {
  const path = normalizePath(given);
  if (!path) return `--image takes a file path, for example --image /renders/view.png`;
  const mimeType = SOURCE_TYPES[path.split('.').pop()!.toLowerCase()];
  if (!mimeType) return `--image takes a PNG, JPEG, WebP or GIF file, not ${path}`;
  let content: string | ArrayBuffer;
  try {
    content = (await env.vfs.readFile(env.projectId, path)).content;
  } catch {
    return `${path}: No such file`;
  }
  if (typeof content === 'string') return `${path} is not an image file`;
  if (content.byteLength > MAX_SOURCE_BYTES) return `${path} is ${Math.round(content.byteLength / 1024 / 1024)} MB; a source image is at most ${MAX_SOURCE_BYTES / 1024 / 1024} MB`;
  return { base64: arrayBufferToBase64(content), mimeType };
}

/** `generate-image` — generate an image into the project, from a prompt or reworking an image in it. */
export async function generateimageCommand(env: ShellEnv): Promise<ShellResult> {
  const { vfs, projectId, args, ctx } = env;

  if (!ctx?.generateImage) {
    return { stdout: '', stderr: "generate-image: no image-generation model is configured for this project. Set one under the project's models.", exitCode: 1 };
  }
  let outPath: string | undefined;
  let aspectRatio: string | undefined;
  let imageSize: string | undefined;
  let imagePath: string | undefined;
  const promptParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--out' || a === '-o') outPath = args[++i];
    else if (a === '--aspect' || a === '--aspect-ratio') aspectRatio = args[++i];
    else if (a === '--size') imageSize = args[++i];
    else if (a === '--image' || a === '-i') imagePath = args[++i];
    else promptParts.push(a);
  }
  const prompt = promptParts.join(' ').trim();
  if (!prompt) return { stdout: '', stderr: USAGE, exitCode: 1 };
  if (imagePath === '' || (imagePath === undefined && (args.includes('--image') || args.includes('-i')))) {
    return { stdout: '', stderr: `generate-image: --image takes a file path\n${USAGE}`, exitCode: 1 };
  }
  let source: SourceImage | undefined;
  if (imagePath !== undefined) {
    const read = await readSource(env, imagePath);
    if (typeof read === 'string') return { stdout: '', stderr: `generate-image: ${read}`, exitCode: 1 };
    source = read;
  }

  let image: { base64: string; mimeType: string };
  try {
    image = await ctx.generateImage(prompt, { aspectRatio, imageSize, ...(source ? { source } : {}) });
  } catch (err) {
    return { stdout: '', stderr: `generate-image: ${err instanceof Error ? err.message : 'generation failed'}`, exitCode: 1 };
  }
  const ext = (image.mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('+xml', '');
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
  // The model picks the format. A name that says another one gets the right extension, so a .png
  // never holds JPEG data.
  const asked = outPath ? (normalizePath(outPath) || outPath) : undefined;
  const askedExt = asked?.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  const sameFormat = askedExt === ext || (askedExt === 'jpeg' && ext === 'jpg');
  const target = asked
    ? (sameFormat ? asked : `${askedExt ? asked.slice(0, -askedExt.length - 1) : asked}.${ext}`)
    : `/.generated/${slug}-${Date.now().toString(36).slice(-5)}.${ext}`;
  const size = await writeBase64File(vfs, projectId, target, image.base64);
  const detail = [source && `from ${normalizePath(imagePath!)}`, aspectRatio && `aspect ${aspectRatio}`, imageSize && `size ${imageSize}`].filter(Boolean).join(', ');
  const note = !asked
    ? ' (/.generated/ is excluded from the published build; pass --out <path> to save into the site).'
    : target !== asked ? ` The model returned ${ext.toUpperCase()}, so it is saved as .${ext} rather than ${asked}.` : '';
  return {
    stdout: `Generated image saved to ${target} (${size} bytes${detail ? `, ${detail}` : ''}).${note}`,
    stderr: '',
    exitCode: 0,
  };
}
