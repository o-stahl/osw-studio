import type { ShellEnv } from '../types';
import type { VirtualFileSystem } from '@/lib/vfs';
import { asText } from '@/lib/vfs/as-text';
import { parseSrc, sourceRef } from '@/lib/direct-edit/resolution';
import type { RenderJob, RenderResult } from '@/lib/canvas/render-types';
import { frameTarget, parseElementTarget } from '@/lib/direct-edit/targets';

/** The width `inspect` and `screenshot` lay a page out at when none is given: Canvas's desktop. */
export const DEFAULT_RENDER_WIDTH = 1440;

export interface RenderArgs {
  page: string;
  target?: string;
  width: number;
  depth?: number;
  full: boolean;
}

/**
 * `<page> [target] [--width N] [--depth D] [--full]`, or a message saying what is wrong. A position
 * by itself (`/index.html:16`) names its own page.
 */
export function parseRenderArgs(command: string, args: readonly string[], allow: { depth?: boolean; full?: boolean }): RenderArgs | string {
  const words: string[] = [];
  let width = DEFAULT_RENDER_WIDTH;
  let depth: number | undefined;
  let full = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = (flag: string) => (a === flag ? args[++i] : a.slice(flag.length + 1));
    if (a === '--width' || a.startsWith('--width=')) {
      const n = Number((value('--width') ?? '').replace(/px$/i, ''));
      if (!Number.isFinite(n) || n < 240 || n > 3840) return '--width takes a number of px between 240 and 3840, for example --width 375';
      width = Math.round(n);
    } else if (allow.depth && (a === '--depth' || a.startsWith('--depth='))) {
      const n = Number(value('--depth'));
      if (!Number.isInteger(n) || n < 0 || n > 6) return '--depth takes 0 to 6';
      depth = n;
    } else if (allow.full && a === '--full') {
      full = true;
    } else if (a.startsWith('--')) {
      return `unknown option ${a}`;
    } else {
      words.push(a);
    }
  }
  if (words.length === 0) return `say which page: ${command} /index.html`;
  if (words.length > 2) return `give the page and at most one element; a selector with spaces needs quotes: ${command} /index.html "${words.slice(1).join(' ')}"`;
  const first = parseElementTarget(words[0]);
  if (first.kind === 'position' && words.length === 1 && /\.html?$/i.test(first.file)) return { page: first.file, target: words[0], width, depth, full };
  if (/^[.#\[@*]/.test(words[0]) || (first.kind === 'selector' && words.length === 1 && !/[/.]/.test(words[0]) && /^(h[1-6]|p|a|div|section|nav|header|footer|main|ul|li|img|button|span|form)$/i.test(words[0]))) {
    return `the page comes first, then the element: ${command} /index.html "${words.join(' ')}"`;
  }
  const page = words[0].startsWith('/') ? words[0] : `/${words[0]}`;
  return { page, target: words[1], width, depth, full };
}

/** The element argument as the frame is asked for it (see `frameTarget`), or what is wrong with it. */
export async function resolveTarget(env: ShellEnv, target: string | undefined): Promise<{ ok: true; target?: string } | { ok: false; error: string }> {
  if (!target) return { ok: true };
  return frameTarget(env.vfs, env.projectId, target);
}

/** An error from the frame, naming the element as the command was given it rather than as the frame was asked. */
export function asGiven(error: string, asked: string | undefined, given: string | undefined): string {
  return asked && given && asked !== given ? error.split(asked).join(given) : error;
}

/** Render in this tab, or ask an open tab when this process has no browser. */
export async function render(env: ShellEnv, job: RenderJob): Promise<RenderResult> {
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const { renderPage } = await import('@/lib/canvas/render-job');
    return renderPage(job);
  }
  if (env.ctx?.renderInBrowser) return env.ctx.renderInBrowser(job);
  return { ok: false, error: 'pages are rendered in the browser, and no OSW Studio tab is connected to do it' };
}

/** `data-osw-src` values as positions the agent can give back (`/index.html:16:5`), reading each file once. */
export function sourceRefs(fs: VirtualFileSystem, projectId: string): (src: string | null) => Promise<string> {
  const files = new Map<string, Promise<string | null>>();
  return async (src) => {
    if (!src) return '(built by a script)';
    const parts = parseSrc(src);
    if (!parts) return src;
    let text = files.get(parts[0]);
    if (!text) {
      text = fs.readFile(projectId, parts[0]).then((file) => asText(file.content), () => null);
      files.set(parts[0], text);
    }
    const content = await text;
    return content === null ? parts[0] : sourceRef(parts[0], content, parts[1]);
  };
}
