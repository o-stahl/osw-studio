import type { ShellEnv, ShellResult } from '../types';
import { isScreenshotOutFlag } from '@/lib/vfs/shell-commands';
import { normalizePath, writeBase64File } from '../runtime';
import { asGiven, parseRenderArgs, render, resolveTarget } from './render-shared';

const USAGE = `Usage: screenshot <page> [element] [--width N] [--full] [--out <file.png|file.jpg>]
  Shows you a page as a visitor sees it (its scripts run), at N px wide (1440 by default).

  screenshot /index.html                    the first screen
  screenshot /index.html --full             the whole page, as several images from top to bottom
  screenshot /index.html ".hero"            one element, with a little room around it
  screenshot /index.html --width 375        on a phone-width screen
  screenshot /index.html ".hero" --out /shots/hero.png
                                            saves exactly that element as one image file

  An element is a CSS selector, a position (/index.html:16) or a marker (@h7x2m4qp).`;

const fail = (message: string, exitCode = 1): ShellResult => ({ stdout: '', stderr: `screenshot: ${message}`, exitCode });

const SAVE_TYPES: Record<string, 'image/png' | 'image/jpeg'> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

/** `--out <path>` taken out of the arguments, or what is wrong with it. */
function takeOut(args: readonly string[]): { args: string[]; out?: string } | string {
  const rest: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (!isScreenshotOutFlag(args[i])) { rest.push(args[i]); continue; }
    out = args[i] === '--out' ? args[++i] : args[i].slice('--out='.length);
    if (!out) return '--out takes a file path, for example --out /renders/view.png';
  }
  return { args: rest, out };
}

/**
 * `screenshot` — the rendered page as images the model looks at, which ride beside this output, or
 * with `--out` saved as one image file in the project.
 */
export async function screenshotCommand(env: ShellEnv): Promise<ShellResult> {
  if (env.args.includes('-h') || env.args.includes('--help')) return { stdout: USAGE, stderr: '', exitCode: 0 };
  const taken = takeOut(env.args);
  if (typeof taken === 'string') return fail(taken, 2);
  const out = taken.out === undefined ? undefined : normalizePath(taken.out);
  if (taken.out !== undefined && !out) return fail('--out takes a file path, for example --out /renders/view.png', 2);
  const save = out ? SAVE_TYPES[out.split('.').pop()!.toLowerCase()] : undefined;
  if (out && !save) return fail(`--out saves PNG or JPEG: give the file a .png or .jpg name, not ${out}`, 2);

  // Saving to a file needs no model that reads images; looking does.
  if (!out && !env.ctx?.onImages) {
    // A shell that hands its renders to an open tab and carries no images is the MCP `bash` tool,
    // whose client has a tool of its own for them. Elsewhere (the Console) there is no such tool.
    return fail(env.ctx?.renderInBrowser
      ? 'this shell cannot pass images on. An MCP client takes them from the preview_screenshot tool, or save one with --out <file.png>.'
      : 'this shell cannot pass images on. To read the rendered page as text, use inspect.');
  }
  if (!out && env.ctx?.imageInput === false) return fail('the model doing this task does not read images. Use inspect to read the rendered page instead.');
  const parsed = parseRenderArgs('screenshot', taken.args, { full: true });
  if (typeof parsed === 'string') return fail(parsed, 2);
  if (parsed.full && parsed.target) return fail('--full shows the whole page. For one element, leave --full out: an element is always shown whole', 2);
  const target = await resolveTarget(env, parsed.target);
  if (!target.ok) return fail(target.error);

  const result = await render(env, {
    kind: 'screenshot', projectId: env.projectId, page: parsed.page, width: parsed.width, target: target.target, full: parsed.full,
    ...(save ? { save } : {}),
  });
  if (!result.ok) return fail(asGiven(result.error, target.target, parsed.target));
  if (result.kind !== 'screenshot') return fail('the page answered with something else');

  if (out) {
    const image = result.images[0];
    if (image.mediaType !== save) return fail('the page answered with an image in another format');
    let size: number;
    try {
      size = await writeBase64File(env.vfs, env.projectId, out, image.data);
    } catch (error) {
      return fail(`could not write ${out}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const what = parsed.target
      ? `${JSON.stringify(parsed.target)} on ${parsed.page}${(result.matches ?? 1) > 1 ? `, the first of ${result.matches} matches,` : ''}`
      : parsed.full ? `the whole of ${parsed.page}` : `the first screen of ${parsed.page}`;
    return { stdout: `Saved ${what} at ${result.width} px wide to ${out}: ${image.width}×${image.height}, ${size} bytes.`, stderr: '', exitCode: 0 };
  }

  env.ctx!.onImages!(result.images);
  const at = `${parsed.page} at ${result.width} px wide (page ${result.pageHeight} px tall)`;
  const ranges = result.images.map((image, i) => `${i + 1}: y ${image.region.y}–${image.region.y + image.region.h}`).join(', ');
  const lines = [
    parsed.target
      ? `Screenshot of ${JSON.stringify(parsed.target)} on ${at}${(result.matches ?? 1) > 1 ? `, the first of ${result.matches} matches` : ''}: ${result.images.length === 1 ? 'one image' : `${result.images.length} images, ${ranges}`}.`
      : parsed.full
        ? `Screenshot of ${at}: ${result.images.length} image${result.images.length === 1 ? '' : 's'}, top to bottom (${ranges}).`
        : `Screenshot of the first screen of ${at}: ${result.images.length === 1 ? 'one image' : `${result.images.length} images, top to bottom`}, ${result.width}×${result.height}.`,
  ];
  if (result.cut) lines.push(`Cut at y ${result.images[result.images.length - 1].region.y + result.images[result.images.length - 1].region.h}; name an element further down to see the rest.`);
  return { stdout: lines.join('\n'), stderr: '', exitCode: 0 };
}
