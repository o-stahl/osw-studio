/**
 * Pure reducer for the Styles tab. Emits commands rather than performing side effects,
 * so transitions are testable without mocking. Values come from the frame; this state
 * tracks pending confirmations, refusals, the values this session wrote and what they lost to, and
 * the overrides read back.
 */

import type { FocusContextPayload, SpecifiedValue } from '@/lib/preview/types';
import type { ApplyResult, StyleChange } from '@/lib/direct-edit/types';
import { OVERRIDES_PATH, type OverrideScope } from '@/lib/direct-edit/overrides-css';
import type { MarkerOverrides } from '@/lib/direct-edit/apply-style';
import { MARKER_ATTR } from '@/lib/direct-edit/marker';
import { QUERY_PROPERTIES, SPECIFIED_PROPERTIES, STYLE_PROPERTIES, readNamesFor } from './properties';
import { parsePx } from './controls';

export { OVERRIDES_PATH };

/** The five ways an apply refuses that are not the multi-instance confirmation. */
export type RefusalReason =
  | 'unresolvable'
  | 'generating'
  | 'stale-index'
  | 'missing-file'
  | 'ambiguous-stylesheet';

export const REFUSAL_REASONS: readonly RefusalReason[] = [
  'unresolvable',
  'generating',
  'stale-index',
  'missing-file',
  'ambiguous-stylesheet',
];

/** Narrows ApplyResult reasons to those the Styles tab can render. */
function styleRefusalReason(reason: ApplyResult['reason']): RefusalReason {
  return REFUSAL_REASONS.includes(reason as RefusalReason)
    ? (reason as RefusalReason)
    : 'unresolvable';
}

export interface Refusal {
  reason: RefusalReason;
  /** The source file the refusal concerns, where the result named one. */
  file?: string;
  /** The thrown detail — today, the CSS scanner's message. */
  detail?: string;
  /**
   * Something reached the project before the refusal.
   *
   * True on `ambiguous-stylesheet` whenever the marker had already been stamped: the orchestrator
   * writes source *before* it touches `/overrides.css`, so the file on disk has changed even though
   * the style did not. The message must not claim nothing happened.
   */
  stamped: boolean;
}

/** Holds a write awaiting multi-instance confirmation. */
export interface PendingConfirmation {
  /** The changes to write; a `null` value removes. */
  changes: StyleChange[];
  /** The width block they go in. */
  scope: OverrideScope;
  file?: string;
  instances: number;
}

export type StylesCommand =
  /** Write these changes into the element's block for `scope`; a `null` value removes. */
  | { kind: 'apply'; changes: StyleChange[]; scope: OverrideScope; confirmedMultiInstance: boolean }
  /**
   * Read back which properties `/overrides.css` declares for this marker.
   *
   * The one thing this panel asks of the project's files. It is emitted when the *element* changes,
   * not when a value does — see the three sites that emit it — because the answer only changes when
   * a block is written or removed, and a read per keystroke would put a whole-file scan behind the
   * stepper's `+`.
   */
  | { kind: 'read-overrides'; markerId: string }
  /** `/overrides.css` as the write left it, for the frames to swap in. */
  | { kind: 'broadcast'; css: string }
  | { kind: 'probe'; nodeId: string; markerId: string; properties: string[]; tag?: 'earlier' }
  /**
   * Mark these written properties `!important` in the element's blocks: a probe showed them losing
   * to a rule of the project or to the element's own `style` attribute. Answered by `applied`, with
   * no changes, whose probe says whether they win now. `asked`: the user asked for it (Make it
   * apply), so it is an undo step of its own rather than part of the write that set them.
   */
  | { kind: 'strengthen'; scope: OverrideScope; properties: string[]; asked?: boolean }
  | { kind: 'query'; nodeId: string; properties: string[]; specified: string[] }
  | { kind: 'open-file'; path: string }
  /** Hand the refusal to the agent. `reason` is the user-facing message, which names the file. */
  | { kind: 'ask-agent'; reason: string }
  /** Requests a full recompile. */
  | { kind: 'refresh' };

export interface StylesState {
  selection: FocusContextPayload | null;
  /** The frame's last `style-computed` reply, keyed by expanded property name. */
  computed: Record<string, string>;
  /**
   * What one `rem` is worth in the previewed document, or `null` when the frame has not said.
   *
   * Same lifetime as {@link computed} — it arrives on the same reply and is cleared with it — which
   * is what makes "not known yet" a state the panel is already rendering as `—` rather than a new
   * one. Never defaulted to 16: see `UnitContext` in `./controls.tsx`.
   */
  rootFontSize: number | null;
  /** The winning declaration per property, as written: what Size, Font and the effects read. */
  specified: Record<string, SpecifiedValue | null>;
  /** The selection's frame width, from the same reply. */
  viewportWidth: number | null;
  /** The parent's layout, from the same reply: Fill writes `flex` in a flex row. */
  parent: { display: string; flexDirection: string } | null;
  /**
   * The width block edits go in: the scope of the selection's frame width. Set by the panel, which
   * knows the project's breakpoints. `committed` and `overridden` are about this scope only.
   */
  scope: OverrideScope;
  /** The marker `/overrides.css` blocks for this element are keyed to, once one exists. */
  markerId: string | null;
  /**
   * The values this session wrote, property → value, in the order they were written; a removal
   * takes its property out. What {@link lossAgentPrompt} quotes, so a request about a losing
   * property names the value that was asked for.
   *
   * Reset with the element, on `frame-ready` and on `reread`.
   */
  declarations: Record<string, string>;
  /**
   * Properties committed against {@link markerId} this session.
   *
   * Kept apart from {@link declarations} because it must survive `frame-ready`: it is the probe's
   * question list, and probing a property we never overrode reports it lost — the value is unchanged
   * when our rule is lifted out precisely because our rule never set it.
   */
  committed: readonly string[];
  /**
   * Properties `/overrides.css` declares for {@link markerId}, as last read back.
   *
   * The half of "is there something to reset" that {@link committed} cannot answer: an override
   * written in a previous session is in the file and in nothing else. As {@link propertyKey} gives
   * them, because that is how the file's reader returns them and how they are compared.
   *
   * Emptied with the rest of the state when the element changes, and refilled by the answer — never
   * carried across elements, since a block belongs to exactly one marker.
   */
  overridden: readonly string[];
  /** Everything `/overrides.css` holds for the marker, at every width, as last read back. */
  overrides: MarkerOverrides | null;
  pending: PendingConfirmation | null;
  /**
   * Multi-instance editing accepted for **this element**, not for one commit.
   *
   * Per-commit would ask again on every stepper press. Changing element disarms it; a recompile
   * does not, which is why {@link isSameSelection} exists.
   */
  confirmed: boolean;
  refusal: Refusal | null;
  /** Computed property name → what beat the override there, or `null` when nothing could be named. */
  lost: Record<string, string | null>;
  /** Read name → the variable its winning declaration is (`var(--name)` and nothing else), from the frame. */
  variables: Record<string, string>;
  /** The names the outstanding probe asked about, so its answer only overwrites those. */
  probing: readonly string[];
  /**
   * Written properties already made `!important` for this element this session. A property is
   * strengthened once: one that still loses after that lost to something a stylesheet cannot beat,
   * and is reported.
   */
  strengthened: readonly string[];
  /**
   * Declarations the file already held for this element, not written this session, that lose: the
   * name as the file declares it → what beat it. They are reported and offered (Make it apply),
   * never strengthened unasked: one may have been losing for as long as the site has been
   * published, and making it win changes how the page looks.
   */
  earlier: Record<string, string | null>;
  /** An apply is in flight. */
  busy: boolean;
}

export function emptyStylesState(): StylesState {
  return {
    selection: null,
    computed: {},
    rootFontSize: null,
    specified: {},
    viewportWidth: null,
    parent: null,
    scope: 'all',
    markerId: null,
    declarations: {},
    committed: [],
    overridden: [],
    overrides: null,
    pending: null,
    confirmed: false,
    refusal: null,
    lost: {},
    variables: {},
    probing: [],
    strengthened: [],
    earlier: {},
    busy: false,
  };
}

export type StylesEvent =
  /** The user picked an element, or the frame re-resolved the one they had. `null` clears. */
  | { type: 'select'; payload: FocusContextPayload | null }
  /** The frame loaded a document — the first one, or a recompile's replacement. */
  | { type: 'frame-ready' }
  | {
      type: 'computed';
      nodeId: string;
      values: Record<string, string>;
      rootFontSize?: string;
      specified?: Record<string, SpecifiedValue | null>;
      variables?: Record<string, string>;
      viewportWidth?: number;
      parent?: { display: string; flexDirection: string } | null;
    }
  /** The width block edits now go in. */
  | { type: 'scope'; scope: OverrideScope }
  /** Something other than this panel wrote the files (an undo): read them and the element again. */
  | { type: 'reread' }
  /** The frame may have changed size (a scope switch resized it): ask it about the element again. */
  | { type: 'requery' }
  /**
   * The answer to a `read-overrides` command. Carries the marker it is about, so an answer that
   * arrives after the user has moved on is dropped rather than credited to the new element.
   */
  | { type: 'overrides'; markerId: string; overrides: MarkerOverrides }
  /** A control produced changes: values to set, `null` to remove. */
  | { type: 'change'; changes: StyleChange[] }
  /** The user pressed a row's dot, or Reset: take these properties off the element at this width. */
  | { type: 'reset'; properties: string[] }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'applied'; changes: StyleChange[]; scope: OverrideScope; result: ApplyResult }
  | { type: 'probed'; nodeId: string; lost: readonly string[]; winner?: string; written?: readonly string[]; tag?: string }
  /** The user asked for the declarations in {@link StylesState.earlier} to be made to win. */
  | { type: 'make-apply' }
  /** The user took the refusal's offered action. */
  | { type: 'act-on-refusal' }
  | { type: 'dismiss-refusal' };

export interface StylesTransition {
  state: StylesState;
  commands: StylesCommand[];
}

/**
 * Matches on markerId and domPath. srcAttr not used because its index shifts on
 * every overrides.css write.
 */
export function isSameSelection(state: StylesState, payload: FocusContextPayload): boolean {
  if (!state.selection) return false;
  const marker = payload.attributes?.[MARKER_ATTR];
  if (marker && state.markerId && marker === state.markerId) return true;
  return state.selection.domPath === payload.domPath;
}

/**
 * A property name as `/overrides.css` compares it: a custom property (`--name`) as spelled, which CSS
 * tells apart by case, and any other lowercased. The rule the file's reader keys its answer by
 * (`nameKey` in `lib/direct-edit/overrides-css.ts`).
 */
export function propertyKey(property: string): string {
  return property.startsWith('--') ? property : property.toLowerCase();
}

/** The computed names a set of written properties comes back under. */
function probedNames(properties: readonly string[]): string[] {
  return Array.from(new Set(properties.flatMap(readNamesFor)));
}

export function reduceStyles(state: StylesState, event: StylesEvent): StylesTransition {
  switch (event.type) {
    case 'select': {
      if (!event.payload) return { state: emptyStylesState(), commands: [] };
      const same = isSameSelection(state, event.payload);
      // The width block stays: it is about the frame, which the next reply says again, not the element.
      const base = same ? state : { ...emptyStylesState(), scope: state.scope };
      /**
       * The marker the *element* carries, preferred over the one this session happens to remember.
       *
       * An element edited in an earlier session already has its `data-osw-id` in source, so it
       * arrives stamped on the very first selection — which is what lets the panel read that
       * element's block back and offer Reset for an override it did not write. Falling back to the
       * remembered one matters too: `gatherAttributes` caps its output, so an attribute-heavy
       * element can arrive without the marker it demonstrably has.
       */
      const markerId = event.payload.attributes?.[MARKER_ATTR] ?? base.markerId;
      // The computed reply is keyed to a node id, and this payload carries a different one whenever
      // the document was replaced. Keeping the old values would render the new element with the old
      // element's numbers until the reply lands.
      const next: StylesState = {
        ...base,
        selection: event.payload,
        markerId,
        // A block belongs to one marker, so a list read against a different one says nothing about
        // this one. The read below refills it.
        overridden: markerId === base.markerId ? base.overridden : [],
        overrides: markerId === base.markerId ? base.overrides : null,
        computed: {},
        rootFontSize: null,
        specified: {},
        variables: {},
        refusal: null,
        pending: null,
        busy: false,
        probing: [],
      };

      const commands: StylesCommand[] = [
        { kind: 'query', nodeId: event.payload.nodeId, properties: [...QUERY_PROPERTIES], specified: [...SPECIFIED_PROPERTIES] },
      ];
      // The same element coming back with a marker and a history is the post-recompile case: the
      // rule is in `/overrides.css` now, so this is the first moment a probe can answer honestly.
      if (same && next.markerId && next.committed.length > 0) {
        const properties = probedNames(next.committed);
        next.probing = properties;
        commands.push({
          kind: 'probe',
          nodeId: event.payload.nodeId,
          markerId: next.markerId,
          properties,
        });
      }
      // Every selection that names a marker, and only a selection: this is the moment the answer can
      // have changed under us — another element, a recompile, an agent edit — and it is not on any
      // control's path. A recompile re-selects through the `selection-resolve` handshake, so a block
      // the agent rewrote is picked up without the panel watching the file.
      if (markerId) commands.push({ kind: 'read-overrides', markerId });
      return { state: next, commands };
    }

    case 'frame-ready':
      // A new document, built from the files: what this session wrote is in `/overrides.css`, where
      // the agent may have changed it since, so its values are no longer quoted, and a loss reported
      // before the next write names the property alone. `committed` stays: it is the question list
      // for the probe that runs once the element is selected again.
      return { state: { ...state, declarations: {} }, commands: [] };

    case 'computed': {
      if (!state.selection || event.nodeId !== state.selection.nodeId) return { state, commands: [] };
      // Replaced, not merged. A reply always carries every key that was asked for — `''` where the
      // engine has no value — and a node that no longer resolves answers `{}`. Merging would leave
      // the previous reply's numbers on screen for an element that has gone.
      return {
        state: {
          ...state,
          computed: event.values,
          rootFontSize: parsePx(event.rootFontSize),
          specified: event.specified ?? {},
          variables: event.variables ?? {},
          viewportWidth: typeof event.viewportWidth === 'number' ? event.viewportWidth : state.viewportWidth,
          parent: event.parent ?? null,
        },
        commands: [],
      };
    }

    case 'scope': {
      if (event.scope === state.scope) return { state, commands: [] };
      // The session's writes and verdicts are about the width they were made at. At another width
      // the file says what is set, and a probe would measure rules that do not apply there.
      return {
        state: {
          ...state,
          scope: event.scope,
          committed: [],
          lost: {},
          probing: [],
          strengthened: [],
          earlier: {},
          overridden: overriddenIn(state.overrides, event.scope),
        },
        commands: [],
      };
    }

    case 'requery':
      if (!state.selection) return { state, commands: [] };
      return {
        state,
        commands: [{ kind: 'query', nodeId: state.selection.nodeId, properties: [...QUERY_PROPERTIES], specified: [...SPECIFIED_PROPERTIES] }],
      };

    case 'reread': {
      if (!state.selection) return { state, commands: [] };
      const commands: StylesCommand[] = [
        { kind: 'query', nodeId: state.selection.nodeId, properties: [...QUERY_PROPERTIES], specified: [...SPECIFIED_PROPERTIES] },
      ];
      if (state.markerId) commands.push({ kind: 'read-overrides', markerId: state.markerId });
      // What this session wrote may have just been taken back: the file says what is set now.
      return { state: { ...state, committed: [], declarations: {}, lost: {}, probing: [], strengthened: [], earlier: {} }, commands };
    }

    case 'overrides': {
      // A read is in flight across an element change often enough to matter — the user clicks the
      // next element while the file is being read — and the marker is what tells the two apart.
      if (!state.markerId || event.markerId !== state.markerId) return { state, commands: [] };
      const overridden = overriddenIn(event.overrides, state.scope);
      const next: StylesState = { ...state, overrides: event.overrides, overridden };
      // What the file held before this session is asked about too, by the names it declares, so a
      // change that has been losing is shown in the panel rather than only on the page.
      // Not at a width the block does not apply at, where everything in it would read as lost.
      const applies = state.scope === 'all' || (state.viewportWidth !== null && state.viewportWidth <= state.scope);
      const written = state.committed.map(propertyKey);
      const before = overridden.filter(name => !written.includes(name));
      if (!state.selection || !applies || before.length === 0) return { state: { ...next, earlier: {} }, commands: [] };
      return {
        state: next,
        commands: [{ kind: 'probe', nodeId: state.selection.nodeId, markerId: state.markerId, properties: [...before], tag: 'earlier' }],
      };
    }

    case 'make-apply': {
      const properties = Object.keys(state.earlier).filter(name => !state.strengthened.includes(name));
      if (!state.markerId || properties.length === 0) return { state, commands: [] };
      return {
        state: { ...state, earlier: {}, strengthened: [...state.strengthened, ...properties] },
        commands: [{ kind: 'strengthen', scope: state.scope, properties, asked: true }],
      };
    }

    case 'change': {
      if (!state.selection || event.changes.length === 0) return { state, commands: [] };
      return {
        state: { ...state, refusal: null, pending: null, busy: true },
        commands: [{
          kind: 'apply',
          changes: event.changes,
          scope: state.scope,
          confirmedMultiInstance: state.confirmed,
        }],
      };
    }

    case 'reset': {
      // Guarded on the marker as well as the selection: with no marker there is no block of ours in
      // `/overrides.css`, so there is nothing a removal could take out. See {@link canReset}, which
      // is what stops the control being offered in that state at all.
      if (!state.selection || !state.markerId || event.properties.length === 0) return { state, commands: [] };
      return {
        state: { ...state, refusal: null, pending: null, busy: true },
        commands: [{
          kind: 'apply',
          changes: event.properties.map(property => ({ property, value: null })),
          scope: state.scope,
          confirmedMultiInstance: state.confirmed,
        }],
      };
    }

    case 'confirm': {
      const pending = state.pending;
      if (!pending) return { state, commands: [] };
      return {
        state: { ...state, confirmed: true, pending: null, refusal: null, busy: true },
        commands: [{
          kind: 'apply',
          changes: pending.changes,
          scope: pending.scope,
          confirmedMultiInstance: true,
        }],
      };
    }

    case 'cancel':
      return { state: { ...state, pending: null, busy: false }, commands: [] };

    case 'applied':
      return applied(state, event.changes, event.scope, event.result);

    case 'probed': {
      if (!state.selection || event.nodeId !== state.selection.nodeId) return { state, commands: [] };
      if (event.tag === 'earlier') {
        // The whole answer about the file's own declarations, replacing the last one.
        const earlier = Object.fromEntries((event.written ?? []).map(name => [name, event.winner ?? null]));
        return { state: { ...state, earlier }, commands: [] };
      }
      const lost = { ...state.lost };
      // Only what this probe asked about is re-decided. A probe about `color` that comes back clean
      // says nothing about the padding an earlier probe reported lost.
      for (const name of state.probing) delete lost[name];
      for (const name of event.lost) lost[name] = event.winner ?? null;
      const probed: StylesState = { ...state, lost, probing: [] };
      // A change the user made that loses is made to win, once: what this session wrote, not what
      // an earlier one left, which may have been losing for as long as the site has been published.
      const weak = state.markerId === null
        ? []
        : state.committed.filter(property => !state.strengthened.includes(property) && lossFor(probed, property) !== null);
      if (weak.length === 0) return { state: probed, commands: [] };
      // Not shown as lost while the stronger rule is being written; its probe says how it went.
      for (const property of weak) for (const name of readNamesFor(property)) delete lost[name];
      return {
        state: { ...probed, strengthened: [...state.strengthened, ...weak] },
        commands: [{ kind: 'strengthen', scope: state.scope, properties: weak }],
      };
    }

    case 'act-on-refusal': {
      if (!state.refusal) return { state, commands: [] };
      const offer = refusalOffer(state.refusal);
      if (!offer) return { state, commands: [] };
      if (offer.kind === 'open-file') {
        return { state, commands: [{ kind: 'open-file', path: offer.path }] };
      }
      if (offer.kind === 'refresh') {
        return { state, commands: [{ kind: 'refresh' }] };
      }
      return { state, commands: [{ kind: 'ask-agent', reason: refusalAgentPrompt(state.refusal) }] };
    }

    case 'dismiss-refusal':
      return { state: { ...state, refusal: null }, commands: [] };
  }
}

/**
 * What a refused apply or removal leaves behind.
 *
 * One for both: a removal is `applyStyleOverride` with `null` values, so it refuses for the same
 * reasons and reports them in the same `ApplyResult`.
 */
function refused(state: StylesState, result: ApplyResult): StylesState {
  return {
    ...state,
    busy: false,
    pending: null,
    refusal: {
      reason: styleRefusalReason(result.reason),
      file: result.file,
      detail: result.message,
      stamped: (result.filesWritten ?? []).length > 0 || Boolean(result.markerId),
    },
  };
}

/** The properties the file declares for the marker in `scope`, as {@link propertyKey} gives them. */
function overriddenIn(overrides: MarkerOverrides | null, scope: OverrideScope): string[] {
  return Object.keys(overrides?.byScope.get(scope) ?? {});
}

function applied(
  state: StylesState,
  changes: StyleChange[],
  scope: OverrideScope,
  result: ApplyResult,
): StylesTransition {
  if (!result.ok) {
    if (result.reason === 'needs-confirmation') {
      // Held, not written. No apply command goes out until the user says yes.
      return {
        state: {
          ...state,
          busy: false,
          refusal: null,
          pending: { changes, scope, file: result.file, instances: result.instances ?? 0 },
        },
        commands: [],
      };
    }
    return { state: refused(state, result), commands: [] };
  }

  const markerId = result.markerId ?? state.markerId;
  const sets = changes.filter(change => change.value !== null);
  const removes = changes.filter(change => change.value === null).map(change => change.property);

  const declarations = { ...state.declarations };
  for (const change of sets) declarations[change.property] = change.value!;
  for (const property of removes) delete declarations[property];

  // Only the scope on screen is tracked: a write that landed elsewhere (the user switched width while
  // it was in flight) is in the file, and the read below is what reports it.
  const here = scope === state.scope;
  let committed = state.committed;
  let overridden = state.overridden;
  if (here) {
    committed = [
      ...committed.filter(name => !removes.includes(name)),
      ...sets.map(change => change.property).filter(name => !committed.includes(name)),
    ];
    // Dropped and added here rather than left to the re-read below: a dot has to appear or go in the
    // same frame the press lands, and the read is a promise away.
    const gone = removes.map(propertyKey);
    overridden = [
      ...overridden.filter(name => !gone.includes(name)),
      ...sets.map(change => propertyKey(change.property)).filter(name => !overridden.includes(name)),
    ];
  }

  // Whatever these properties lost to before, the answer is about to be remeasured, or, on the
  // source branch, cannot be measured until the frame returns. Either way the old verdict is not
  // evidence.
  const lost = { ...state.lost };
  for (const change of changes) for (const name of readNamesFor(change.property)) delete lost[name];

  const next: StylesState = {
    ...state,
    busy: false,
    refusal: null,
    pending: null,
    markerId,
    declarations,
    committed,
    overridden,
    lost,
    // A property taken off starts over: set again, it is an ordinary declaration until it loses.
    strengthened: here ? state.strengthened.filter(name => !removes.includes(name)) : state.strengthened,
  };

  // The file just changed under the dots and the CSS readout, and a removal can take a whole block
  // with it, so what is there is re-read rather than inferred from what was asked for.
  const read: StylesCommand[] = markerId ? [{ kind: 'read-overrides', markerId }] : [];

  const written = result.filesWritten ?? [];
  const wroteSource = written.some(path => path !== OVERRIDES_PATH);
  if (wroteSource || !markerId || !state.selection) {
    // A recompile is coming, or nothing changed in a document that carries the marker. Anything
    // sent into this document is sent into one about to be thrown away, and the probe would answer
    // about a document that does not carry the marker yet. The file read is not a message to that
    // document, so it still goes.
    return { state: next, commands: read };
  }

  const commands: StylesCommand[] = [];
  if (typeof result.css === 'string' && written.includes(OVERRIDES_PATH)) {
    commands.push({ kind: 'broadcast', css: result.css });
    // Read again once the frame has the new file: the Size modes, the effects and the dots read
    // what is declared, which no request in this session can stand in for after a removal.
    commands.push({ kind: 'query', nodeId: state.selection.nodeId, properties: [...QUERY_PROPERTIES], specified: [...SPECIFIED_PROPERTIES] });
  }
  if (here && committed.length > 0) {
    const properties = probedNames(committed);
    next.probing = properties;
    commands.push({ kind: 'probe', nodeId: state.selection.nodeId, markerId, properties });
  }
  return { state: next, commands: [...commands, ...read] };
}

/** Two sources: session writes and file reads. Both needed because the file outlives the session. */
export function canReset(state: StylesState, property: string): boolean {
  if (state.markerId === null) return false;
  return state.committed.includes(property) || state.overridden.includes(propertyKey(property));
}

export type RefusalOffer =
  | { kind: 'ask-agent' }
  | { kind: 'open-file'; path: string }
  | { kind: 'refresh' }
  | null;

/**
 * The `styles` keys the helpers below read. Named rather than `string`, so passing the panel's own
 * `t` makes `tsc` check every one exists in the messages.
 */
export type StylesMessageKey =
  | 'titleGenerating' | 'titleAmbiguous' | 'titleStale' | 'titleMissing' | 'titleUnresolvable'
  | 'msgUnresolvable' | 'msgGenerating' | 'msgStale' | 'msgStaleFile' | 'msgMissing' | 'msgMissingFile'
  | 'msgAmbiguous' | 'msgAmbiguousDefaultDetail' | 'msgAmbiguousStamped' | 'msgAmbiguousFix'
  | 'confirmMany' | 'confirmManyFrom' | 'confirmShared' | 'confirmSharedFrom'
  | 'lossItem' | 'lossUnknownWinner';

export type StylesTranslator = (key: StylesMessageKey, values?: Record<string, string | number>) => string;

/**
 * What the panel offers to do about a refusal, per the plan's table.
 *
 * `ambiguous-stylesheet` deliberately offers no retry: the file is in a shape the writer refuses to
 * touch, and pressing the control again produces the identical refusal.
 *
 * `generating` offers nothing at all. There is nothing to do but wait, and the controls are disabled
 * for its duration.
 */
export function refusalOffer(refusal: Refusal): RefusalOffer {
  switch (refusal.reason) {
    case 'unresolvable':
    case 'missing-file':
      return { kind: 'ask-agent' };
    case 'stale-index':
      return { kind: 'refresh' };
    case 'ambiguous-stylesheet':
      return { kind: 'open-file', path: OVERRIDES_PATH };
    case 'generating':
      return null;
  }
}

/**
 * What the panel says about a refusal.
 *
 * Each reason gets its own sentence, saying what happened and — separately — whether retrying can
 * help, because those are different questions and the answers do not line up: a stale index is worth
 * a refresh, a missing file is not, and a hand-broken stylesheet is worth neither.
 */
export function refusalMessage(refusal: Refusal, t: StylesTranslator): string {
  switch (refusal.reason) {
    case 'unresolvable':
      return t('msgUnresolvable');
    case 'generating':
      return t('msgGenerating');
    case 'stale-index':
      return refusal.file ? t('msgStaleFile', { file: refusal.file }) : t('msgStale');
    case 'missing-file':
      return refusal.file ? t('msgMissingFile', { file: refusal.file }) : t('msgMissing');
    case 'ambiguous-stylesheet':
      // Sentences joined, each whole: the stamped note is optional and goes between the other two.
      return [
        t('msgAmbiguous', { path: OVERRIDES_PATH, detail: refusal.detail ?? t('msgAmbiguousDefaultDetail') }),
        refusal.stamped ? t('msgAmbiguousStamped') : null,
        t('msgAmbiguousFix'),
      ].filter(Boolean).join(' ');
  }
}

/**
 * The refusal as a request to the agent, when the person presses "Ask the agent".
 *
 * Deliberately English and kept apart from `refusalMessage`: that one is the panel's text in the
 * reader's language, this one is sent to the agent as the person's message (English by decision).
 */
export function refusalAgentPrompt(refusal: Refusal): string {
  switch (refusal.reason) {
    case 'unresolvable':
      return 'This element is built at runtime, so there is no source tag to attach a style to. ' // i18n-ignore: part of a request to the agent
        + 'Ask the agent to change it instead.';
    case 'generating':
      return 'The agent is editing this project. Style changes wait until it finishes.'; // i18n-ignore: part of a request to the agent
    case 'stale-index':
      return `The preview is out of date${refusal.file ? `: ${refusal.file} has changed since it was compiled` : ''}. ` // i18n-ignore: part of a request to the agent
        + 'Refresh the preview and select the element again.';
    case 'missing-file':
      return `${refusal.file ?? 'The source file'} no longer exists, so there is nothing to attach a style to. ` // i18n-ignore: part of a request to the agent
        + 'Refreshing will not help — ask the agent to rebuild it.';
    case 'ambiguous-stylesheet':
      return `${OVERRIDES_PATH} could not be edited safely: ` // i18n-ignore: part of a request to the agent
        + `${refusal.detail ?? 'its blocks are not in the shape direct editing writes.'} `
        + (refusal.stamped
          ? 'A marker was already stamped into your source; on its own it does nothing. ' // i18n-ignore: part of a request to the agent
          : '')
        + 'Open the file and fix that block by hand — retrying will produce the same refusal.';
  }
}

/** Separate from refusalMessage so the headline does not contradict the detail. */
export function refusalTitle(refusal: Refusal, t: StylesTranslator): string {
  switch (refusal.reason) {
    case 'generating':
      return t('titleGenerating');
    case 'ambiguous-stylesheet':
      return t('titleAmbiguous', { path: OVERRIDES_PATH });
    case 'stale-index':
      return t('titleStale');
    case 'missing-file':
      return t('titleMissing');
    case 'unresolvable':
      return t('titleUnresolvable');
  }
}

/** What the panel says before writing to a shared source tag. */
export function confirmationMessage(pending: PendingConfirmation, t: StylesTranslator): string {
  const values = { count: pending.instances, file: pending.file ?? '' };
  if (pending.instances > 1) return t(pending.file ? 'confirmManyFrom' : 'confirmMany', values);
  return t(pending.file ? 'confirmSharedFrom' : 'confirmShared', values);
}

/**
 * What, if anything, beat the override on this property.
 *
 * `null` means the override is in force, or has not been measured. A `winner` of `null` inside the
 * result means something beat it that the frame's scan cannot name — a UA default, or a rule inside
 * an `@media` block, which it deliberately does not walk.
 */
export function lossFor(
  state: StylesState,
  property: string,
): { names: string[]; winner: string | null } | null {
  const names = readNamesFor(property).filter(name => name in state.lost);
  if (names.length === 0) return null;
  const winner = names.map(name => state.lost[name]).find(w => w != null) ?? null;
  return { names, winner };
}

/** One property whose override is written but not in force. */
export interface LostOverride {
  /** The property as written into `/overrides.css`. */
  property: string;
  /** The control's label, so a caller can point at the row without re-deriving it. */
  label: string;
  /** What the frame said beat it, or `null` when its scan could name nothing. */
  winner: string | null;
}

/** One message at the panel's foot, not per control. */
export function lostOverrides(state: StylesState): LostOverride[] {
  const out: LostOverride[] = [];
  // Rows only, deliberately. Walking the sides as well looks like it would close a gap — a lost
  // override on `padding-block-start` is reported by nothing here — but `state.lost` is keyed on the
  // *computed longhands*, so `lossFor` matches the shorthand and each of its sides alike, and one
  // lost padding became three lines saying the same thing. Closing it properly means knowing which
  // property was written, not which could have been.
  for (const entry of STYLE_PROPERTIES) {
    const loss = lossFor(state, entry.property);
    if (!loss) continue;
    out.push({ property: entry.property, label: entry.label, winner: loss.winner });
  }
  // What the file held before this session, by the name it declares.
  for (const [property, winner] of Object.entries(state.earlier)) {
    if (!out.some(item => item.property === property)) out.push({ property, label: property, winner });
  }
  return out;
}

/** Whether a loss on show can still be answered by marking it `!important`: the earlier ones not tried yet. */
export function canMakeApply(state: StylesState): boolean {
  return Object.keys(state.earlier).some(name => !state.strengthened.includes(name));
}

/** One clause per property, same shape. */
export function lossMessage(lost: readonly LostOverride[], t: StylesTranslator): string {
  return lost
    .map(item => t('lossItem', { property: item.property, winner: item.winner ?? t('lossUnknownWinner') }))
    .join(' ');
}

/** The whole set of losses, handed to the agent as one request rather than one per control. */
export function lossAgentPrompt(
  lost: readonly LostOverride[],
  /** The values this session wrote, property → value: what the person actually set. */
  declarations: Record<string, string> = {},
): string {
  // The value, not just the property. "padding loses to X" does not say what padding was asked
  // for, and the agent is being asked to make that value stick.
  const lines = lost.map(item => {
    const value = declarations[item.property];
    const declaration = value ? `${item.property}: ${value}` : item.property;
    return `- \`${declaration}\`${item.winner ? ` (beaten by ${item.winner})` : ''}`; // i18n-ignore: part of a request to the agent
  });
  return 'These style overrides on the selected element have no effect, because something else wins '
    + `the cascade:\n${lines.join('\n')}\n`
    + 'Change the project styles so the element gets the values I asked for.';
}

/**
 * The fold-in task: the overrides move into the project's own
 * stylesheets by the agent's judgement, and the file is emptied in the same task so no rule applies
 * twice. Goes into the composer, so the person sends it.
 */
export const FOLD_IN_PROMPT = 'Move the rules in /overrides.css into the project\'s own stylesheets. First run style --sweep to drop rules for elements that no longer exist. Put each remaining rule where it fits the way this project is written: on the element\'s own rule, a component class, or a token, keeping the width each one applies at. Then empty /overrides.css, keeping the file and the links to it, and leave the data-osw-id attributes in the markup. Check the pages at 375 and 1440 px wide before and after (screenshot or inspect) so nothing looks different.'; // i18n-ignore: sent to the agent as the user's message
