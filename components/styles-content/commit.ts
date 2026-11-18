/**
 * Type narrowing, commit scheduling, and optimistic overlay for style writes.
 * Dependencies (VFS, stores) are injected so the module is testable without side effects.
 */

import type { FocusContextPayload } from '@/lib/preview/types';
import type { ApplyResult, PreviewSelection, RecordedWrite, StyleChange, WriteRecorder } from '@/lib/direct-edit/types';
import type { OverrideScope } from '@/lib/direct-edit/overrides-css';
import type { MarkerOverrides } from '@/lib/direct-edit/apply-style';
import { WRITABLE_PROPERTIES, valueNames, type StyleProperty, type StyleUnit } from './properties';
import { pxPerUnit, unknownUnitContext, type UnitContext } from './controls';

/**
 * How long a change waits before it is written. The frames show it at once, laid over the file; the
 * wait makes a run of presses one write and one undo step.
 */
export const COMMIT_DEBOUNCE_MS = 300;

/** Narrows FocusContextPayload to the fields the write path needs. */
export function toPreviewSelection(payload: FocusContextPayload): PreviewSelection {
  return {
    srcAttr: payload.srcAttr ?? null,
    instanceCount: payload.instanceCount,
    tagName: payload.tagName,
    attributes: payload.attributes,
  };
}

/** The shape of `applyStyleOverride`, as this module needs it. */
export type StyleWriter = (
  projectId: string,
  selection: PreviewSelection,
  changes: readonly StyleChange[],
  opts: {
    scope: OverrideScope;
    markerId: string | null;
    newMarkerId?: string;
    confirmedMultiInstance: boolean;
    strengthen?: readonly string[];
    isGenerating: () => boolean;
    record?: WriteRecorder;
  },
) => Promise<ApplyResult>;

export interface StyleApplyDeps {
  apply: StyleWriter;
  /** Injected, not imported: lib/direct-edit/ must not depend on lib/stores/. */
  isGenerating: () => boolean;
  /** The edit journal, told about every file a write changes under the gesture's group key. */
  record?: (group: string, write: RecordedWrite) => void;
}

/** What a write is, besides its changes. */
export interface ApplyOptions {
  /** The width block it goes in. */
  scope: OverrideScope;
  /** The marker the panel knows, for a removal the payload may not carry it for yet. */
  markerId: string | null;
  /** For an unmarked element: the id to stamp, which the frames are already showing the change on. */
  newMarkerId?: string;
  confirmedMultiInstance: boolean;
  /** Properties to mark `!important` because a render showed them losing (`applyStyleOverride`). */
  strengthen?: readonly string[];
  /** One undo step: writes sharing a key (a scrub) are undone together. Absent, the write is its own. */
  group?: string;
}

/** One committed list of changes, against whichever element is selected when it runs. */
export type ApplyStyle = (
  selection: FocusContextPayload,
  changes: readonly StyleChange[],
  opts: ApplyOptions,
) => Promise<ApplyResult>;

let groupSeq = 0;
/** A group key no other gesture has. */
export const newGroup = () => `g${Date.now().toString(36)}.${++groupSeq}`;

/**
 * Bind a project and its dependencies to the write path.
 *
 * The *selection* is not bound: it is passed per call, so a commit that was scheduled before the
 * user clicked elsewhere is still written against the element it was made on.
 */
export function buildApplyStyle(projectId: string, deps: StyleApplyDeps): ApplyStyle {
  return (selection, changes, opts) => {
    const group = opts.group ?? newGroup();
    return deps.apply(projectId, toPreviewSelection(selection), changes, {
      scope: opts.scope,
      markerId: opts.markerId,
      newMarkerId: opts.newMarkerId,
      confirmedMultiInstance: opts.confirmedMultiInstance,
      strengthen: opts.strengthen,
      isGenerating: deps.isGenerating,
      record: deps.record ? (write) => deps.record!(group, write) : undefined,
    });
  };
}

/**
 * Reads what `/overrides.css` holds for a marker, so dots and Reset survive a reload.
 * No generation gate: reads cannot race the agent.
 */
export type ReadOverrides = (markerId: string) => Promise<MarkerOverrides>;

/** The number out of a value this panel wrote itself: `1.5rem` + `rem` → `1.5`, `2` + `` → `2`. */
export function writtenNumber(written: string, unit: string): number | null {
  const text = written.trim();
  const body = unit && text.endsWith(unit) ? text.slice(0, -unit.length) : text;
  const n = Number.parseFloat(body);
  return Number.isFinite(n) ? n : null;
}

/** Reads the unit from the value, not the entry default, so the overlay uses the unit the user picked. */
function writtenUnit(written: string): StyleUnit {
  const text = written.trim().toLowerCase();
  if (text.endsWith('rem')) return 'rem';
  if (text.endsWith('px')) return 'px';
  return '';
}

/** A written value in the computed shape the frame would answer with, or `null` if it has none. */
function computedForm(
  entry: StyleProperty,
  written: string,
  values: Record<string, string>,
  ctx: UnitContext,
): string | null {
  // Only a stepper shows a number converted out of px; every other control shows what was written.
  if (entry.control !== 'stepper') return written;
  const unit = writtenUnit(written);
  const n = writtenNumber(written, unit);
  if (n === null) return null;
  const per = pxPerUnit(entry, values, ctx, unit);
  // No divisor, no overlay. Showing the request against a guessed root size would put a number on
  // screen the element does not have.
  if (per === null) return null;
  return `${n * per}px`;
}

export function overlayRequested(
  computed: Record<string, string>,
  requested: Record<string, string>,
  ctx: UnitContext = unknownUnitContext,
): Record<string, string> {
  const values = { ...computed };
  // Sides included: a side is written like any other value, and iterating the table of *rows* meant
  // `padding-block-start` was never found here, so stepping a side moved nothing on screen until the
  // frame answered — which reads as a dead button.
  for (const entry of WRITABLE_PROPERTIES) {
    const written = requested[entry.property];
    if (typeof written !== 'string') continue;
    const resolved = computedForm(entry, written, values, ctx);
    if (resolved === null) continue;
    for (const name of valueNames(entry)) values[name] = resolved;
  }
  return values;
}

export interface CommitScheduler {
  /** Record changes and (re)arm the timer. A later change to the same property replaces the earlier one. */
  schedule: (changes: readonly StyleChange[]) => void;
  /** Commit whatever is outstanding, now. A no-op when nothing is. */
  flush: () => void;
  /** Throw away whatever is outstanding. */
  cancel: () => void;
  /** What is outstanding, for the host's own bookkeeping. */
  pending: () => StyleChange[];
}

/**
 * Trailing-edge debounce. Changes made in one window commit together, as one list in first-touch
 * order, so a control that writes several properties (Fill: width and flex) is one write.
 */
export function createCommitScheduler(
  delayMs: number,
  commit: (changes: StyleChange[]) => void,
): CommitScheduler {
  const outstanding = new Map<string, string | null>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const disarm = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const list = () => Array.from(outstanding, ([property, value]) => ({ property, value }));

  const flush = () => {
    disarm();
    if (outstanding.size === 0) return;
    const changes = list();
    outstanding.clear();
    commit(changes);
  };

  return {
    schedule(changes) {
      for (const change of changes) outstanding.set(change.property, change.value);
      disarm();
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      disarm();
      outstanding.clear();
    },
    pending: list,
  };
}
