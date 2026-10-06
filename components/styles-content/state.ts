/**
 * Pure reducer for the Styles tab. Emits commands rather than performing side effects,
 * so transitions are testable without mocking. Values come from the frame; this state
 * tracks pending confirmations, refusals, the transient declaration block, and overrides read back.
 */

import type { FocusContextPayload } from '@/lib/preview/types';
import type { ApplyResult, StyleDeclaration } from '@/lib/direct-edit/types';
import { MARKER_ATTR } from '@/lib/direct-edit/marker';
import { QUERY_PROPERTIES, STYLE_PROPERTIES, readNamesFor } from './properties';
import { parsePx } from './controls';

/** Restated rather than imported to keep this module free of VFS dependencies. */
export const OVERRIDES_PATH = '/overrides.css';

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

/** Holds a pending write or removal awaiting multi-instance confirmation. */
export interface PendingConfirmation {
  /** The declaration to write. Absent when what is held is a removal. */
  declaration?: StyleDeclaration;
  /** The property whose override is to be removed. Absent when what is held is a write. */
  removeProperty?: string;
  file?: string;
  instances: number;
}

export type StylesCommand =
  | { kind: 'apply'; declaration: StyleDeclaration; confirmedMultiInstance: boolean }
  /** Take this property back off the element's override block. */
  | { kind: 'remove'; property: string; confirmedMultiInstance: boolean }
  /**
   * Read back which properties `/overrides.css` declares for this marker.
   *
   * The one thing this panel asks of the project's files. It is emitted when the *element* changes,
   * not when a value does — see the three sites that emit it — because the answer only changes when
   * a block is written or removed, and a read per keystroke would put a whole-file scan behind the
   * stepper's `+`.
   */
  | { kind: 'read-overrides'; markerId: string }
  | { kind: 'preview'; markerId: string; css: string | null }
  | { kind: 'probe'; nodeId: string; markerId: string; properties: string[] }
  | { kind: 'query'; nodeId: string; properties: string[] }
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
  /** The marker `/overrides.css` blocks for this element are keyed to, once one exists. */
  markerId: string | null;
  /**
   * The transient block, property → value, in the order it was written.
   *
   * Sent to `style-preview` whole, never one declaration at a time: the frame replaces the transient
   * `<style>` on every send, so sending only the newest would visually revert every earlier edit —
   * and since the controls render from computed style, those controls would then snap back too.
   *
   * Session-local and reset on `frame-ready`, because after a recompile `/overrides.css` itself
   * carries the rules and the transient element is gone with the old document.
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
   * written in a previous session is in the file and in nothing else. Lowercased, because that is
   * how `declaredProperties` returns them and how they are compared.
   *
   * Emptied with the rest of the state when the element changes, and refilled by the answer — never
   * carried across elements, since a block belongs to exactly one marker.
   */
  overridden: readonly string[];
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
  /** The names the outstanding probe asked about, so its answer only overwrites those. */
  probing: readonly string[];
  /** An apply is in flight. */
  busy: boolean;
}

export function emptyStylesState(): StylesState {
  return {
    selection: null,
    computed: {},
    rootFontSize: null,
    markerId: null,
    declarations: {},
    committed: [],
    overridden: [],
    pending: null,
    confirmed: false,
    refusal: null,
    lost: {},
    probing: [],
    busy: false,
  };
}

export type StylesEvent =
  /** The user picked an element, or the frame re-resolved the one they had. `null` clears. */
  | { type: 'select'; payload: FocusContextPayload | null }
  /** The frame loaded a document — the first one, or a recompile's replacement. */
  | { type: 'frame-ready' }
  | { type: 'computed'; nodeId: string; values: Record<string, string>; rootFontSize?: string }
  /**
   * The answer to a `read-overrides` command. Carries the marker it is about, so an answer that
   * arrives after the user has moved on is dropped rather than credited to the new element.
   */
  | { type: 'overrides'; markerId: string; properties: readonly string[] }
  /** A control produced a declaration. */
  | { type: 'change'; declaration: StyleDeclaration }
  /** The user pressed Reset on a control: take this property's override off the element. */
  | { type: 'reset'; property: string }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'applied'; declaration: StyleDeclaration; result: ApplyResult }
  | { type: 'removed'; property: string; result: ApplyResult }
  | { type: 'probed'; nodeId: string; lost: readonly string[]; winner?: string }
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

/** The computed names a set of written properties comes back under. */
function probedNames(properties: readonly string[]): string[] {
  return Array.from(new Set(properties.flatMap(readNamesFor)));
}

/** The whole accumulated block, as a declaration list without braces. `null` when there is none. */
export function declarationBlock(declarations: Record<string, string>): string | null {
  const entries = Object.entries(declarations);
  if (entries.length === 0) return null;
  return entries.map(([property, value]) => `${property}: ${value};`).join(' ');
}

export function reduceStyles(state: StylesState, event: StylesEvent): StylesTransition {
  switch (event.type) {
    case 'select': {
      if (!event.payload) return { state: emptyStylesState(), commands: [] };
      const same = isSameSelection(state, event.payload);
      const base = same ? state : emptyStylesState();
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
        computed: {},
        rootFontSize: null,
        refusal: null,
        pending: null,
        busy: false,
        probing: [],
      };

      const commands: StylesCommand[] = [
        { kind: 'query', nodeId: event.payload.nodeId, properties: [...QUERY_PROPERTIES] },
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
      // The transient `<style>` died with the old document, and the rules it was showing are in
      // `/overrides.css` by now. Re-sending it would mask a later agent edit to the same block.
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
        },
        commands: [],
      };
    }

    case 'overrides': {
      // A read is in flight across an element change often enough to matter — the user clicks the
      // next element while the file is being read — and the marker is what tells the two apart.
      if (!state.markerId || event.markerId !== state.markerId) return { state, commands: [] };
      return { state: { ...state, overridden: [...event.properties] }, commands: [] };
    }

    case 'change': {
      if (!state.selection) return { state, commands: [] };
      return {
        state: { ...state, refusal: null, pending: null, busy: true },
        commands: [{
          kind: 'apply',
          declaration: event.declaration,
          confirmedMultiInstance: state.confirmed,
        }],
      };
    }

    case 'reset': {
      // Guarded on the marker as well as the selection: with no marker there is no block of ours in
      // `/overrides.css`, so there is nothing a removal could take out. See {@link canReset}, which
      // is what stops the control being offered in that state at all.
      if (!state.selection || !state.markerId) return { state, commands: [] };
      return {
        state: { ...state, refusal: null, pending: null, busy: true },
        commands: [{
          kind: 'remove',
          property: event.property,
          confirmedMultiInstance: state.confirmed,
        }],
      };
    }

    case 'confirm': {
      const pending = state.pending;
      if (!pending) return { state, commands: [] };
      const armed: StylesState = { ...state, confirmed: true, pending: null, refusal: null, busy: true };
      if (pending.removeProperty !== undefined) {
        return {
          state: armed,
          commands: [{
            kind: 'remove',
            property: pending.removeProperty,
            confirmedMultiInstance: true,
          }],
        };
      }
      if (!pending.declaration) return { state: { ...state, pending: null, busy: false }, commands: [] };
      return {
        state: armed,
        commands: [{
          kind: 'apply',
          declaration: pending.declaration,
          confirmedMultiInstance: true,
        }],
      };
    }

    case 'cancel':
      return { state: { ...state, pending: null, busy: false }, commands: [] };

    case 'applied':
      return applied(state, event.declaration, event.result);

    case 'removed':
      return removed(state, event.property, event.result);

    case 'probed': {
      if (!state.selection || event.nodeId !== state.selection.nodeId) return { state, commands: [] };
      const lost = { ...state.lost };
      // Only what this probe asked about is re-decided. A probe about `color` that comes back clean
      // says nothing about the padding an earlier probe reported lost.
      for (const name of state.probing) delete lost[name];
      for (const name of event.lost) lost[name] = event.winner ?? null;
      return { state: { ...state, lost, probing: [] }, commands: [] };
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
 * Shared by both paths because the vocabulary is the same one: `applyStyleOverride` and
 * `removeStyleOverride` refuse for the same reasons and report them in the same `ApplyResult`, so a
 * second copy of this could only differ by being wrong.
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

function applied(
  state: StylesState,
  declaration: StyleDeclaration,
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
          pending: {
            declaration,
            file: result.file,
            instances: result.instances ?? 0,
          },
        },
        commands: [],
      };
    }
    return { state: refused(state, result), commands: [] };
  }

  const markerId = result.markerId ?? state.markerId;
  // First write for this element: read the file for any existing overrides.
  const learnedMarker = state.markerId === null && markerId !== null;
  const declarations = { ...state.declarations, [declaration.property]: declaration.value };
  const committed = state.committed.includes(declaration.property)
    ? state.committed
    : [...state.committed, declaration.property];

  // Whatever this property lost to before, the answer is about to be remeasured — or, on the source
  // branch, cannot be measured until the frame returns. Either way the old verdict is not evidence.
  const lost = { ...state.lost };
  for (const name of readNamesFor(declaration.property)) delete lost[name];

  const next: StylesState = {
    ...state,
    busy: false,
    refusal: null,
    pending: null,
    markerId,
    declarations,
    committed,
    lost,
  };

  const read: StylesCommand[] = learnedMarker && markerId
    ? [{ kind: 'read-overrides', markerId }]
    : [];

  const written = result.filesWritten ?? [];
  const wroteSource = written.some(path => path !== OVERRIDES_PATH);
  if (wroteSource || !markerId || !state.selection) {
    // A recompile is coming. Anything sent into this document is sent into one about to be thrown
    // away, and the probe would answer about a document that does not carry the marker yet. The
    // file read is not a message to that document, so it still goes.
    return { state: next, commands: read };
  }

  const properties = probedNames(committed);
  return {
    state: { ...next, probing: properties },
    commands: [
      { kind: 'preview', markerId, css: declarationBlock(declarations) },
      { kind: 'probe', nodeId: state.selection.nodeId, markerId, properties },
      ...read,
    ],
  };
}

/** After a removal, refresh: the transient style can only add rules, not un-declare one. */
function removed(state: StylesState, property: string, result: ApplyResult): StylesTransition {
  if (!result.ok) {
    if (result.reason === 'needs-confirmation') {
      return {
        state: {
          ...state,
          busy: false,
          refusal: null,
          pending: {
            removeProperty: property,
            file: result.file,
            instances: result.instances ?? 0,
          },
        },
        commands: [],
      };
    }
    return { state: refused(state, result), commands: [] };
  }

  const declarations = { ...state.declarations };
  delete declarations[property];
  // Out of `committed` too: it is the probe's question list — probing a property we no longer
  // override reports it lost, correctly and uselessly — and it is what {@link canReset} reads to
  // decide the control is worth offering.
  const committed = state.committed.filter(name => name !== property);
  const lost = { ...state.lost };
  for (const name of readNamesFor(property)) delete lost[name];

  const next: StylesState = {
    ...state,
    busy: false,
    refusal: null,
    pending: null,
    declarations,
    committed,
    // Dropped here rather than left to the re-read below: the control has to stop being offered in
    // the same frame the press lands, and the read is a promise away.
    overridden: state.overridden.filter(name => name !== property.toLowerCase()),
    lost,
  };

  const wrote = (result.filesWritten ?? []).length > 0;
  const commands: StylesCommand[] = wrote ? [{ kind: 'refresh' }] : [];
  // The file just changed under the list, and a removal can take a whole block with it — so what is
  // left is re-read rather than inferred from what was asked for.
  if (state.markerId) commands.push({ kind: 'read-overrides', markerId: state.markerId });
  return { state: next, commands };
}

/** Two sources: session writes and file reads. Both needed because the file outlives the session. */
export function canReset(state: StylesState, property: string): boolean {
  if (state.markerId === null) return false;
  return state.committed.includes(property) || state.overridden.includes(property.toLowerCase());
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
  return out;
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
  /** This session's transient block, property → value: what the person actually set. */
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
