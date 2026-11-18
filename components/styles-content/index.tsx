'use client';

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useStylePropLabels } from '@/lib/i18n/use-style-prop-labels';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tip } from '@/components/ui/tooltip';
import { Copy, Crosshair, Eye, EyeOff, Minus, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { cn, logger } from '@/lib/utils';
import type { FocusContextPayload, OverrideMark, PreviewHostMessage, PreviewMessage } from '@/lib/preview/types';
import type { ApplyResult, StyleChange } from '@/lib/direct-edit/types';
import { OVERRIDES_PATH, applyChanges, type OverrideScope } from '@/lib/direct-edit/overrides-css';
import { offeredScopes, scopeOfWidth } from '@/lib/direct-edit/breakpoints';
import { newMarkerId } from '@/lib/direct-edit/marker';
import type { TextReadResult } from '@/lib/direct-edit/apply-text';
import {
  textConfirmationMessage,
  textRefusalAgentPrompt,
  textRefusalMessage,
  textRefusalOffersAgent,
  textRefusalTitle,
} from '@/components/text-popover/state';
import {
  PROPERTY_GROUPS,
  STYLE_PROPERTIES,
  type NumberEntry,
  type PropertyGroup,
  type SegmentedEntry,
  type SelectEntry,
  type StepperEntry,
  type StyleKeyword,
  type StyleProperty,
  type StyleUnit,
  type SwatchEntry,
  partEntry,
  readNamesFor,
  rowProperties,
  valueNames,
  VARIABLE_PROPERTIES,
} from './properties';
import { ThemeVariables, VariableField, variableContext, variableKey, type VariableHost } from './theme-variables';
import type { VariableDefinition } from '@/lib/direct-edit/css-variables';
import type { VariableWrite } from '@/lib/direct-edit/apply-variable';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  AlignPad,
  SegmentedControl,
  SelectRow,
  SetDot,
  Stepper,
  SwatchRow,
  SwitchRow,
  activeOptionValue,
  atLadderEnd,
  convertUnit,
  formatNumber,
  isMixed,
  ladderFloor,
  parsePx,
  readValue,
  stepValue,
  typedValue,
  writeValue,
  type SwatchOption,
  type UnitContext,
} from './controls';
import {
  canMakeApply,
  canReset,
  confirmationMessage,
  emptyStylesState,
  isSameSelection,
  lossAgentPrompt,
  FOLD_IN_PROMPT,
  lossFor,
  lossMessage,
  lostOverrides,
  propertyKey,
  reduceStyles,
  refusalMessage,
  refusalOffer,
  refusalTitle,
  type StylesCommand,
  type StylesEvent,
  type StylesState,
} from './state';
import {
  COMMIT_DEBOUNCE_MS,
  createCommitScheduler,
  newGroup,
  overlayRequested,
  type ApplyStyle,
  type ReadOverrides,
} from './commit';
import {
  hexColor,
  matchToken,
  sameColor,
  swatchAction,
  tokenAgentPrompt,
  tokenSupersedeMessage,
  type ColorToken,
  type FontToken,
} from './tokens';
import { baseNumber, convertNumber, keywordOf, parseNumber, scrubNumber, shownNumber, stepNumber, typedKeyword, typedNumber } from './number-field';
import { heightMode, heightModeChanges, widthMode, widthModeChanges, type HeightMode, type WidthMode } from './size-mode';
import { NEW_SHADOW, blurOf, gradientString, isOneGradient, parseGradient, readShadow, shadowString, withBlur } from './effects';
import {
  contentSection,
  emptyTextEditState,
  reduceTextEdit,
  resolveImageSrc,
  textSaveEnabled,
  type TextEditCommand,
  type TextEditEvent,
  type TextEditState,
} from './content-state';

/**
 * The Styles tab content. Renders controls over {@link reduceStyles}; all values, write paths, and
 * tokens arrive as props so the component imports no VFS or store.
 */

/** How the selection row describes the element. Pure, so the derivation is testable. */
export interface SelectionSummary {
  tag: string;
  /** The first class, prefixed with a dot — enough to recognise the element, short enough to fit. */
  className: string | null;
  /** Basename of the source file the compile attributed the element to. */
  source: string | null;
  instances: number;
}

/** The path part of a `data-osw-src` value: everything before its *last* colon. */
export function sourcePathOf(srcAttr: string | undefined): string | null {
  if (!srcAttr) return null;
  const cut = srcAttr.lastIndexOf(':');
  const path = cut === -1 ? srcAttr : srcAttr.slice(0, cut);
  return path === '' ? null : path;
}

export function describeSelection(payload: FocusContextPayload): SelectionSummary {
  const raw = payload.attributes?.class ?? '';
  const first = raw.trim().split(/\s+/).filter(Boolean)[0];
  const path = sourcePathOf(payload.srcAttr);
  return {
    tag: (payload.tagName || 'element').toLowerCase(),
    className: first ? `.${first}` : null,
    source: path ? (path.split('/').pop() || path) : null,
    instances: payload.instanceCount ?? 1,
  };
}

/** Each group's table rows, in table order. */
const ROWS: ReadonlyMap<PropertyGroup, StyleProperty[]> = new Map(
  PROPERTY_GROUPS.map(group => [group, STYLE_PROPERTIES.filter(entry => entry.group === group)]),
);

/** A table row by id. An id the table does not have is a mistake in this file, and throws. */
const row = <T extends StyleProperty>(id: string): T => {
  const entry = STYLE_PROPERTIES.find(candidate => candidate.id === id);
  if (!entry) throw new Error(`Styles: no row "${id}" in STYLE_PROPERTIES`); // i18n-ignore: a programming error, never shown to a person
  return entry as T;
};

/** The offsets, which are `auto` where nothing declares them, whatever pixels that comes to. */
const OFFSETS: ReadonlySet<string> = new Set(['left', 'top', 'right', 'bottom']);

/** Rows the Size group draws in its own places rather than in table order. */
const SIZE_FIELDS = ['width', 'height', 'max-width', 'min-width', 'max-height', 'min-height'];

/** How a drag on a stepper's label moves its value: per step, in the unit on screen. */
const SCRUB_STEP: Readonly<Record<StyleUnit, number>> = { rem: 0.0625, px: 1, '': 0.01, em: 0.01, '%': 1, deg: 1, vw: 1, vh: 1 };

/** The effects + adds and − takes off, by the property each writes. */
const EFFECTS = { shadow: 'box-shadow', blur: 'filter', backdrop: 'backdrop-filter', gradient: 'background-image' } as const;
type EffectKey = keyof typeof EFFECTS;
const REMOVE_LABEL = {
  shadow: 'effects.removeShadow',
  blur: 'effects.removeBlur',
  backdrop: 'effects.removeBackdrop',
  gradient: 'effects.removeGradient',
} as const satisfies Record<EffectKey, string>;

/** One write's changes, from when it is sent until it answers: the frames go on showing them. */
interface Unwritten {
  markerId: string;
  scope: OverrideScope;
  changes: StyleChange[];
  /** For an element's first edit: the element to mark with the marker the write will stamp. */
  mark: OverrideMark | null;
}

/** An element a write is for although the selection may have moved on: it, its marker and the undo step. */
interface WriteSite {
  selection: FocusContextPayload;
  markerId: string;
  group: string;
}

/** Neutral swatches for a project that declares no colour tokens of its own. */
const FALLBACK_SWATCHES = ['#000000', '#ffffff', '#6b7280'];

const NO_BREAKPOINTS: readonly number[] = [];

/**
 * The document a node id is from: the page and the width it is laid out at, which is one Canvas
 * artboard. Every artboard numbers its own elements, so an id alone names one in each.
 */
export interface NodeDocument {
  page: string;
  viewportWidth: number;
}

/** A row menu's Hide or Clear, waiting for the panel to hold the element it is for. */
interface WaitingCommand {
  command: 'toggle-hide' | 'clear-scope';
  nodeId: string;
  where?: NodeDocument;
}

/** Whether `selection` is the element a waiting command is for. */
const isFor = (selection: FocusContextPayload | null | undefined, waiting: WaitingCommand): boolean =>
  !!selection && selection.nodeId === waiting.nodeId
  && (!waiting.where || (selection.page === waiting.where.page && selection.viewportWidth === waiting.where.viewportWidth));

export interface StylesContentHandle {
  handleStyleComputed: (message: Extract<PreviewMessage, { type: 'style-computed' }>) => void;
  handleStyleProbeResult: (message: Extract<PreviewMessage, { type: 'style-probe-result' }>) => void;
  /** The frame loaded a document, built from the files: the values this session wrote are no longer quoted. */
  handleFrameReady: () => void;
  /** The files changed under the panel (an undo or redo): read the element and its overrides again. */
  handleOverridesChanged: () => void;
  /**
   * A drag on one of Canvas's handles, written as a label scrub is: shown at once, and one undo
   * step from `start` to `end`, at the width the panel is on.
   */
  dragStyle: (phase: 'start' | 'move' | 'end', changes: StyleChange[]) => void;
  /**
   * The element menu's Hide/Show and Clear, at the width the panel is on. With `nodeId`, on that
   * element: the command waits until the panel holds it and knows what the command reads (its values
   * for Hide, its overrides for Clear), and is dropped if another element is selected first or the
   * document is replaced. `where` names the document the id is from, where another can number its
   * own elements the same (a Canvas artboard).
   */
  runCommand: (command: 'toggle-hide' | 'clear-scope', nodeId?: string, where?: NodeDocument) => void;
  /** The width scope the panel writes to now. */
  currentScope: () => OverrideScope;
}

export interface StylesContentProps {
  /** The element the controls act on. `null` renders the empty state. */
  selection: FocusContextPayload | null;
  /** Post into the preview frame. A no-op when no frame is mounted. */
  sendToFrame: (message: PreviewHostMessage) => void;
  /** The durable write, removals included (a `null` value). `null` disables every control. */
  applyStyle: ApplyStyle | null;
  /**
   * What `/overrides.css` already holds for a marker, at every width.
   *
   * What makes the dots and Reset survive a reload: without it the panel knows only its own
   * session's writes, so an override made yesterday has no control to remove it. Optional and
   * injected for the same reason the write path is (this component imports no VFS), and a host that
   * omits it gets the session-only behaviour rather than an error. Failures answer with nothing; see
   * `readMarkerOverrides` in `lib/direct-edit/apply-style.ts`.
   */
  onReadOverrides?: ReadOverrides;
  /**
   * `/overrides.css` as the panel shows it, for every frame showing the project: as a write left it,
   * or with changes not yet written laid over it. `marks` are elements to mark for a first edit;
   * `unmarks` take back the marks of one that did not stamp. Absent, a write's result goes to the
   * frame `sendToFrame` reaches.
   */
  onOverrides?: (css: string, marks?: OverrideMark[], unmarks?: string[]) => void;
  /**
   * `/overrides.css` as it is now, answered from a copy where the host keeps one: it is read on
   * every animation frame a control changes. With `onOverrides`, what lets a change show in the
   * frames at once; absent, changes show when written.
   */
  readOverridesText?: () => Promise<string>;
  /** The project's breakpoint edges, widest first: what the width scopes are made of. */
  breakpoints?: readonly number[];
  /** The widths the surface can show the selection at, for Applies to's choices. */
  surfaceWidths?: readonly number[];
  /**
   * Move the selection to a frame whose width is in `scope`, as Canvas does by moving it to another
   * artboard. Absent, choosing a scope only says where edits go.
   */
  onScope?: (scope: OverrideScope) => void;
  /** The project's font tokens, for the Font menu. Empty: no Font row. */
  fontTokens?: readonly FontToken[];
  /**
   * Every custom property the project's CSS defines, and how often the CSS reads each. Listed when
   * nothing is selected, and offered behind a row whose value comes from one. Absent or empty: no
   * variables anywhere in the tab.
   */
  variables?: readonly VariableDefinition[];
  variableUses?: Readonly<Record<string, number>>;
  /**
   * Writes a variable's value into the stylesheet that declares it, in the undo step `group` names
   * where one is given. Absent: variables are shown nowhere.
   */
  onApplyVariable?: (def: VariableDefinition, value: string, group?: string) => Promise<VariableWrite>;
  /** Shows a variable's value on the pages before it is written; `null` takes that back. */
  onPreviewVariable?: (name: string, value: string | null) => void;
  /**
   * The project's own colour tokens — the swatches offered, and what a colour change is checked
   * against so the panel can say which token it superseded. Empty is a valid answer.
   */
  tokens: readonly ColorToken[];
  /**
   * What the selected element says, read out of **source**.
   *
   * Not taken off the selection payload, which carries the *rendered* text: a run the template
   * computes renders perfectly well and is refused, and that verdict only the source can give.
   *
   * Optional, with `onApplyText`: a host that passes neither gets no text editor rather than a
   * disabled one. See {@link contentSection}.
   */
  onReadText?: () => Promise<TextReadResult>;
  /**
   * Write the element's text. Returns what happened; the CONTENT section renders it.
   *
   * `confirmedMultiInstance` goes straight through to `applyText`, which refuses without it whenever
   * the source tag renders more than once.
   */
  onApplyText?: (text: string, confirmedMultiInstance: boolean) => Promise<ApplyResult>;
  /**
   * Open the project's image picker against the selected image.
   *
   * The picker is `components/image-picker/`, mounted by the workspace and shared with the preview
   * toolbar's `Replace` action — this section opens that one rather than growing a second. Omitting
   * it omits the image section.
   */
  onReplaceImage?: () => void;
  /**
   * A URL the app's document can load for the selected image, or `null` when there is none.
   *
   * Resolved outside the panel (`./use-image-url.ts`), because a project-relative `src` names a VFS
   * file rather than something this document can fetch.
   */
  imageUrl?: string | null;
  onOpenFile: (path: string) => void;
  onAskAgent: (prompt: string) => void;
  /**
   * Removes the rules of markers no file has any more, from the whole of `/overrides.css`: how many
   * elements' rules went, or `null` when it could not run (the agent is writing).
   */
  onSweepOverrides?: () => Promise<number | null>;
  onRefreshPreview: () => void;
  /**
   * Arm the preview's element picker, from the empty state.
   *
   * The panel does not do this itself for the same reason it does not do the write: arming means
   * making sure the *preview* is where the user can use it, and on the workspace's mobile block that
   * is a different act from what it is on the desktop block. Only the mount knows which surface it
   * is (see `SelectionSurface` in `components/workspace/index.tsx`), so the host supplies the
   * handler and this calls it.
   *
   * Optional: a host that passes nothing gets the two lines of copy and no button, which is the
   * state every container other than the workspace is in.
   */
  onSelectElement?: () => void;
  /**
   * The pointer entered (`true`) or left (`false`) that button — show what pressing it would affect.
   *
   * The workspace answers this by outlining the preview panel, the way the nav buttons outline the
   * panel they are about to open or evict. Reported as a plain boolean rather than as two callbacks
   * because the leave is the half that gets forgotten, and one signature makes it impossible to wire
   * the enter without it.
   */
  onSelectElementHover?: (hovering: boolean) => void;
  /**
   * The picker is armed right now — the press is a *cancel*, and the button says so.
   *
   * The state is the host's, not this panel's, because the host is what arms the picker and because
   * the preview header's crosshair moves the same flag: a copy held here would go stale the moment
   * the user used the other control. Optional and defaulting to disarmed, so a host that offers no
   * `onSelectElement` — every container but the workspace — needs to know nothing about it.
   *
   * There is no `hasFocusTarget` counterpart to the crosshair's third state: this button lives in
   * the empty state and does not render at all once something is selected.
   */
  focusToolArmed?: boolean;
}

function Alert({
  tone,
  title,
  children,
  actions,
}: {
  tone: 'amber' | 'danger' | 'quiet';
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-md border p-2 text-xs leading-relaxed flex flex-col gap-2',
        tone === 'amber' && 'border-amber-500/60 bg-amber-500/10 text-amber-700 dark:text-amber-400',
        tone === 'danger' && 'border-destructive/60 bg-destructive/10 text-destructive',
        tone === 'quiet' && 'border-primary/60 bg-primary/5 text-foreground',
      )}
    >
      <span className="font-semibold">{title}</span>
      <p className="opacity-90">{children}</p>
      {actions ? <div className="flex items-center gap-1 flex-wrap">{actions}</div> : null}
    </div>
  );
}

export const StylesContent = forwardRef<StylesContentHandle, StylesContentProps>(function StylesContent(
  props,
  ref,
) {
  const tt = useTranslations('tooltips');
  const sp = useStylePropLabels();
  const ts = useTranslations('styles');
  const tc = useTranslations('common');
  const twx = useTranslations('workspace');
  const ttp = useTranslations('textPopover');
  const { selection, tokens } = props;
  const [state, setState] = useState<StylesState>(emptyStylesState);
  /** Optimistic overlay so fast repeated presses step incrementally. */
  const [requested, setRequested] = useState<Record<string, string>>({});
  /** Note about the most recent swatch press. Not a gate. */
  const [tokenNote, setTokenNote] = useState<{ entry: SwatchEntry; token: ColorToken; next: string } | null>(null);

  // The reducer runs against a ref rather than through a `setState` updater: its transitions emit
  // commands, and an updater must be free of side effects (StrictMode invokes it twice).
  const stateRef = useRef(state);
  const propsRef = useRef(props);
  propsRef.current = props;
  const dispatchRef = useRef<(event: StylesEvent) => void>(() => {});

  /** The undo group the commits of a drag share; `null` outside one. */
  const groupRef = useRef<string | null>(null);
  /** The undo step the newest write went into, so making that write win joins it. */
  const lastGroupRef = useRef<string | null>(null);

  /** See `runCommand` on the handle. */
  const waitingRef = useRef<WaitingCommand | null>(null);
  /** Runs the waiting command once the panel holds its element and knows what the command reads. */
  const runWaiting = useCallback(() => {
    const waiting = waitingRef.current;
    const st = stateRef.current;
    if (!waiting || !isFor(st.selection, waiting)) return;
    const known = waiting.command === 'toggle-hide'
      ? Object.keys(st.computed).length > 0
      : !st.markerId || st.overrides !== null || !propsRef.current.onReadOverrides;
    if (!known) return;
    waitingRef.current = null;
    if (waiting.command === 'toggle-hide') commandsRef.current.toggleHide();
    else commandsRef.current.clear();
  }, []);

  // ---------- a change on screen before it is written ----------
  // The write waits for the debounce and then for storage; the frames should not. Each change sends
  // `/overrides.css` as it will be, the file with every change not yet written laid over it, on the
  // next animation frame.
  const inflightRef = useRef<Unwritten[]>([]);
  /** The marker an unmarked element's first edit will stamp: picked now, so the frames can show the edit on it. */
  const candidateRef = useRef<{ key: string; id: string } | null>(null);
  /** Marks the frames hold for a first edit that stamped some other marker or none, for the next send. */
  const takeBackRef = useRef<{ unmarks: string[]; marks: OverrideMark[] }>({ unmarks: [], marks: [] });
  /** The frames show something the file does not have yet, which a cancelled change has to take back. */
  const aheadRef = useRef(false);
  const previewFrameRef = useRef(0);
  const previewSeqRef = useRef(0);
  const sendPreviewRef = useRef<(force: boolean, written?: string) => Promise<void>>(async () => {});
  const schedulePreview = useCallback(() => {
    if (previewFrameRef.current || !propsRef.current.onOverrides) return;
    previewFrameRef.current = requestAnimationFrame(() => {
      previewFrameRef.current = 0;
      void sendPreviewRef.current(false);
    });
  }, []);
  useEffect(() => () => { if (previewFrameRef.current) cancelAnimationFrame(previewFrameRef.current); }, []);

  /** The marker a write for this element goes to: its own, or the one its first edit will stamp. */
  const writeMarker = useCallback((
    selection: FocusContextPayload | null,
    changes: readonly StyleChange[],
  ): { markerId: string; mark: OverrideMark | null } | null => {
    if (!selection || changes.length === 0) return null;
    const own = stateRef.current.markerId;
    if (own) return { markerId: own, mark: null };
    // Taking a property off an element with no marker changes nothing: it has no block to lose it from.
    if (!selection.srcAttr || !changes.some(change => change.value !== null)) return null;
    const key = `${selection.srcAttr}|${selection.domPath}`;
    if (candidateRef.current?.key !== key) candidateRef.current = { key, id: newMarkerId() };
    return { markerId: candidateRef.current.id, mark: { src: selection.srcAttr, markerId: candidateRef.current.id } };
  }, []);

  /**
   * The write path's calls, one at a time in the order they were made. Each reads `/overrides.css`,
   * changes it and writes it back, so a second started while the first is out would write over the
   * first's change. `null` when nothing is out, so a write made then starts at once.
   */
  const writesRef = useRef<Promise<void> | null>(null);
  const queueWrite = useCallback((write: () => Promise<void>) => {
    const before = writesRef.current;
    const done: Promise<void> = (before ? before.then(write) : write())
      .catch(error => { logger.error('Styles: a write failed', error); })
      .then(() => { if (writesRef.current === done) writesRef.current = null; });
    writesRef.current = done;
  }, []);

  /**
   * Writes a change to the element selected when it was made, once the writes before it have landed.
   * The element, its marker and the undo step are taken now: by the time the write starts, the
   * selection may have moved on. `site` names them instead, for a change made for an element that
   * was selected earlier.
   */
  const runApply = useCallback((command: Extract<StylesCommand, { kind: 'apply' }>, site?: WriteSite) => {
    const applied = site ? site.selection : stateRef.current.selection;
    const apply = propsRef.current.applyStyle;
    const markerId = site ? site.markerId : stateRef.current.markerId;
    const target = !applied || !apply ? null
      : site ? { markerId: site.markerId, mark: null }
      : writeMarker(applied, command.changes);
    const unwritten: Unwritten | null = target
      ? { markerId: target.markerId, scope: command.scope, changes: command.changes, mark: target.mark }
      : null;
    if (unwritten) {
      inflightRef.current = [...inflightRef.current, unwritten];
      // A write that did not come from a control (a dot, Clear, a confirmed change) shows at once too.
      schedulePreview();
    }
    const group = site?.group ?? groupRef.current ?? newGroup();
    // Making a change win joins the step of the selection's newest write, never another element's.
    if (!site || isSameSelection(stateRef.current, site.selection)) lastGroupRef.current = group;
    queueWrite(async () => {
      let result: ApplyResult;
      if (!applied || !apply) {
        result = { ok: false, reason: 'unresolvable', filesWritten: [] };
      } else {
        try {
          result = await apply(applied, command.changes, {
            scope: command.scope,
            markerId,
            newMarkerId: target?.mark ? target.markerId : undefined,
            confirmedMultiInstance: command.confirmedMultiInstance,
            group,
          });
        } catch (error) {
          // Logged: unresolvable is a specific claim and a storage failure is not that.
          logger.error('Styles: applying a change threw', error);
          result = { ok: false, reason: 'unresolvable', filesWritten: [] };
        }
        inflightRef.current = inflightRef.current.filter(entry => entry !== unwritten);
        if (unwritten?.mark) {
          const stamped = result.ok ? result.markerId : undefined;
          if (stamped !== unwritten.markerId) {
            // The frames marked the element for an id source did not take: take it back, and mark it
            // with the one source has.
            takeBackRef.current.unmarks.push(unwritten.markerId);
            if (stamped) takeBackRef.current.marks.push({ src: unwritten.mark.src, markerId: stamped });
            if (candidateRef.current?.id === unwritten.markerId) candidateRef.current = null;
          }
        }
        // Nothing was written, or a mark goes back: the frames go back to the file, with what is still
        // unwritten laid over it. A write that landed is shown by its broadcast, or already on screen.
        if (!result.ok || takeBackRef.current.unmarks.length > 0) void sendPreviewRef.current(true);
        // The user may have clicked elsewhere while the write was in flight. Folding this answer into
        // the new element's state would attribute one element's marker and history to another.
        if (!isSameSelection(stateRef.current, applied)) return;
      }
      if (!result.ok && result.reason !== 'needs-confirmation') {
        // Nothing was written, so the overlay is claiming values the element does not have.
        setRequested(prev => {
          const next = { ...prev };
          for (const change of command.changes) delete next[change.property];
          return next;
        });
      }
      dispatchRef.current({ type: 'applied', changes: command.changes, scope: command.scope, result });
    });
  }, [writeMarker, schedulePreview, queueWrite]);

  /**
   * Marks the properties a probe showed losing `!important`: in the undo step of the write that set
   * them, or in one of its own when the user asked (Make it apply). Its answer goes through `applied`
   * with no changes: the frames get the file, and the probe that follows says whether the properties
   * win now. A write that could not be made (the agent is running) asks the frame again instead, so
   * the loss is shown.
   */
  const runStrengthen = useCallback((
    command: Extract<StylesCommand, { kind: 'strengthen' }>,
  ) => {
    const selection = stateRef.current.selection;
    const markerId = stateRef.current.markerId;
    const apply = propsRef.current.applyStyle;
    if (!selection || !markerId || !apply) return;
    const group = command.asked ? undefined : lastGroupRef.current ?? undefined;
    queueWrite(async () => {
      let result: ApplyResult;
      try {
        result = await apply(selection, [], {
          scope: command.scope,
          markerId,
          // The change being made to win was already confirmed for every instance.
          confirmedMultiInstance: true,
          strengthen: command.properties,
          group,
        });
      } catch (error) {
        logger.error('Styles: strengthening a change threw', error);
        result = { ok: false, reason: 'unresolvable', filesWritten: [] };
      }
      if (!isSameSelection(stateRef.current, selection)) return;
      if (result.ok) {
        dispatchRef.current({ type: 'applied', changes: [], scope: command.scope, result });
        return;
      }
      propsRef.current.sendToFrame({
        type: 'style-probe',
        nodeId: selection.nodeId,
        markerId,
        properties: Array.from(new Set(command.properties.flatMap(readNamesFor))),
      });
    });
  }, [queueWrite]);

  /** Reads overrides for the current element. Stale markers are discarded by the reducer. */
  const runReadOverrides = useCallback(async (
    command: Extract<StylesCommand, { kind: 'read-overrides' }>,
  ) => {
    const read = propsRef.current.onReadOverrides;
    if (!read) return;
    let overrides: Awaited<ReturnType<ReadOverrides>>;
    try {
      overrides = await read(command.markerId);
    } catch {
      // The reader already answers nothing for a missing file and an unparseable one; this is only
      // the host throwing. Nothing to reset is the safe reading of an answer that never arrived.
      overrides = { byScope: new Map(), text: '', widths: [] };
    }
    dispatchRef.current({ type: 'overrides', markerId: command.markerId, overrides });
  }, []);

  const runCommand = useCallback((command: StylesCommand) => {
    const host = propsRef.current;
    switch (command.kind) {
      case 'query':
        host.sendToFrame({ type: 'style-query', nodeId: command.nodeId, properties: command.properties, specified: command.specified, variables: [...VARIABLE_PROPERTIES] });
        return;
      case 'broadcast':
        // With what is still unwritten laid over it, so a change made during the write stays on screen.
        if (host.onOverrides) void sendPreviewRef.current(true, command.css);
        else host.sendToFrame({ type: 'overrides-preview', css: command.css });
        return;
      case 'probe':
        host.sendToFrame({
          type: 'style-probe',
          nodeId: command.nodeId,
          markerId: command.markerId,
          properties: command.properties,
          ...(command.tag ? { tag: command.tag } : {}),
        });
        return;
      case 'open-file':
        host.onOpenFile(command.path);
        return;
      case 'ask-agent':
        host.onAskAgent(command.reason);
        return;
      case 'refresh':
        host.onRefreshPreview();
        return;
      case 'apply':
        runApply(command);
        return;
      case 'strengthen':
        runStrengthen(command);
        return;
      case 'read-overrides':
        void runReadOverrides(command);
        return;
    }
  }, [runApply, runStrengthen, runReadOverrides]);

  const dispatch = useCallback((event: StylesEvent) => {
    const { state: next, commands } = reduceStyles(stateRef.current, event);
    stateRef.current = next;
    setState(next);
    for (const command of commands) runCommand(command);
  }, [runCommand]);
  dispatchRef.current = dispatch;

  // The CONTENT section's text editor, run the same way: a pure reducer against a ref, with the
  // async calls performed here rather than inside it.
  const [textState, setTextState] = useState<TextEditState>(emptyTextEditState);
  const textStateRef = useRef(textState);
  const dispatchTextRef = useRef<(event: TextEditEvent) => void>(() => {});

  const runTextCommand = useCallback((command: TextEditCommand) => {
    const host = propsRef.current;
    void (async () => {
      if (command.kind === 'read') {
        let result: TextReadResult;
        try {
          // `contentSection` is what decides the editor exists at all, and it is false without both
          // halves — so a command reaching here with no reader is a bug, not a state to render.
          result = host.onReadText
            ? await host.onReadText()
            : { ok: false, reason: 'unresolvable' };
        } catch (error) {
          logger.error('Styles: reading the element text threw', error);
          result = { ok: false, reason: 'unresolvable' };
        }
        // The epoch, not a closure over the selection: the answer is dropped by the reducer when the
        // user has moved on, which is the one thing a late read must not survive.
        dispatchTextRef.current({ type: 'read', epoch: command.epoch, result });
        return;
      }
      let result: ApplyResult;
      try {
        result = host.onApplyText
          ? await host.onApplyText(command.text, command.confirmedMultiInstance)
          : { ok: false, reason: 'unresolvable', filesWritten: [] };
      } catch (error) {
        logger.error('Styles: writing the element text threw', error);
        result = { ok: false, reason: 'unresolvable', filesWritten: [] };
      }
      dispatchTextRef.current({ type: 'applied', epoch: command.epoch, result });
    })();
  }, []);

  const dispatchText = useCallback((event: TextEditEvent) => {
    const { state: next, commands } = reduceTextEdit(textStateRef.current, event);
    textStateRef.current = next;
    setTextState(next);
    for (const command of commands) runTextCommand(command);
  }, [runTextCommand]);
  dispatchTextRef.current = dispatchText;

  const scheduler = useMemo(
    () => createCommitScheduler(COMMIT_DEBOUNCE_MS, changes => {
      dispatchRef.current({ type: 'change', changes });
    }),
    [],
  );

  useEffect(() => () => scheduler.cancel(), [scheduler]);

  /** `written` is the file as a write just left it; without it, the host is asked for the file. */
  sendPreviewRef.current = async (force: boolean, written?: string) => {
    const host = propsRef.current;
    if (!host.onOverrides) return;
    const seq = ++previewSeqRef.current;
    const st = stateRef.current;
    const pending = scheduler.pending();
    const now = writeMarker(st.selection, pending);
    const groups: Unwritten[] = [
      ...inflightRef.current,
      ...(now ? [{ markerId: now.markerId, scope: st.scope, changes: pending, mark: now.mark }] : []),
    ];
    if (groups.length === 0 && !force && !aheadRef.current) return;
    let css = written;
    if (css === undefined) {
      if (!host.readOverridesText) return;
      try {
        css = await host.readOverridesText();
      } catch {
        // Shown when written instead.
        return;
      }
      if (seq !== previewSeqRef.current) return;
    }
    try {
      for (const group of groups) css = applyChanges(css, group.markerId, group.scope, group.changes);
    } catch {
      // A file the writer refuses to touch: the write refuses too, and says why.
      return;
    }
    const takeBack = takeBackRef.current;
    takeBackRef.current = { unmarks: [], marks: [] };
    aheadRef.current = groups.length > 0;
    const marks = [...takeBack.marks, ...groups.flatMap(group => (group.mark ? [group.mark] : []))];
    const unmarks = takeBack.unmarks.filter(id => !marks.some(mark => mark.markerId === id));
    host.onOverrides(css, marks, unmarks);
  };

  useImperativeHandle(ref, () => ({
    handleStyleComputed: (message) => {
      dispatch({
        type: 'computed',
        nodeId: message.nodeId,
        values: message.values,
        rootFontSize: message.rootFontSize,
        specified: message.specified,
        variables: message.variables,
        viewportWidth: message.viewportWidth,
        parent: message.parent,
      });
    },
    handleStyleProbeResult: (message) => {
      dispatch({ type: 'probed', nodeId: message.nodeId, lost: message.lost, winner: message.winner, written: message.written, tag: message.tag });
    },
    handleFrameReady: () => {
      setRequested({});
      waitingRef.current = null;
      dispatch({ type: 'frame-ready' });
    },
    handleOverridesChanged: () => {
      scheduler.cancel();
      setRequested({});
      // What the frames showed of the cancelled changes goes.
      if (aheadRef.current) void sendPreviewRef.current(true);
      dispatch({ type: 'reread' });
    },
    dragStyle: (phase, changes) => {
      if (phase === 'start') { groupRef.current = newGroup(); return; }
      if (phase === 'move') { if (changes.length) requestRef.current(changes); return; }
      scheduler.flush();
      groupRef.current = null;
    },
    runCommand: (command, nodeId, where) => {
      if (nodeId === undefined) {
        if (command === 'toggle-hide') commandsRef.current.toggleHide();
        else commandsRef.current.clear();
        return;
      }
      waitingRef.current = { command, nodeId, where };
      runWaiting();
    },
    currentScope: () => commandsRef.current.scope,
  }), [dispatch, scheduler, runWaiting]);

  useEffect(() => {
    // Flush before updating selection so the write targets the outgoing element.
    scheduler.flush();
    setRequested({});
    setTokenNote(null);
    // A command waiting for another element is not for this one.
    if (waitingRef.current && !isFor(selection, waitingRef.current)) waitingRef.current = null;
    dispatchRef.current({ type: 'select', payload: selection });
  }, [selection, scheduler]);

  // Both halves of the text path, as one answer: a field with no writer behind it loses whatever is
  // typed into it, and a writer with no reader has nothing to put in the field.
  const canEditText = Boolean(props.onReadText && props.onApplyText);
  const canReplaceImage = Boolean(props.onReplaceImage);

  // A recompile hands back a fresh payload through the `selection-resolve` handshake, so this is
  // also the re-read after a write: the file has changed, and what the field shows must come from it
  // rather than from what was typed into it a moment ago.
  useEffect(() => {
    dispatchTextRef.current({
      type: 'select',
      kind: contentSection(selection, { canEditText, canReplaceImage }),
    });
  }, [selection, canEditText, canReplaceImage]);

  /** Kept across selections: a control preference, not an element fact. */
  const [units, setUnits] = useState<Record<string, StyleUnit>>({});
  const unitOf = useCallback(
    (entry: StepperEntry): StyleUnit => units[entry.id] ?? entry.unit,
    [units],
  );

  const unitContext = useMemo<UnitContext>(
    () => ({ rootFontSize: state.rootFontSize }),
    [state.rootFontSize],
  );

  const values = useMemo(
    () => overlayRequested(state.computed, requested, unitContext),
    [state.computed, requested, unitContext],
  );

  // ---------- width scope ----------
  const breakpoints = props.breakpoints ?? NO_BREAKPOINTS;
  /** A scope picked in Applies to that no frame could be moved to: edits go there anyway. */
  const [chosenScope, setChosenScope] = useState<{ scope: OverrideScope; for: string } | null>(null);
  // The element by where it sits and the file it comes from: not by its marker, which its first
  // write stamps, and not by the offset in the file, which a write that links the stylesheet moves.
  const selectionKey = selection ? `${selection.domPath}|${sourcePathOf(selection.srcAttr) ?? ''}` : '';
  const frameScope = state.viewportWidth !== null ? scopeOfWidth(state.viewportWidth, breakpoints) : state.scope;
  const scope: OverrideScope = chosenScope && chosenScope.for === selectionKey ? chosenScope.scope : frameScope;
  useEffect(() => {
    if (scope === state.scope) return;
    // What is waiting to be written was made for the width on screen until now, and what was asked
    // for there is not what the element has at the new one.
    scheduler.flush();
    setRequested({});
    dispatchRef.current({ type: 'scope', scope });
  }, [scope, state.scope, scheduler]);
  const scopes = useMemo(
    () => offeredScopes(breakpoints, props.surfaceWidths ?? (state.viewportWidth !== null ? [state.viewportWidth] : []), scope),
    [breakpoints, props.surfaceWidths, state.viewportWidth, scope],
  );
  const dotTip = scope === 'all' ? ts('tips.setDotAll') : ts('tips.setDotUpTo', { width: scope });
  /** The re-ask after a scope is picked, and the reset of Copy's tip: neither runs once the panel is gone. */
  const requeryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    clearTimeout(requeryTimerRef.current);
    clearTimeout(copiedTimerRef.current);
  }, []);
  const onPickScope = useCallback((value: string) => {
    const next: OverrideScope = value === 'all' ? 'all' : Number(value);
    setChosenScope({ scope: next, for: selectionKey });
    propsRef.current.onScope?.(next);
    // A frame resized for the scope says nothing until asked; Canvas moves the selection instead,
    // and the new selection is asked anyway.
    clearTimeout(requeryTimerRef.current);
    requeryTimerRef.current = setTimeout(() => dispatchRef.current({ type: 'requery' }), 400);
  }, [selectionKey]);

  const summary = selection ? describeSelection(selection) : null;
  const generating = state.refusal?.reason === 'generating';
  // The token note is absent from this list on purpose: it reports something that already happened,
  // so leaving the controls live is the whole point of it being a note and not a refusal.
  const disabled = !selection
    || !props.applyStyle
    || generating
    || Boolean(state.pending);

  /** Show `shown` for each changed property at once, and write the changes after the debounce. */
  const request = useCallback((changes: StyleChange[], shown: Record<string, string> = {}) => {
    if (changes.length === 0) return;
    setRequested(prev => {
      const next = { ...prev };
      for (const change of changes) {
        if (change.value === null) delete next[change.property];
        else next[change.property] = shown[change.property] ?? change.value;
      }
      return next;
    });
    scheduler.schedule(changes);
    schedulePreview();
  }, [scheduler, schedulePreview]);
  const set = useCallback((property: string, value: string | null) => request([{ property, value }]), [request]);
  const requestRef = useRef(request);
  requestRef.current = request;

  const onStep = useCallback((entry: StepperEntry, direction: 1 | -1) => {
    const next = stepValue(entry, values, direction, unitContext, unitOf(entry));
    // `null` means the rung cannot be expressed in the unit on screen because the frame has not said
    // what a rem is worth here yet. Writing nothing is the only answer that cannot move the element.
    if (next === null) return;
    set(entry.property, next);
  }, [values, set, unitContext, unitOf]);

  const onTypeValue = useCallback((entry: StepperEntry, text: string) => {
    const keyword = typedKeyword(entry.keywords, text);
    if (keyword) { set(entry.property, keyword); return; }
    const next = typedValue(text, unitOf(entry));
    // Refused rather than corrected: the field reverts to what the element is, which is a truthful
    // answer to `12px;color:red` in a way that writing some parse of it would not be.
    if (next === null) return;
    set(entry.property, next);
  }, [set, unitOf]);

  const onUnit = useCallback((entry: StepperEntry, unit: StyleUnit) => {
    setUnits(prev => ({ ...prev, [entry.id]: unit }));
    // The element keeps its size: the number is recomputed for the new unit and written. `null` —
    // an `auto`, a mixed pair of sides, a root size that has not arrived — changes the label only.
    const converted = convertUnit(entry, values, unit, unitContext);
    if (converted === null) return;
    set(entry.property, converted);
  }, [values, set, unitContext]);

  // ---------- drags on a label: one undo step from press to release ----------
  const scrubStart = useRef<{ n: number; unit: StyleUnit } | null>(null);
  const beginScrub = useCallback((start: { n: number | null; unit: StyleUnit }) => {
    scrubStart.current = { n: start.n ?? 0, unit: start.unit };
    groupRef.current = newGroup();
  }, []);
  const endScrub = useCallback(() => {
    scheduler.flush();
    scrubStart.current = null;
    groupRef.current = null;
  }, [scheduler]);
  const onScrubStepper = useCallback((entry: StepperEntry, steps: number) => {
    const start = scrubStart.current;
    if (!start) return;
    const floor = ladderFloor(entry, values, unitContext, start.unit) ?? 0;
    const n = Math.max(floor, start.n + steps * SCRUB_STEP[start.unit]);
    set(entry.property, writeValue(n, start.unit));
  }, [set, values, unitContext]);

  // ---------- number rows ----------
  const numberContext = useCallback((entry: NumberEntry) => ({
    requested: requested[entry.property],
    specified: state.specified[entry.property],
    computed: values[entry.read[0]],
    rootFontSize: state.rootFontSize,
    fontSize: parsePx(values['font-size']),
    unit: units[entry.id],
    viewportWidth: state.viewportWidth,
    start: entry.startFrom ? values[entry.startFrom] : undefined,
  }), [requested, state.specified, values, state.rootFontSize, units, state.viewportWidth]);
  const shownOf = useCallback((entry: NumberEntry) => shownNumber(entry, numberContext(entry)), [numberContext]);
  /** What `+`, `−`, a drag and a unit change start from: the number shown, or the row's `startFrom`. */
  const baseOf = useCallback((entry: NumberEntry) => baseNumber(shownOf(entry), numberContext(entry)), [shownOf, numberContext]);
  const onNumberStep = useCallback((entry: NumberEntry, direction: 1 | -1) => {
    set(entry.property, stepNumber(entry, baseOf(entry), direction));
  }, [set, baseOf]);
  const onNumberType = useCallback((entry: NumberEntry, text: string) => {
    const keyword = typedKeyword(entry.keywords, text);
    if (keyword) { set(entry.property, keyword); return; }
    const next = typedNumber(entry, text, shownOf(entry).unit);
    if (next !== null) set(entry.property, next);
  }, [set, shownOf]);
  const onNumberUnit = useCallback((entry: NumberEntry, unit: StyleUnit) => {
    const converted = convertNumber(entry, baseOf(entry), unit, numberContext(entry));
    setUnits(prev => ({ ...prev, [entry.id]: unit }));
    if (converted !== null) set(entry.property, converted);
  }, [set, baseOf, numberContext]);
  const onScrubNumber = useCallback((entry: NumberEntry, steps: number) => {
    const start = scrubStart.current;
    if (start) set(entry.property, scrubNumber(entry, { n: start.n, unit: start.unit }, steps));
  }, [set]);

  const onSelectOption = useCallback((entry: SegmentedEntry | SelectEntry, value: string) => {
    // A keyword the CSS writes as is; `auto` for the aspect ratio is the property's own default and
    // is written as such only when another stylesheet sets one.
    set(entry.property, value);
  }, [set]);

  const onSwatch = useCallback((entry: SwatchEntry, next: string) => {
    const action = swatchAction(entry, next, values, tokens);
    // Shown as the literal the user picked, written as `var(--token)` when that colour is one —
    // the swatch has to render, and `var(...)` is not a colour outside the document that defines it.
    request([{ property: entry.property, value: action.declaration.value }], { [entry.property]: next });
    // Set *or cleared* on every press: a note left standing from an earlier press would attribute
    // this one to a token it had nothing to do with.
    setTokenNote(action.superseded ? { entry, token: action.superseded, next } : null);
  }, [values, tokens, request]);

  // ---------- set dots ----------
  /** Which of `properties` this width's block sets for the element, now or after this session's writes. */
  const setHere = useCallback((properties: readonly string[]) => properties.filter(p =>
    state.overridden.includes(propertyKey(p)) || state.committed.includes(p),
  ), [state.overridden, state.committed]);
  const resetHere = useCallback((properties: readonly string[]) => {
    const list = setHere(properties);
    if (list.length === 0) return;
    // A note about a supersede that is being undone would be stranded the moment this lands.
    setTokenNote(null);
    scheduler.flush();
    setRequested(prev => {
      const next = { ...prev };
      for (const property of list) delete next[property];
      return next;
    });
    dispatchRef.current({ type: 'reset', properties: list });
  }, [setHere, scheduler]);
  /** The change held for confirmation is dropped, and with it what the controls showed of it. */
  const onCancelPending = () => {
    const pending = stateRef.current.pending;
    if (pending) {
      setRequested(prev => {
        const next = { ...prev };
        for (const change of pending.changes) delete next[change.property];
        return next;
      });
    }
    dispatch({ type: 'cancel' });
  };
  const dot = (properties: readonly string[], label: string) =>
    props.applyStyle && setHere(properties).length > 0
      ? <SetDot label={label} tip={dotTip} disabled={disabled} onReset={() => resetHere(properties)} />
      : undefined;

  /**
   * Which values are opened up into their sides or corners.
   *
   * Local, and deliberately not reset when the selection changes: someone who opened Padding is
   * usually about to open it on the next element too, and re-collapsing it on every click would
   * make the panel feel like it was fighting them.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = useCallback((id: string) => {
    setExpanded(current => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  /** Deduped by value, keeping the first name. */
  const swatches = useMemo<SwatchOption[]>(() => {
    const byValue = new Map<string, string | null>();
    for (const token of tokens) {
      if (!byValue.has(token.value)) byValue.set(token.value, token.name);
    }
    if (byValue.size > 0) {
      return Array.from(byValue, ([value, name]) => ({ name, value }));
    }
    return FALLBACK_SWATCHES.map(value => ({ name: null, value }));
  }, [tokens]);

  /** Matching uses sameColor because declared and computed forms differ. */
  const selectedSwatch = useCallback(
    (current: string | null) => swatches.find(swatch => sameColor(current, swatch.value))?.value ?? null,
    [swatches],
  );

  // ---------- Size ----------
  /** The declarations as written, with this session's requests standing in until the frame answers. */
  const asWritten = useCallback((property: string) => {
    const asked = requested[property];
    return asked !== undefined
      ? { value: asked, origin: OVERRIDES_PATH, ours: true, under: state.specified[property]?.under ?? null }
      : state.specified[property] ?? null;
  }, [requested, state.specified]);
  const sizeFacts = { width: asWritten('width'), height: asWritten('height'), flex: asWritten('flex'), parent: state.parent };
  const widthNow = widthMode(sizeFacts);
  const heightNow = heightMode(sizeFacts);
  const onWidthMode = (mode: string) => request(widthModeChanges(mode as WidthMode, sizeFacts, parsePx(values.width)));
  const onHeightMode = (mode: string) => request(heightModeChanges(mode as HeightMode, sizeFacts, parsePx(values.height)));

  // ---------- Layout ----------
  const display = values.display ?? '';
  const isFlex = display.includes('flex');
  const isGrid = display.includes('grid');
  const flexRow = (values['flex-direction'] ?? 'row').startsWith('row');
  const between = values['justify-content'] === 'space-between';
  const stretch = values['align-items'] === 'stretch' || values['align-items'] === 'normal';
  const onPad = (main: string, cross: string) => request([
    { property: 'align-items', value: cross },
    // Space between keeps the main axis; only the cross axis moves.
    ...(between ? [] : [{ property: 'justify-content', value: main }]),
  ]);
  /** Inline keeps the layout kind: block, flex or grid, as an inline box. */
  const onInline = (on: boolean) => {
    const base = isFlex ? 'flex' : isGrid ? 'grid' : 'block';
    set('display', on ? `inline-${base}` : base);
  };
  /** Flex or grid from block writes a starting layout, as a person switching to it would want. */
  const onDisplay = (value: string) => {
    if (value === 'flex' && !isFlex) request([{ property: 'display', value: 'flex' }, { property: 'flex-direction', value: 'column' }, { property: 'gap', value: '12px' }]);
    else if (value === 'grid' && !isGrid) request([{ property: 'display', value: 'grid' }, { property: 'grid-template-columns', value: 'repeat(2, minmax(0, 1fr))' }, { property: 'gap', value: '16px' }]);
    else set('display', value);
  };

  // ---------- Effects and the gradient ----------
  const currentOf = (property: string) => requested[property] ?? state.specified[property]?.value ?? values[property] ?? '';
  const shadow = readShadow(currentOf('box-shadow'), values['box-shadow']);
  const blur = blurOf(currentOf('filter'));
  const backdrop = blurOf(currentOf('backdrop-filter'));
  const backgroundImage = currentOf('background-image').trim();
  const gradient = parseGradient(backgroundImage);
  /** + Gradient only where it replaces nothing: a gradient over an image would take the image away. */
  const imageless = backgroundImage === '' || backgroundImage === 'none';
  const has: Record<EffectKey, boolean> = { shadow: !!shadow, blur: blur > 0, backdrop: backdrop > 0, gradient: !!gradient };
  const onAddEffect = (key: EffectKey) => {
    if (key === 'shadow') set('box-shadow', NEW_SHADOW);
    if (key === 'blur') set('filter', withBlur(currentOf('filter'), 4));
    if (key === 'backdrop') set('backdrop-filter', withBlur(currentOf('backdrop-filter'), 12));
    if (key === 'gradient') {
      const [a, b] = tokens;
      set('background-image', gradientString({ angle: 135, from: a ? `var(${a.name})` : '#ffffff', to: b ? `var(${b.name})` : '#6b7280' }));
    }
  };
  /** − takes the element's own effect off, and cancels one the project's CSS applies by writing none. */
  const onRemoveEffect = (key: EffectKey) => {
    const property = EFFECTS[key];
    const blurry = key === 'blur' || key === 'backdrop';
    // A stylesheet's background with other layers than the gradient is uncovered rather than written
    // over with none, which would take its image away too.
    const showsEffect = (value: string | undefined) => !!value && (blurry ? blurOf(value) > 0 : key === 'gradient' ? isOneGradient(value) : value !== 'none');
    const cancel = (value: string | undefined) => (blurry ? withBlur(value, 0) ?? 'none' : 'none');
    const spec = state.specified[property];
    if (spec?.ours) {
      const under = spec.under?.value;
      set(property, showsEffect(under) ? cancel(under) : blurry ? withBlur(spec.value, 0) : null);
    } else {
      set(property, cancel(currentOf(property)));
    }
  };

  // ---------- Font ----------
  const fontTokens = props.fontTokens ?? [];
  const fontNow = asWritten('font-family');
  const fontOptions = [
    { value: '', label: ts('fontInherited') },
    ...fontTokens.map(token => ({ value: `var(${token.name})`, label: `${token.family} · ${token.name}` })),
  ];
  const fontValue = fontNow?.ours
    ? (fontOptions.find(option => option.value && option.value === fontNow.value.trim())?.value ?? null)
    : '';

  // ---------- Hide, Clear and Copy ----------
  const hidden = values.display === 'none';
  const onToggleHide = () => {
    if (!hidden) { set('display', 'none'); return; }
    const spec = state.specified.display;
    // Its own `none` comes off, unless that would only uncover another stylesheet's.
    set('display', spec?.ours && spec.under?.value !== 'none' ? null : 'revert-layer');
  };
  const scopeBag = state.overrides?.byScope.get(scope);
  const clearable = Object.keys(scopeBag ?? {}).length > 0 || state.committed.length > 0;
  const onClear = () => resetHere([...Object.keys(scopeBag ?? {}), ...state.committed]);
  const commandsRef = useRef({ toggleHide: onToggleHide, clear: onClear, scope });
  commandsRef.current = { toggleHide: onToggleHide, clear: onClear, scope };
  // After the render that has the element's values, so the command reads them.
  useEffect(runWaiting, [state, runWaiting]);
  const cssRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const onSweep = async () => {
    let removed: number | null | undefined;
    try {
      removed = await props.onSweepOverrides?.();
    } catch (error) {
      // Answered as a sweep that could not run: nothing to say.
      logger.error('Styles: removing unused overrides threw', error);
      return;
    }
    if (removed === null || removed === undefined) return;
    toast(removed > 0 ? ts('css.swept', { count: removed }) : ts('css.sweptNone'));
  };
  const onCopy = () => {
    const text = state.overrides?.text ?? '';
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // Refused: select the text so the shortcut copies it.
      const el = cssRef.current;
      if (!el) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
  };

  /**
   * The `Select element` button is on screen — see the empty state below.
   *
   * Tracked as a value so the effect under it can retract the hover the moment it stops being true.
   * A selection landing is exactly that moment, and it is the common one: the user hovers the
   * button, the picker they armed earlier resolves a click, and the button is gone from the tree
   * before any `mouseleave` reaches it.
   */
  const offersSelectButton = !selection && !!props.onSelectElement;

  /** Clears the hover hint on unmount, since unmount fires no mouseleave. */
  useEffect(() => {
    if (!offersSelectButton) return;
    return () => { propsRef.current.onSelectElementHover?.(false); };
  }, [offersSelectButton]);

  const variableHost: VariableHost | null = props.onApplyVariable
    ? { onApply: props.onApplyVariable, onPreview: props.onPreviewVariable }
    : null;
  const listsVariables = !!variableHost && (props.variables?.length ?? 0) > 0;

  if (!selection) {
    return (
      <div className={cn('h-full flex flex-col', listsVariables ? 'overflow-y-auto' : 'items-center justify-center')}>
      <div className={cn('flex flex-col items-center gap-2 px-6 text-center', listsVariables && 'shrink-0 border-b py-5')}>
        <p className="text-sm font-medium">{ts('noSelection')}</p>
        <p className="text-xs text-muted-foreground">
          {ts('noSelectionHint')}
        </p>
        {props.onSelectElement ? (
          <Tip label={props.focusToolArmed ? ts('cancelSelectionLong') : twx('selectElement')}>
          <Button
            variant={props.focusToolArmed ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => {
              // Clear the hover preview on the way out: the press moves the user's attention to the
              // preview, and a dashed outline left behind on it reads as an unfinished gesture.
              props.onSelectElementHover?.(false);
              props.onSelectElement?.();
            }}
            onMouseEnter={() => props.onSelectElementHover?.(true)}
            onMouseLeave={() => props.onSelectElementHover?.(false)}
            // The state, for assistive tech and for tests, on the button the app already puts it on
            // (`controls.tsx`, `InterviewTemplatesPanel`) rather than as a second data attribute.
            aria-pressed={!!props.focusToolArmed}
            // Both are worth changing. The label is what the user reads without hovering, and the
            // tooltip matches the header crosshair's wording word for word, since it is the same tool.
            data-osw-select-element
          >
            <Crosshair className="h-3 w-3" />
            {props.focusToolArmed ? ts('cancelSelection') : twx('selectElement')}
          </Button>
          </Tip>
        ) : null}
      </div>
      {/* With nothing selected, the tab is about the whole site: the variables its CSS defines. */}
      {listsVariables && variableHost ? (
        <div className="p-3">
          <ThemeVariables variables={props.variables ?? []} uses={props.variableUses ?? {}} {...variableHost} />
        </div>
      ) : null}
      </div>
    );
  }

  /** The definition a colour token names, where variables can be written here. */
  const tokenDefinition = (token: ColorToken): VariableDefinition | null => {
    if (!variableHost) return null;
    const defs = (props.variables ?? []).filter(def => def.name === token.name && def.file === token.file);
    return defs.find(def => def.root && def.context.length === 0) ?? defs[0] ?? null;
  };

  /**
   * The variable a row's value comes from: every name the row reads is set by one `var(--name)`,
   * the same one. A colour row is matched by its value too, as its swatches are.
   */
  const rowVariable = (entry: StyleProperty): VariableDefinition | null => {
    if (!variableHost || !props.variables?.length) return null;
    const names = entry.read.map(name => state.variables[name]);
    let name = names.length > 0 && names.every(n => n !== undefined && n === names[0]) ? names[0] : null;
    if (!name && entry.control === 'swatch') name = matchToken(readValue(entry, values), tokens)?.name ?? null;
    if (!name) return null;
    const defs = props.variables.filter(def => def.name === name);
    // The one that stands for the whole document unconditionally, else whichever comes first.
    return defs.find(def => def.root && def.context.length === 0) ?? defs[0] ?? null;
  };

  const bordered = (values['border-top-style'] ?? 'none') !== 'none' && (parsePx(values['border-top-width']) ?? 0) > 0;
  const replaced = /^(img|video)$/i.test(selection?.tagName ?? '');
  const shows = (entry: StyleProperty) =>
    entry.when === undefined
    || (entry.when === 'positioned' && (values.position ?? 'static') !== 'static')
    || (entry.when === 'flex' && isFlex)
    || (entry.when === 'grid' && isGrid)
    || (entry.when === 'bordered' && bordered)
    || (entry.when === 'replaced' && replaced);

  /** A select row's option in force, or `null` with the value it has instead. */
  const selected = (entry: SelectEntry): { value: string | null; current: string | null } => {
    if (entry.property === 'text-wrap') {
      const mode = values['text-wrap-mode'] ?? '';
      const style = values['text-wrap-style'] ?? '';
      return { value: mode === 'nowrap' ? 'nowrap' : style === 'balance' || style === 'pretty' ? style : 'wrap', current: null };
    }
    const raw = (requested[entry.property] ?? readValue(entry, values) ?? '').trim();
    const normal = raw.replace(/\s*\/\s*/g, ' / ');
    const hit = entry.options.find(option => option.value === normal || option.matches?.includes(normal));
    return { value: hit ? hit.value : null, current: raw || null };
  };

  /** One stepper whose number the panel works out itself: shadow lengths, a blur, an angle. */
  const fieldStepper = (key: string, label: string, n: number | null, unit: StyleUnit, onSet: (n: number) => void, opts: { step?: number; min?: number; dot?: React.ReactNode; isPart?: boolean } = {}) => {
    const step = opts.step ?? 1;
    const put = (next: number) => onSet(opts.min === undefined ? next : Math.max(opts.min, next));
    return (
      <Stepper
        key={key}
        label={label}
        value={n === null ? null : String(Number(n.toFixed(4)))}
        unit={unit}
        units={[unit]}
        disabled={disabled}
        isPart={opts.isPart}
        dot={opts.dot}
        onStep={direction => put((n ?? 0) + direction * step)}
        onValue={text => { const typed = parseNumber(text); if (typed && (typed.unit === '' || typed.unit === unit)) put(typed.n); }}
        onUnit={() => {}}
        onScrubStart={() => beginScrub({ n, unit })}
        onScrub={steps => { const start = scrubStart.current; if (start) put(start.n + steps * step); }}
        onScrubEnd={endScrub}
      />
    );
  };

  /**
   * The keyword a stepper row stands at: what this session asked for (for a side, or for the row it
   * is a side of), else what every side it shows declares. A margin of `auto` computes to pixels.
   */
  const stepperKeyword = (entry: StepperEntry): StyleKeyword | null => {
    if (!entry.keywords) return null;
    const parent = entry.id.includes(':') ? row<StepperEntry>(entry.id.slice(0, entry.id.indexOf(':'))) : null;
    const asked = requested[entry.property] ?? (parent ? requested[parent.property] : undefined);
    const declared = valueNames(entry).map(name => state.specified[name]?.value ?? null);
    const agreed = declared.length > 0 && declared.every(v => v !== null && v === declared[0]) ? declared[0] : null;
    return keywordOf(entry.keywords, [asked, agreed]);
  };

  /** The keyword a number row stands at: asked for, else declared (an undeclared offset is `auto`), else computed. */
  const numberKeyword = (entry: NumberEntry): StyleKeyword | null => {
    if (!entry.keywords) return null;
    const answered = entry.property in state.specified;
    const declared = answered ? state.specified[entry.property]?.value ?? (OFFSETS.has(entry.property) ? 'auto' : null) : null;
    return keywordOf(entry.keywords, [requested[entry.property], declared, values[entry.read[0]]]);
  };

  /** A table row: its control, its dot, and the bar that marks an override not in force. */
  const renderRow = (entry: StyleProperty, opts: { expandable?: boolean; expanded?: boolean; onToggleExpand?: () => void; isPart?: boolean; label?: string } = {}) => {
    if (!shows(entry)) return null;
    const label = opts.label ?? sp.label(entry);
    const loss = lossFor(state, entry.property);
    const own = dot(rowProperties(entry), label);
    let control: React.ReactNode = null;
    if (entry.control === 'stepper') {
      const keyword = stepperKeyword(entry);
      control = (
        <>
          <Stepper
            label={label}
            value={keyword ?? formatNumber(entry, values, unitContext, unitOf(entry))}
            unit={unitOf(entry)}
            units={entry.units}
            keywords={entry.keywords}
            keyword={keyword}
            onKeyword={value => set(entry.property, value)}
            mixed={!keyword && isMixed(entry, values)}
            disabled={disabled}
            atMin={atLadderEnd(entry, values, -1, unitContext)}
            atMax={atLadderEnd(entry, values, 1, unitContext)}
            onStep={direction => onStep(entry, direction)}
            onValue={text => onTypeValue(entry, text)}
            onUnit={unit => onUnit(entry, unit)}
            expandable={Boolean(entry.parts)}
            expanded={expanded.has(entry.id)}
            onToggleExpand={() => toggleExpanded(entry.id)}
            isPart={opts.isPart}
            dot={own}
            onScrubStart={() => {
              const shown = formatNumber(entry, values, unitContext, unitOf(entry));
              beginScrub({ n: shown === null ? null : Number.parseFloat(shown), unit: unitOf(entry) });
            }}
            onScrub={steps => onScrubStepper(entry, steps)}
            onScrubEnd={endScrub}
          />
          {/* Each side is a stepper in its own right, built from the parent by `partEntry`, so
              reading, stepping, converting and writing are the same code, on a longhand instead of
              the shorthand. */}
          {entry.parts && expanded.has(entry.id)
            ? entry.parts.map(part => <React.Fragment key={part.property}>{renderRow(partEntry(entry, part), { isPart: true })}</React.Fragment>)
            : null}
        </>
      );
    } else if (entry.control === 'number') {
      const shown = shownOf(entry);
      const keyword = numberKeyword(entry);
      control = (
        <Stepper
          label={label}
          value={keyword ?? (shown.n === null ? null : String(shown.n))}
          unit={shown.unit}
          units={entry.units}
          keywords={entry.keywords}
          keyword={keyword}
          onKeyword={value => set(entry.property, value)}
          disabled={disabled}
          atMin={entry.min !== undefined && shown.n !== null && shown.n <= entry.min}
          atMax={entry.max !== undefined && shown.n !== null && shown.n >= entry.max}
          onStep={direction => onNumberStep(entry, direction)}
          onValue={text => onNumberType(entry, text)}
          onUnit={unit => onNumberUnit(entry, unit)}
          expandable={opts.expandable}
          expanded={opts.expanded}
          onToggleExpand={opts.onToggleExpand}
          isPart={opts.isPart}
          dot={own}
          onScrubStart={() => beginScrub(baseOf(entry))}
          onScrub={steps => onScrubNumber(entry, steps)}
          onScrubEnd={endScrub}
        />
      );
    } else if (entry.control === 'segmented') {
      control = (
        <SegmentedControl
          label={label}
          options={entry.options.map(o => ({ ...o, label: sp.option(entry.property, o.value, o.label) }))}
          tips={sp.optionTips(entry.property)}
          active={activeOptionValue(entry, values)}
          disabled={disabled}
          onSelect={value => (entry.property === 'display' ? onDisplay(value) : onSelectOption(entry, value))}
          dot={own}
        />
      );
    } else if (entry.control === 'select') {
      const { value, current } = selected(entry);
      control = (
        <SelectRow
          label={label}
          options={entry.options.map(o => ({ ...o, label: sp.option(entry.property, o.value, o.label) }))}
          value={value}
          current={current}
          disabled={disabled}
          onSelect={next => onSelectOption(entry, next)}
          dot={own}
        />
      );
    } else if (entry.control === 'switch') {
      const raw = requested[entry.property] ?? readValue(entry, values) ?? values[entry.read[0]] ?? '';
      const on = entry.onMatches.includes(raw.trim());
      control = (
        <SwitchRow label={label} checked={on} disabled={disabled} onChange={next => set(entry.property, next ? entry.on : entry.off)} dot={own} />
      );
    } else {
      const swatch = entry as SwatchEntry;
      control = (
        <SwatchRow
          label={label}
          pickerValue={hexColor(readValue(swatch, values))}
          swatches={swatches}
          selected={selectedSwatch(readValue(swatch, values))}
          disabled={disabled}
          onSelect={value => onSwatch(swatch, value)}
          onReset={props.applyStyle && canReset(state, swatch.property) ? () => resetHere(rowProperties(swatch)) : undefined}
          dot={own}
        />
      );
    }
    return (
      <div
        key={entry.id}
        className={cn(loss && 'relative -ml-1.5 pl-1.5')}
        data-osw-loss={loss ? '' : undefined}
        data-osw-row={entry.id}
      >
        {/* A marker, not a message: the message is the one banner at the foot of the panel, and
            this is only what lets the user find the row it is talking about. Its tip is on the bar
            alone, so the row's controls keep their own. */}
        {loss && (
          <Tip label={ts('overrideNotInForce')} side="left">
            <span className="absolute inset-y-0 left-0 w-1.5">
              <span className="absolute inset-y-0 left-0 w-0.5 bg-destructive/70" />
            </span>
          </Tip>
        )}
        {control}
        {(() => {
          const def = opts.isPart ? null : rowVariable(entry);
          if (!def || !variableHost) return null;
          const context = variableContext(def);
          return (
            <Popover>
              <PopoverTrigger asChild>
                <Tip label={ts('variables.edit', { name: def.name })} align="end">
                  <button
                    type="button"
                    data-osw-row-variable={def.name}
                    className="-mt-0.5 mb-0.5 ml-auto block max-w-full truncate rounded px-1 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    {def.name}
                  </button>
                </Tip>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-3" data-osw-variable-popover>
                <div className="truncate font-mono text-xs">{def.name}</div>
                {context ? <div className="truncate text-[10px] text-muted-foreground">{context}</div> : null}
                <p className="mb-2 mt-1 text-[11px] text-muted-foreground">
                  {ts('variables.editHint', { name: def.name })}{' '}
                  {(props.variableUses?.[def.name] ?? 0) > 0 ? ts('variables.uses', { count: props.variableUses?.[def.name] ?? 0 }) : ts('variables.notUsed')}.
                </p>
                {/* Keyed: a row that comes to follow another variable gets a new field, and the
                    old one's waiting change is written to the variable it was made on. */}
                <VariableField key={variableKey(def)} def={def} host={variableHost} />
              </PopoverContent>
            </Popover>
          );
        })()}
      </div>
    );
  };

  /** A sub-group's heading with its − : a shadow, a blur, a gradient. */
  const effectHead = (key: EffectKey, label: string) => (
    <div className="flex items-center justify-between gap-2 pt-1" data-osw-effect={key}>
      <span className="flex items-center gap-1 min-w-0">
        {dot([EFFECTS[key]], label)}
        <span className="text-xs text-foreground truncate">{label}</span>
      </span>
      <Tip label={ts(REMOVE_LABEL[key])}>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 hover:text-destructive" aria-label={ts(REMOVE_LABEL[key])} disabled={disabled} onClick={() => onRemoveEffect(key)}>
          <Minus className="h-3 w-3" />
        </Button>
      </Tip>
    </div>
  );
  const addRow = (keys: EffectKey[]) => keys.length === 0 ? null : (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {keys.map(key => (
        <Button key={key} type="button" variant="outline" size="xs" className="h-6 text-xs" data-osw-add-effect={key} disabled={disabled} onClick={() => onAddEffect(key)}>
          <Plus className="h-3 w-3" />
          {ts(`effects.${key}`)}
        </Button>
      ))}
    </div>
  );
  const hint = (text: string) => <p className="text-[11px] text-muted-foreground leading-relaxed py-0.5">{text}</p>;

  const sizeHint = (): string => {
    const width = sizeFacts.width;
    if (widthNow === 'fill') return state.parent && state.parent.display.includes('flex') && state.parent.flexDirection.startsWith('row') ? ts('size.hintFillFlex') : ts('size.hintFill');
    if (widthNow === 'hug') return ts('size.hintHug');
    if (widthNow === 'fixed') return ts('size.hintFixed', { value: width?.value ?? '', file: width?.origin ?? '' });
    if (widthNow === 'custom') return ts('size.hintCustom', { value: width?.value ?? '', file: width?.origin ?? '' });
    return ts('size.hintAuto', { px: Math.round(parsePx(values.width) ?? 0) });
  };

  /** Each group's rows: the table's, with the compound ones in their places. */
  const renderGroup = (group: PropertyGroup): React.ReactNode => {
    const rows = ROWS.get(group) ?? [];
    switch (group) {
      case 'Size': {
        const maxOpen = expanded.has('max-size');
        return (
          <>
            <SegmentedControl
              label={ts('size.width')}
              options={(['auto', 'hug', 'fill', 'fixed'] as const).map(mode => ({ value: mode, label: ts(`size.${mode}`) }))}
              active={widthNow === 'custom' ? null : widthNow}
              disabled={disabled}
              onSelect={onWidthMode}
              dot={dot(['width', 'flex'], ts('size.width'))}
            />
            {widthNow === 'fixed' || widthNow === 'custom' ? renderRow(row('width')) : null}
            <SegmentedControl
              label={ts('size.height')}
              options={(['auto', 'fill', 'fixed'] as const).map(mode => ({ value: mode, label: ts(`size.${mode}`) }))}
              active={heightNow === 'custom' ? null : heightNow}
              disabled={disabled}
              onSelect={onHeightMode}
              dot={dot(['height'], ts('size.height'))}
            />
            {heightNow === 'fixed' || heightNow === 'custom' ? renderRow(row('height')) : null}
            {hint(sizeHint())}
            {renderRow(row('aspect-ratio'))}
            {renderRow(row('object-fit'))}
            {renderRow(row('max-width'), { expandable: true, expanded: maxOpen, onToggleExpand: () => toggleExpanded('max-size') })}
            {maxOpen ? ['min-width', 'max-height', 'min-height'].map(id => <React.Fragment key={id}>{renderRow(row(id), { isPart: true })}</React.Fragment>) : null}
          </>
        );
      }
      case 'Type': {
        const order = ['font-size', 'line-height', 'letter-spacing', 'text-align', 'font-weight', 'font-style', 'text-decoration-line', 'text-transform', 'text-wrap'];
        return (
          <>
            {fontTokens.length > 0 ? (
              <SelectRow
                label={ts('font')}
                options={fontOptions}
                value={fontValue}
                current={fontNow?.value ?? null}
                disabled={disabled}
                onSelect={value => set('font-family', value === '' ? null : value)}
                dot={dot(['font-family'], ts('font'))}
              />
            ) : null}
            {order.map(id => <React.Fragment key={id}>{renderRow(row(id))}</React.Fragment>)}
          </>
        );
      }
      case 'Colour':
        return (
          <>
            {rows.map(entry => renderRow(entry))}
            {gradient ? (
              <>
                {effectHead('gradient', ts('effects.gradient'))}
                {fieldStepper('gr-angle', ts('effects.angle'), gradient.angle, 'deg', n => set('background-image', gradientString({ ...gradient, angle: n })))}
                <SwatchRow label={ts('effects.from')} swatches={swatches} pickerValue={hexColor(gradient.from) ?? null} selected={selectedSwatch(gradient.from)} disabled={disabled} onSelect={value => set('background-image', gradientString({ ...gradient, from: swatchAction(row<SwatchEntry>('color'), value, values, tokens).declaration.value }))} />
                <SwatchRow label={ts('effects.to')} swatches={swatches} pickerValue={hexColor(gradient.to) ?? null} selected={selectedSwatch(gradient.to)} disabled={disabled} onSelect={value => set('background-image', gradientString({ ...gradient, to: swatchAction(row<SwatchEntry>('color'), value, values, tokens).declaration.value }))} />
              </>
            ) : imageless ? addRow(['gradient']) : null}
          </>
        );
      case 'Layout':
        return (
          <>
            {renderRow(row('display'))}
            {display !== '' && display !== 'none' ? (
              <div data-osw-row="inline">
                <SwitchRow label={ts('inline')} checked={display.startsWith('inline')} disabled={disabled} onChange={onInline} />
              </div>
            ) : null}
            {renderRow(row('flex-direction'))}
            {isFlex ? (
              <div className="flex items-start justify-between gap-3 py-1" data-osw-row="align">
                <span className="flex items-center gap-1 min-w-0">
                  {dot(['justify-content', 'align-items'], ts('align'))}
                  <span className="text-xs text-muted-foreground truncate">{ts('align')}</span>
                </span>
                <div className="flex items-start gap-3">
                  <AlignPad row={flexRow} justify={values['justify-content'] ?? null} align={values['align-items'] ?? null} between={between} stretch={stretch} disabled={disabled} onPick={onPad} />
                  <div className="flex flex-col gap-1">
                    <SwitchRow label={ts('spaceBetween')} checked={between} disabled={disabled} onChange={on => set('justify-content', on ? 'space-between' : 'flex-start')} />
                    <SwitchRow label={ts('stretch')} checked={stretch} disabled={disabled} onChange={on => set('align-items', on ? 'stretch' : 'flex-start')} />
                  </div>
                </div>
              </div>
            ) : null}
            {['flex-wrap', 'gap', 'grid-columns', 'column-gap', 'row-gap', 'overflow'].map(id => <React.Fragment key={id}>{renderRow(row(id))}</React.Fragment>)}
          </>
        );
      case 'Effects':
        return (
          <>
            {rows.map(entry => renderRow(entry))}
            {shadow ? (
              <>
                {effectHead('shadow', ts('effects.shadow'))}
                {fieldStepper('sh-x', 'X', shadow.x, 'px', n => set('box-shadow', shadowString({ ...shadow, x: n })))}
                {fieldStepper('sh-y', 'Y', shadow.y, 'px', n => set('box-shadow', shadowString({ ...shadow, y: n })))}
                {fieldStepper('sh-blur', ts('effects.blurRadius'), shadow.blur, 'px', n => set('box-shadow', shadowString({ ...shadow, blur: n })), { min: 0 })}
                {fieldStepper('sh-spread', ts('effects.spread'), shadow.spread, 'px', n => set('box-shadow', shadowString({ ...shadow, spread: n })))}
                <SwatchRow label={ts('effects.colour')} swatches={swatches} pickerValue={hexColor(shadow.color) ?? null} selected={selectedSwatch(shadow.color)} disabled={disabled} onSelect={value => set('box-shadow', shadowString({ ...shadow, color: swatchAction(row<SwatchEntry>('color'), value, values, tokens).declaration.value }))} />
              </>
            ) : null}
            {has.blur ? (
              <>
                {effectHead('blur', ts('effects.blur'))}
                {fieldStepper('blur', ts('effects.radius'), blur, 'px', n => set('filter', withBlur(currentOf('filter'), n)), { min: 0 })}
              </>
            ) : null}
            {has.backdrop ? (
              <>
                {effectHead('backdrop', ts('effects.backdrop'))}
                {fieldStepper('backdrop', ts('effects.radius'), backdrop, 'px', n => set('backdrop-filter', withBlur(currentOf('backdrop-filter'), n)), { min: 0 })}
              </>
            ) : null}
            {addRow((['shadow', 'blur', 'backdrop'] as const).filter(key => !has[key]))}
          </>
        );
      default:
        return <>{rows.filter(entry => !SIZE_FIELDS.includes(entry.id)).map(entry => renderRow(entry))}</>;
    }
  };

  const offer = state.refusal ? refusalOffer(state.refusal) : null;
  const lost = lostOverrides(state);

  const kind = contentSection(selection, { canEditText, canReplaceImage });
  const imageSrc = kind === 'image' ? (selection.attributes?.src ?? '') : '';
  const saveEnabled = textSaveEnabled(textState);
  // Bound out here so the button's handler closes over a narrowed value rather than re-asserting it.
  const textRefused = textState.refusal;

  const content = kind === null ? null : (
    // The section is at the **top**, above SPACING, because that is where a user goes looking for
    // "change what this says". A container gets no section at all rather than an empty heading.
    <div className="flex flex-col gap-1" data-osw-content-section={kind}>
      {/* Written as the other group headings are — `Spacing`, `Type` — and uppercased by the same
          class, so a restyle changes one rule rather than five labels and one outlier. */}
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{ts('contentHeading')}</span>

      {kind === 'image' ? (
        <div className="flex items-center gap-2">
          {/* A background rather than an <img>: the same object-fit result without the
              next/image lint rule, and a file that cannot be read degrades to an empty tile. */}
          <div
            data-osw-content-image={props.imageUrl ? 'shown' : 'unavailable'}
            className="size-12 shrink-0 rounded border bg-muted bg-contain bg-center bg-no-repeat"
            style={props.imageUrl ? { backgroundImage: `url("${props.imageUrl}")` } : undefined}
          />
          <Tip label={imageSrc || undefined} truncated>
            <span className="min-w-0 flex-1 truncate text-[11px] font-mono text-muted-foreground">
              {resolveImageSrc(imageSrc) ? imageSrc : 'no src'}
            </span>
          </Tip>
          <Button
            data-osw-content-replace
            size="sm"
            variant="outline"
            className="h-6 text-xs shrink-0"
            onClick={props.onReplaceImage}
          >
            {twx('replace')}
          </Button>
        </div>
      ) : null}

      {kind === 'text' ? (
        <>
          {textState.loading ? (
            <p className="text-xs text-muted-foreground py-1">{ts('reading')}</p>
          ) : null}

          {textRefused ? (
            <Alert
              // `generating` is the system being honest about what it cannot do yet, not a failure.
              tone={textRefused.reason === 'generating' ? 'quiet' : 'danger'}
              title={textRefusalTitle(textRefused, ttp)}
              actions={textRefusalOffersAgent(textRefused) ? (
                <Tip label={ts('tips.askAgent')}>
                  <Button
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => props.onAskAgent(textRefusalAgentPrompt(textRefused))}
                  >
                    {ts('askAgent')}
                  </Button>
                </Tip>
              ) : undefined}
            >
              {textRefusalMessage(textRefused, ttp)}
            </Alert>
          ) : null}

          {textState.pending ? (
            <Alert
              tone="amber"
              title={tt('usedMoreThanOnce')}
              actions={
                <>
                  <Button
                    data-osw-content-confirm
                    size="sm"
                    className="h-6 text-xs"
                    disabled={textState.busy}
                    onClick={() => dispatchText({ type: 'confirm' })}
                  >
                    {textState.pending.instances > 1
                      ? ts('changeAll', { count: textState.pending.instances })
                      : ts('changeIt')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs"
                    disabled={textState.busy}
                    onClick={() => dispatchText({ type: 'cancel' })}
                  >
                    {tc('actions.cancel')}
                  </Button>
                </>
              }
            >
              {textConfirmationMessage(textState.pending.instances, ttp, textState.pending.file)}
            </Alert>
          ) : null}

          {textState.original !== null ? (
            <>
              <Textarea
                data-osw-content-text
                rows={3}
                className="text-xs"
                value={textState.text}
                disabled={textState.busy}
                onChange={event => dispatchText({ type: 'edit', text: event.target.value })}
              />
              <div className="flex justify-end">
                <Button
                  data-osw-content-save
                  size="sm"
                  className="h-6 text-xs"
                  disabled={!saveEnabled}
                  onClick={() => dispatchText({ type: 'save' })}
                >
                  {tc('actions.save')}
                </Button>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      {summary ? (
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b text-[11px] font-mono shrink-0">
          <span className="size-1.5 rounded-sm bg-primary shrink-0" />
          <span className="font-semibold truncate">{summary.tag}</span>
          {summary.className ? <span className="text-sky-600 dark:text-sky-400 truncate">{summary.className}</span> : null}
          {summary.instances > 1 ? (
            <Tip label={ts('rendersTimes', { count: summary.instances })}>
              <span className="px-1 rounded-sm bg-amber-500/15 text-amber-700 dark:text-amber-400 font-semibold shrink-0">
                {ts('sharedInstances', { count: summary.instances })}
              </span>
            </Tip>
          ) : null}
          {state.viewportWidth !== null ? (
            <Tip label={ts('header.width')}>
              <span className="text-muted-foreground shrink-0">@{Math.round(state.viewportWidth)}</span>
            </Tip>
          ) : null}
          {state.markerId ? (
            <Tip label={ts('header.marker')}>
              <span className="text-muted-foreground truncate">{state.markerId}</span>
            </Tip>
          ) : null}
          {summary.source ? (
            <span className="ml-auto text-muted-foreground truncate shrink-0">{summary.source}</span>
          ) : null}
          <Tip label={hidden ? ts('header.show') : scope === 'all' ? ts('header.hideAll') : ts('header.hideUpTo', { width: scope })}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-osw-hide
              aria-label={hidden ? ts('header.showShort') : ts('header.hideShort')}
              aria-pressed={hidden}
              disabled={disabled}
              className={cn('h-5 w-5 shrink-0', !summary.source && 'ml-auto')}
              onClick={onToggleHide}
            >
              {hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            </Button>
          </Tip>
        </div>
      ) : null}

      <div className="flex-1 min-h-0 overflow-auto p-2 flex flex-col gap-3">
        {state.pending ? (
          <Alert
            tone="amber"
            title={state.pending.instances > 1 ? ts('changesAll', { count: state.pending.instances }) : ts('changesEveryInstance')}
            actions={
              <>
                <Button size="sm" className="h-6 text-xs" onClick={() => dispatch({ type: 'confirm' })}>
                  {state.pending.instances > 1 ? ts('changeAll', { count: state.pending.instances }) : ts('changeThemAll')}
                </Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={onCancelPending}>
                  {tc('actions.cancel')}
                </Button>
              </>
            }
          >
            {confirmationMessage(state.pending, ts)}
          </Alert>
        ) : null}

        {state.refusal ? (
          <Alert
            // Three of the five are the system being honest about what it cannot know, not failures.
            tone={generating || state.refusal.reason === 'ambiguous-stylesheet' ? 'quiet' : 'danger'}
            title={refusalTitle(state.refusal, ts)}
            actions={
              <>
                {offer ? (
                  <Tip label={offer.kind === 'ask-agent' ? ts('tips.askAgent') : undefined}>
                    <Button size="sm" className="h-6 text-xs" onClick={() => dispatch({ type: 'act-on-refusal' })}>
                      {offer.kind === 'ask-agent' ? ts('askAgent') : offer.kind === 'refresh' ? ts('offerRefresh') : ts('offerOpenFile', { path: offer.path })}
                    </Button>
                  </Tip>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-xs"
                  onClick={() => dispatch({ type: 'dismiss-refusal' })}
                >
                  {ts('dismiss')}
                </Button>
              </>
            }
          >
            {refusalMessage(state.refusal, ts)}
          </Alert>
        ) : null}

        {scopes.length > 1 ? (
          <div className="flex flex-col gap-0.5" data-osw-group="scope">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{ts('scope.heading')}</span>
            <SegmentedControl
              label={ts('scope.width')}
              options={scopes.map(option => ({ value: String(option), label: option === 'all' ? ts('scope.all') : ts('scope.upTo', { width: option }) }))}
              active={String(scope)}
              disabled={!selection}
              onSelect={onPickScope}
            />
            {hint(scope === 'all'
              ? ts('scope.hintAll', { width: Math.round(state.viewportWidth ?? 0), narrower: scopes.filter(option => option !== 'all').map(option => `≤ ${option}`).join(', ') })
              : (state.viewportWidth ?? 0) <= scope
                ? ts('scope.hintBlock', { width: Math.round(state.viewportWidth ?? 0), scope })
                : ts('scope.hintElsewhere', { width: Math.round(state.viewportWidth ?? 0), scope }))}
          </div>
        ) : null}

        {content}

        {PROPERTY_GROUPS.map(group => (
          <div key={group} className="flex flex-col gap-0.5 border-t border-border/50 pt-2 mt-1 first:mt-0" data-osw-group={group}>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{sp.group(group)}</span>
            {renderGroup(group)}
          </div>
        ))}

        <div className="flex flex-col gap-1 border-t border-border/50 pt-2 mt-1" data-osw-group="css">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{ts('css.heading')}</span>
            {state.overrides?.text ? (
              <Tip label={copied ? ts('css.copied') : ts('css.copy')}>
                <Button type="button" variant="ghost" size="icon" className="h-5 w-5" aria-label={ts('css.copy')} data-osw-copy-css onClick={onCopy}>
                  <Copy className="h-3 w-3" />
                </Button>
              </Tip>
            ) : null}
          </div>
          {state.overrides?.text ? (
            <>
              <pre ref={cssRef} data-osw-css className="rounded-md border bg-muted/40 p-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto">
                {state.overrides.text}
              </pre>
              <div className="flex justify-end gap-1.5 pt-1">
                <Button type="button" variant="outline" size="xs" className="h-6 text-xs" onClick={() => props.onOpenFile(OVERRIDES_PATH)}>
                  {ts('css.open')}
                </Button>
                <Button type="button" variant="outline" size="xs" className="h-6 text-xs" data-osw-clear-scope disabled={disabled || !clearable} onClick={onClear}>
                  {scope === 'all' ? ts('css.clearAll') : ts('css.clearUpTo', { width: scope })}
                </Button>
              </div>
              <div className="flex items-center justify-between gap-1.5 pt-1" data-osw-overrides-file>
                <span className="text-[10px] text-muted-foreground">{ts('css.wholeFile')}</span>
                <div className="flex gap-1.5">
                  {props.onSweepOverrides ? (
                    <Tip label={ts('css.sweepTip')}>
                      <Button type="button" variant="ghost" size="xs" className="h-6 text-xs" data-osw-sweep disabled={disabled} onClick={onSweep}>
                        {ts('css.sweep')}
                      </Button>
                    </Tip>
                  ) : null}
                  <Tip label={ts('css.foldInTip')}>
                    <Button type="button" variant="ghost" size="xs" className="h-6 text-xs" data-osw-fold-in onClick={() => props.onAskAgent(FOLD_IN_PROMPT)}>
                      {ts('css.foldIn')}
                    </Button>
                  </Tip>
                </div>
              </div>
            </>
          ) : hint(ts('css.none'))}
        </div>
      </div>

      {/* Single notification surface for post-write messages. */}
      {lost.length > 0 || tokenNote ? (
        <div className="shrink-0 border-t p-2 flex flex-col gap-2">
          {lost.length > 0 ? (
            <Alert
              tone="danger"
              title={ts('changesNotApplied', { count: lost.length })}
              actions={
                <>
                  {canMakeApply(state) ? (
                    <Tip label={ts('tips.makeApply')}>
                      <Button
                        data-osw-make-apply
                        size="sm"
                        className="h-6 text-xs"
                        onClick={() => dispatch({ type: 'make-apply' })}
                      >
                        {ts('makeApply')}
                      </Button>
                    </Tip>
                  ) : null}
                  <Tip label={ts('tips.askAgent')}>
                    <Button
                      size="sm"
                      variant={canMakeApply(state) ? 'outline' : undefined}
                      className="h-6 text-xs"
                      onClick={() => props.onAskAgent(lossAgentPrompt(lost, state.declarations))}
                    >
                      {ts('askAgent')}
                    </Button>
                  </Tip>
                </>
              }
            >
              {lossMessage(lost, ts)}
            </Alert>
          ) : null}

          {tokenNote ? (
            <Alert
              // Quiet: the change was applied and applied correctly. This is the panel volunteering
              // the reach of what it did, not reporting a problem.
              tone="quiet"
              title={ts('tokenNotChanged', { token: tokenNote.token.name })}
              actions={
                <>
                  <Tip label={tokenDefinition(tokenNote.token) ? ts('tips.changeVariable') : ts('tips.askAgent')}>
                    <Button
                      data-osw-token-note-agent
                      size="sm"
                      className="h-6 text-xs"
                      onClick={() => {
                        const note = tokenNote;
                        const target = tokenDefinition(note.token);
                        const write = props.onApplyVariable;
                        setTokenNote(null);
                        const ask = () => props.onAskAgent(tokenAgentPrompt(note.entry, note.token, note.next));
                        if (!write || !target) { ask(); return; }
                        // Written where the variable is declared, and this element's own colour for
                        // the property comes off at this width, so it follows the variable again:
                        // this element's, whatever is selected by the time the variable is written,
                        // and in the variable's undo step. A write that could not be made is handed
                        // to the agent.
                        const st = stateRef.current;
                        const site: WriteSite | null = st.selection && st.markerId
                          ? { selection: st.selection, markerId: st.markerId, group: newGroup() }
                          : null;
                        const properties = setHere(rowProperties(note.entry));
                        const removal = {
                          kind: 'apply' as const,
                          changes: properties.map(property => ({ property, value: null })),
                          scope: st.scope,
                          confirmedMultiInstance: st.confirmed,
                        };
                        void (async () => {
                          let ok = false;
                          try {
                            ok = (await write(target, note.next, site?.group)).ok;
                          } catch (error) {
                            logger.error('Styles: changing a token threw', error);
                          }
                          if (!ok) { ask(); return; }
                          if (!site || properties.length === 0) return;
                          if (isSameSelection(stateRef.current, site.selection)) {
                            setRequested(prev => {
                              const next = { ...prev };
                              for (const property of properties) delete next[property];
                              return next;
                            });
                          }
                          runApply(removal, site);
                        })();
                      }}
                    >
                      {ts('changeTokenInstead')}
                    </Button>
                  </Tip>
                  <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setTokenNote(null)}>
                    {ts('dismiss')}
                  </Button>
                </>
              }
            >
              {tokenSupersedeMessage(sp.label(tokenNote.entry), tokenNote.token, ts)}
            </Alert>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
