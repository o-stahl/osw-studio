/**
 * Shared types for the direct-edit write path.
 *
 * Direct editing turns a click in the preview into a durable style override: a stable
 * `data-osw-id` marker stamped into project *source*, plus a rule in `/overrides.css`. These types
 * describe the two ends of that path — where a selection resolves to in source, and what a single
 * apply did.
 */

/**
 * Where a preview selection came from in project source.
 *
 * `'runtime-unsupported'` is in the union for forward compatibility.
 */
export type SourceResolution =
  | { kind: 'resolved'; file: string; tagStart: number }
  | { kind: 'one-to-many'; file: string; tagStart: number; instances: number }
  | { kind: 'unresolvable'; reason: 'generated' | 'malformed' | 'runtime-unsupported' };

/**
 * The part of the preview's selection payload the write path reads.
 *
 * Structural and partial by design. The selector script sends more (`domPath`, `outerHTML`, …) and
 * will send more still; naming only what is consumed keeps `lib/direct-edit/` from depending on the
 * payload's shape. Every field is optional because every one of them can legitimately be absent —
 * a JS-generated element has no `srcAttr`, and `gatherAttributes` caps its output, so `attributes`
 * may not contain the marker even when the element carries one.
 */
export interface PreviewSelection {
  /** The `data-osw-src` value the preview compile stamped, as `<path>:<index>`. */
  srcAttr?: string | null;
  /** How many rendered elements share that one source tag. Absent means one. */
  instanceCount?: number;
  /** Lowercased tag name, used to detect a `tagStart` that has gone stale. */
  tagName?: string;
  attributes?: Record<string, string>;
}

/** A single CSS declaration to write into `/overrides.css`. */
export interface StyleDeclaration {
  property: string;
  value: string;
}

/** One change to an element's override block: a declaration to set, or with `value: null`, to remove. */
export interface StyleChange {
  property: string;
  value: string | null;
}

/** One file a direct edit wrote, as the edit journal keeps it. `before: null`: the write created it. */
export interface RecordedWrite {
  path: string;
  before: string | null;
  after: string;
  /** Written without a change event, as `/overrides.css` is; an undo writes it back the same way. */
  silent: boolean;
}

/** Told about every file a direct edit writes, after it is written. */
export type WriteRecorder = (write: RecordedWrite) => void;

/** Every refusal is reported rather than thrown; all are ordinary UI states. */
export interface ApplyResult {
  ok: boolean;
  /**
   * Shared union across all action paths. Unrecognised reasons fall through to unresolvable.
   */
  reason?: 'unresolvable' | 'generating' | 'needs-confirmation' | 'stale-index'
         | 'missing-file' | 'ambiguous-stylesheet' | 'no-src' | 'expression-src'
         | 'has-children' | 'has-expression' | 'unclosed' | 'void-element'
         // Structural edits (`apply-structure.ts`).
         | 'locked' | 'crosses-template' | 'into-itself' | 'not-a-frame' | 'no-place' | 'cross-file';
  /** The marker the override is keyed to. Present whenever one was read or stamped. */
  markerId?: string;
  /** Every path actually written, in write order. Empty on every refusal. */
  filesWritten?: string[];
  /** The source file a refusal concerns — the shared partial, the missing or stale file. */
  file?: string;
  /** How many rendered elements share the source tag. Set with `needs-confirmation`. */
  instances?: number;
  /** Pages that carry no `</head>`, so the stylesheet link could not be added to them. */
  skippedPages?: string[];
  /** The refusal's detail, where there is one worth showing — currently the thrown CSS message. */
  message?: string;
  /** `/overrides.css` as the write left it, for the frames to swap in. Set by style writes that read it. */
  css?: string;
}
