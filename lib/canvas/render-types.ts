/**
 * A page rendered in a browser tab for the agent's `inspect` and `screenshot` commands and the MCP
 * `preview_screenshot` tool, and what comes back. Plain data: a server run or the MCP server sends
 * the job to an open tab and gets the result back as JSON.
 */

export interface RenderJob {
  kind: 'inspect' | 'screenshot';
  projectId: string;
  /** The page file, `/about.html`. */
  page: string;
  /** Layout width in CSS px. */
  width: number;
  /** An element on the page: `@marker`, a `data-osw-src` value (`/file:offset`) or a selector. */
  target?: string;
  /** `inspect`: the properties to report for the target, where not the standard set. */
  props?: string[];
  /** `inspect`: how many levels of children to list. */
  depth?: number;
  /** `screenshot`: the whole page rather than the first screen. */
  full?: boolean;
}

/** An element as `inspect` reports it. */
export interface InspectNode {
  tag: string;
  id?: string;
  classes: string[];
  /** Its `data-osw-src`, or null when nothing in source made it (built by a script). */
  src: string | null;
  marker: string | null;
  /** Page coordinates, CSS px. */
  box: { x: number; y: number; w: number; h: number };
  /** A leaf's words, shortened. */
  text?: string;
  /** `display: none` or no box at this width. */
  hidden?: boolean;
  children?: InspectNode[];
  /** Children not listed: past the depth, or past the per-level limit. */
  more?: number;
}

/** Where a property's value comes from. */
export interface WinningDeclaration {
  value: string;
  selector: string;
  /** A project path, `/overrides.css`, `inline style`, or `a stylesheet` for one with no path. */
  origin: string;
  /** The `@media` condition the rule sits in, when it does. */
  media?: string;
  /** It is the element's own override in `/overrides.css`. */
  ours?: boolean;
}

export interface InspectStyle {
  property: string;
  computed: string;
  /** The rule that sets it, or none when the value is inherited or the browser's default. */
  declared?: WinningDeclaration;
}

export interface InspectReport {
  page: string;
  width: number;
  height: number;
  pageHeight: number;
  /** How many elements the target matched; the first is reported. Absent without a target. */
  matches?: number;
  node: InspectNode | null;
  /** For a target: its computed values and their winning declarations. */
  styles?: InspectStyle[];
}

export interface ScreenshotImage {
  mediaType: 'image/jpeg';
  /** Base64, no data: prefix. */
  data: string;
  /** Pixel size. */
  width: number;
  height: number;
  /** The page region it shows, CSS px. */
  region: { x: number; y: number; w: number; h: number };
}

export type RenderResult =
  | { ok: true; kind: 'inspect'; report: InspectReport }
  | { ok: true; kind: 'screenshot'; images: ScreenshotImage[]; pageHeight: number; width: number; height: number; matches?: number; cut?: boolean }
  | { ok: false; error: string };
