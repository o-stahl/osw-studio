/**
 * Shell command contract.
 *
 * Every command is a handler taking one environment object. cli-shell used to hold these as
 * `case` blocks closing over the dispatcher's locals; the closure surface was only ever these
 * six values, which is what made moving each command into its own file mechanical.
 */

import type { VirtualFileSystem } from '../index';
import type { ElementMatcher } from '@/lib/direct-edit/targets';
import type { RenderJob, RenderResult, ScreenshotImage } from '@/lib/canvas/render-types';

/**
 * Minimal context passed from the orchestrator into the shell executor so
 * commands can emit progress events (e.g. `ask`, `brief`, `spec`) without
 * depending on browser globals. Defined here to avoid a circular import
 * with lib/llm; callers pass a compatible subset of ToolExecutionContext.
 */
export interface ShellContext {
  onProgress?: (event: string, data?: any) => void;
  /** Generates an image from the project's image model. Absent when no image
   *  model is configured for the project. Injected from ToolExecutionContext. */
  generateImage?: (prompt: string, opts: { aspectRatio?: string; imageSize?: string }) => Promise<{ base64: string; mimeType: string }>;
  /** Conversation-scoped map of path → updatedAt epoch-ms at the agent's last full
   *  read (or whole-chunk write) of that file. Powers the read-before-edit staleness
   *  guard. Absent for direct/test callers, which disables the guard. */
  readVersions?: Map<string, number>;
  /** Delegate a build to the browser (server-side generation only). */
  onBuildRequested?: () => Promise<{ success: boolean; errors?: string[] }>;
  /** Delegate a web search to the browser (server-side generation only), so the client's
   *  configured provider/key runs it. Returns the command's stdout/stderr/exit. */
  onSearchRequested?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Matches a selector on a compiled page where there is no DOM to do it (server runs, MCP). */
  matchElements?: ElementMatcher;
  /**
   * Runs the matching of `rg` and `grep` off this thread with a time limit (server runs, MCP), where
   * a pattern that backtracks without end would otherwise hold the process. Absent: it runs here.
   */
  matchLines?: LineMatcher;
  /** Renders a page in an open browser tab, where this process has none (server runs, MCP). */
  renderInBrowser?: (job: RenderJob) => Promise<RenderResult>;
  /** Takes the images a command made for the model to look at. Absent: nothing can carry them. */
  onImages?: (images: ScreenshotImage[]) => void;
  /** Whether the model running the command reads images. */
  imageInput?: boolean;
}

/** One search's matching, as {@link ShellContext.matchLines} takes it. */
export interface LineMatchJob {
  /** The expression, as a `RegExp`'s `source` and `flags`. */
  source: string;
  flags: string;
  /** Select the lines that do not match (`-v`). */
  invert: boolean;
  /** Stop after this many selected lines in a text (`-m`). */
  max: number | null;
  /** Collect each selected line's matches as well (`-o`). */
  only: boolean;
  /** The texts searched, each as its lines. */
  texts: string[][];
}

/** One text's selected lines, by index, in order; with `only`, the non-empty matches on each. */
export interface LineMatches {
  lines: number[];
  parts?: string[][];
}

export type LineMatchOutcome =
  | { ok: true; found: LineMatches[] }
  /** The matching ran past the time limit, `limitMs`, and was stopped. */
  | { ok: false; limitMs: number };

export type LineMatcher = (job: LineMatchJob) => Promise<LineMatchOutcome>;

export type ShellResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * Optional reason flag the orchestrator can act on. Currently used by `ask`
   * to signal "awaiting_user" so the loop pauses for a chip selection.
   */
  exitReason?: string;
};

/** Everything a command handler can reach. Nothing here is mutated by a handler. */
export interface ShellEnv {
  vfs: VirtualFileSystem;
  projectId: string;
  /** Arguments after the command name, with redirects removed and globs already expanded. */
  args: string[];
  /** Piped input, when this command is downstream of a `|`. */
  stdin?: string;
  ctx?: ShellContext;
  /** Target of a trailing `>`/`>>`, already parsed off the argument list. */
  redirect?: { file: string; append: boolean };
}

export type ShellHandler = (env: ShellEnv) => Promise<ShellResult>;
