import type { ShellEnv, ShellResult } from '../types';
import { asGiven, parseRenderArgs, render, resolveTarget } from './render-shared';

const USAGE = `Usage: screenshot <page> [element] [--width N] [--full]
  Shows you a page as a visitor sees it (its scripts run), at N px wide (1440 by default).

  screenshot /index.html                    the first screen
  screenshot /index.html --full             the whole page, as several images from top to bottom
  screenshot /index.html ".hero"            one element, with a little room around it
  screenshot /index.html --width 375        on a phone-width screen

  An element is a CSS selector, a position (/index.html:16) or a marker (@h7x2m4qp).`;

const fail = (message: string, exitCode = 1): ShellResult => ({ stdout: '', stderr: `screenshot: ${message}`, exitCode });

/** `screenshot` — the rendered page as images the model looks at, which ride beside this output. */
export async function screenshotCommand(env: ShellEnv): Promise<ShellResult> {
  if (env.args.includes('-h') || env.args.includes('--help')) return { stdout: USAGE, stderr: '', exitCode: 0 };
  if (!env.ctx?.onImages) {
    // A shell that hands its renders to an open tab and carries no images is the MCP `bash` tool,
    // whose client has a tool of its own for them. Elsewhere (the Console) there is no such tool.
    return fail(env.ctx?.renderInBrowser
      ? 'this shell cannot pass images on. An MCP client takes them from the preview_screenshot tool.'
      : 'this shell cannot pass images on. To read the rendered page as text, use inspect.');
  }
  if (env.ctx.imageInput === false) return fail('the model doing this task does not read images. Use inspect to read the rendered page instead.');
  const parsed = parseRenderArgs('screenshot', env.args, { full: true });
  if (typeof parsed === 'string') return fail(parsed, 2);
  if (parsed.full && parsed.target) return fail('--full shows the whole page. For one element, leave --full out: an element is always shown whole', 2);
  const target = await resolveTarget(env, parsed.target);
  if (!target.ok) return fail(target.error);

  const result = await render(env, {
    kind: 'screenshot', projectId: env.projectId, page: parsed.page, width: parsed.width, target: target.target, full: parsed.full,
  });
  if (!result.ok) return fail(asGiven(result.error, target.target, parsed.target));
  if (result.kind !== 'screenshot') return fail('the page answered with something else');
  env.ctx.onImages(result.images);

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
