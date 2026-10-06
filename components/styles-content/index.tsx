'use client';

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useStylePropLabels } from '@/lib/i18n/use-style-prop-labels';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Crosshair } from 'lucide-react';
import { cn, logger } from '@/lib/utils';
import type { FocusContextPayload, PreviewHostMessage, PreviewMessage } from '@/lib/preview/types';
import type { ApplyResult } from '@/lib/direct-edit/types';
import type { TextReadResult } from '@/lib/direct-edit/apply-text';
import {
  textConfirmationMessage,
  textRefusalAgentPrompt,
  textRefusalMessage,
  textRefusalOffersAgent,
  textRefusalTitle,
} from '@/components/text-popover/state';
import {
  STYLE_PROPERTIES,
  type PropertyGroup,
  type SegmentedEntry,
  type StepperEntry,
  type StyleProperty,
  type StyleUnit,
  type SwatchEntry,
  partEntry,
} from './properties';
import {
  SegmentedControl,
  Stepper,
  SwatchRow,
  activeOptionValue,
  atLadderEnd,
  convertUnit,
  formatNumber,
  isMixed,
  readValue,
  stepValue,
  typedValue,
  type SwatchOption,
  type UnitContext,
} from './controls';
import {
  canReset,
  confirmationMessage,
  emptyStylesState,
  isSameSelection,
  lossAgentPrompt,
  lossFor,
  lossMessage,
  lostOverrides,
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
  overlayRequested,
  type ApplyStyle,
  type ReadOverrides,
  type RemoveStyle,
} from './commit';
import {
  hexColor,
  sameColor,
  swatchAction,
  tokenAgentPrompt,
  tokenSupersedeMessage,
  type ColorToken,
} from './tokens';
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

/** The groups, in table order, each with the entries that belong to it. */
function groupedProperties(): { group: PropertyGroup; entries: StyleProperty[] }[] {
  const groups: { group: PropertyGroup; entries: StyleProperty[] }[] = [];
  for (const entry of STYLE_PROPERTIES) {
    const last = groups.find(g => g.group === entry.group);
    if (last) last.entries.push(entry);
    else groups.push({ group: entry.group, entries: [entry] });
  }
  return groups;
}

const GROUPS = groupedProperties();

/** Neutral swatches for a project that declares no colour tokens of its own. */
const FALLBACK_SWATCHES = ['#000000', '#ffffff', '#6b7280'];

export interface StylesContentHandle {
  handleStyleComputed: (message: Extract<PreviewMessage, { type: 'style-computed' }>) => void;
  handleStyleProbeResult: (message: Extract<PreviewMessage, { type: 'style-probe-result' }>) => void;
  /** The frame loaded a document — the transient style died with the old one. */
  handleFrameReady: () => void;
}

export interface StylesContentProps {
  /** The element the controls act on. `null` renders the empty state. */
  selection: FocusContextPayload | null;
  /** Post into the preview frame. A no-op when no frame is mounted. */
  sendToFrame: (message: PreviewHostMessage) => void;
  /** The durable write. `null` disables every control — there is nothing to write to. */
  applyStyle: ApplyStyle | null;
  /**
   * The durable *un*-write, for Reset. Optional: a host that passes none gets no Reset control
   * rather than one that refuses.
   */
  removeStyle?: RemoveStyle | null;
  /**
   * Which properties `/overrides.css` already declares for a marker.
   *
   * What makes Reset survive a reload: without it the panel knows only its own session's writes, so
   * an override made yesterday has no control to remove it. Optional and injected for the same
   * reason the write path is — this component imports no VFS — and a host that omits it gets the
   * session-only behaviour rather than an error. Failures answer with an empty list; see
   * `readOverriddenProperties` in `lib/direct-edit/apply-style.ts`.
   */
  onReadOverrides?: ReadOverrides;
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

  const runApply = useCallback(async (command: Extract<StylesCommand, { kind: 'apply' }>) => {
    const applied = stateRef.current.selection;
    const apply = propsRef.current.applyStyle;
    let result: ApplyResult;
    if (!applied || !apply) {
      result = { ok: false, reason: 'unresolvable', filesWritten: [] };
    } else {
      try {
        result = await apply(applied, command.declaration, command.confirmedMultiInstance);
      } catch (error) {
        // Logged: unresolvable is a specific claim and a storage failure is not that.
        logger.error('Styles: applying a declaration threw', error);
        result = { ok: false, reason: 'unresolvable', filesWritten: [] };
      }
      // The user may have clicked elsewhere while the write was in flight. Folding this answer into
      // the new element's state would attribute one element's marker and history to another.
      if (!isSameSelection(stateRef.current, applied)) return;
    }
    if (!result.ok && result.reason !== 'needs-confirmation') {
      // Nothing was written, so the overlay is claiming a value the element does not have.
      setRequested(prev => {
        if (!(command.declaration.property in prev)) return prev;
        const next = { ...prev };
        delete next[command.declaration.property];
        return next;
      });
    }
    dispatchRef.current({ type: 'applied', declaration: command.declaration, result });
  }, []);

  const runRemove = useCallback(async (command: Extract<StylesCommand, { kind: 'remove' }>) => {
    const applied = stateRef.current.selection;
    const markerId = stateRef.current.markerId;
    const remove = propsRef.current.removeStyle;
    let result: ApplyResult;
    if (!applied || !markerId || !remove) {
      result = { ok: false, reason: 'unresolvable', filesWritten: [] };
    } else {
      try {
        result = await remove(applied, markerId, command.property, command.confirmedMultiInstance);
      } catch (error) {
        logger.error('Styles: removing a declaration threw', error);
        result = { ok: false, reason: 'unresolvable', filesWritten: [] };
      }
      // Same guard as `runApply`: the user may have selected something else while this was in
      // flight, and folding the answer in would credit one element's history to another.
      if (!isSameSelection(stateRef.current, applied)) return;
    }
    if (result.ok) {
      // The overlay was showing what the user last *asked* for on this property. The point of Reset
      // is to see what the stylesheet gives the element instead, so the request has to go with it.
      setRequested(prev => {
        if (!(command.property in prev)) return prev;
        const next = { ...prev };
        delete next[command.property];
        return next;
      });
    }
    dispatchRef.current({ type: 'removed', property: command.property, result });
  }, []);

  /** Reads overrides for the current element. Stale markers are discarded by the reducer. */
  const runReadOverrides = useCallback(async (
    command: Extract<StylesCommand, { kind: 'read-overrides' }>,
  ) => {
    const read = propsRef.current.onReadOverrides;
    if (!read) return;
    let properties: readonly string[];
    try {
      properties = await read(command.markerId);
    } catch {
      // The reader already answers `[]` for a missing file and an unparseable one; this is only the
      // host throwing. Nothing to reset is the safe reading of an answer that never arrived.
      properties = [];
    }
    dispatchRef.current({ type: 'overrides', markerId: command.markerId, properties });
  }, []);

  const runCommand = useCallback((command: StylesCommand) => {
    const host = propsRef.current;
    switch (command.kind) {
      case 'query':
        host.sendToFrame({ type: 'style-query', nodeId: command.nodeId, properties: command.properties });
        return;
      case 'preview':
        host.sendToFrame({ type: 'style-preview', markerId: command.markerId, css: command.css });
        return;
      case 'probe':
        host.sendToFrame({
          type: 'style-probe',
          nodeId: command.nodeId,
          markerId: command.markerId,
          properties: command.properties,
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
        void runApply(command);
        return;
      case 'remove':
        void runRemove(command);
        return;
      case 'read-overrides':
        void runReadOverrides(command);
        return;
    }
  }, [runApply, runRemove, runReadOverrides]);

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
    () => createCommitScheduler(COMMIT_DEBOUNCE_MS, declarations => {
      for (const declaration of declarations) dispatchRef.current({ type: 'change', declaration });
    }),
    [],
  );

  useEffect(() => () => scheduler.cancel(), [scheduler]);

  useImperativeHandle(ref, () => ({
    handleStyleComputed: (message) => {
      dispatch({
        type: 'computed',
        nodeId: message.nodeId,
        values: message.values,
        rootFontSize: message.rootFontSize,
      });
    },
    handleStyleProbeResult: (message) => {
      dispatch({ type: 'probed', nodeId: message.nodeId, lost: message.lost, winner: message.winner });
    },
    handleFrameReady: () => {
      setRequested({});
      dispatch({ type: 'frame-ready' });
    },
  }), [dispatch]);

  useEffect(() => {
    // Flush before updating selection so the write targets the outgoing element.
    scheduler.flush();
    setRequested({});
    setTokenNote(null);
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

  const summary = selection ? describeSelection(selection) : null;
  const generating = state.refusal?.reason === 'generating';
  // The token note is absent from this list on purpose: it reports something that already happened,
  // so leaving the controls live is the whole point of it being a note and not a refusal.
  const disabled = !selection
    || !props.applyStyle
    || generating
    || Boolean(state.pending);

  const request = useCallback((property: string, shown: string, written: string) => {
    setRequested(prev => ({ ...prev, [property]: shown }));
    scheduler.schedule({ property, value: written });
  }, [scheduler]);

  const onStep = useCallback((entry: StepperEntry, direction: 1 | -1) => {
    const next = stepValue(entry, values, direction, unitContext, unitOf(entry));
    // `null` means the rung cannot be expressed in the unit on screen because the frame has not said
    // what a rem is worth here yet. Writing nothing is the only answer that cannot move the element.
    if (next === null) return;
    request(entry.property, next, next);
  }, [values, request, unitContext, unitOf]);

  const onTypeValue = useCallback((entry: StepperEntry, text: string) => {
    const next = typedValue(text, unitOf(entry));
    // Refused rather than corrected: the field reverts to what the element is, which is a truthful
    // answer to `12px;color:red` in a way that writing some parse of it would not be.
    if (next === null) return;
    request(entry.property, next, next);
  }, [request, unitOf]);

  const onUnit = useCallback((entry: StepperEntry, unit: StyleUnit) => {
    setUnits(prev => ({ ...prev, [entry.id]: unit }));
    // The element keeps its size: the number is recomputed for the new unit and written. `null` —
    // an `auto`, a mixed pair of sides, a root size that has not arrived — changes the label only.
    const converted = convertUnit(entry, values, unit, unitContext);
    if (converted === null) return;
    request(entry.property, converted, converted);
  }, [values, request, unitContext]);

  const onSelectOption = useCallback((entry: SegmentedEntry, value: string) => {
    request(entry.property, value, value);
  }, [request]);

  const onSwatch = useCallback((entry: SwatchEntry, next: string) => {
    const action = swatchAction(entry, next, values, tokens);
    // Shown as the literal the user picked, written as `var(--token)` when that colour is one —
    // the swatch has to render, and `var(...)` is not a colour outside the document that defines it.
    request(entry.property, next, action.declaration.value);
    // Set *or cleared* on every press: a note left standing from an earlier press would attribute
    // this one to a token it had nothing to do with.
    setTokenNote(action.superseded ? { entry, token: action.superseded, next } : null);
  }, [values, tokens, request]);

  const onResetColor = useCallback((entry: SwatchEntry) => {
    // A note about a supersede that is being undone would be stranded the moment this lands.
    setTokenNote(null);
    dispatchRef.current({ type: 'reset', property: entry.property });
  }, []);

  /** Deduped by value, keeping the first name. */
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

  if (!selection) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm font-medium">{ts('noSelection')}</p>
        <p className="text-xs text-muted-foreground">
          {ts('noSelectionHint')}
        </p>
        {props.onSelectElement ? (
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
            // title matches the header crosshair's wording word for word, since it is the same tool.
            title={props.focusToolArmed ? ts('cancelSelectionLong') : twx('selectElement')}
            data-osw-select-element
          >
            <Crosshair className="h-3 w-3" />
            {props.focusToolArmed ? ts('cancelSelection') : twx('selectElement')}
          </Button>
        ) : null}
      </div>
    );
  }

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
          <span
            className="min-w-0 flex-1 truncate text-[11px] font-mono text-muted-foreground"
            title={imageSrc || undefined}
          >
            {resolveImageSrc(imageSrc) ? imageSrc : 'no src'}
          </span>
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
                <Button
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => props.onAskAgent(textRefusalAgentPrompt(textRefused))}
                >
                  {ts('askAgent')}
                </Button>
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
            <span
              className="px-1 rounded-sm bg-amber-500/15 text-amber-700 dark:text-amber-400 font-semibold shrink-0"
              title={ts('rendersTimes', { count: summary.instances })}
            >
              {ts('sharedInstances', { count: summary.instances })}
            </span>
          ) : null}
          {summary.source ? (
            <span className="ml-auto text-muted-foreground truncate shrink-0">{summary.source}</span>
          ) : null}
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
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => dispatch({ type: 'cancel' })}>
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
                  <Button size="sm" className="h-6 text-xs" onClick={() => dispatch({ type: 'act-on-refusal' })}>
                    {offer.kind === 'ask-agent' ? ts('askAgent') : offer.kind === 'refresh' ? ts('offerRefresh') : ts('offerOpenFile', { path: offer.path })}
                  </Button>
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

        {content}

        {GROUPS.map(({ group, entries }) => (
          <div key={group} className="flex flex-col gap-0.5 border-t border-border/50 pt-2 mt-1 first:mt-0">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{sp.group(group)}</span>
            {entries.map(entry => {
              const loss = lossFor(state, entry.property);
              return (
                <div
                  key={entry.id}
                  // A marker, not a message: the message is the one banner at the foot of the panel,
                  // and this is only what lets the user find the row it is talking about.
                  className={cn(loss && '-ml-1.5 pl-1 border-l-2 border-destructive/70')}
                  title={loss ? ts('overrideNotInForce') : undefined}
                >
                  {entry.control === 'stepper' ? (
                    <>
                      <Stepper
                        label={sp.label(entry)}
                        value={formatNumber(entry, values, unitContext, unitOf(entry))}
                        unit={unitOf(entry)}
                        units={entry.units}
                        mixed={isMixed(entry, values)}
                        disabled={disabled}
                        atMin={atLadderEnd(entry, values, -1, unitContext)}
                        atMax={atLadderEnd(entry, values, 1, unitContext)}
                        onStep={direction => onStep(entry, direction)}
                        onValue={text => onTypeValue(entry, text)}
                        onUnit={unit => onUnit(entry, unit)}
                        expandable={Boolean(entry.parts)}
                        expanded={expanded.has(entry.id)}
                        onToggleExpand={() => toggleExpanded(entry.id)}
                      />
                      {/* Each side is a stepper in its own right, built from the parent by
                          `partEntry` — so reading, stepping, converting and writing are the same
                          code, on a longhand instead of the shorthand. The computed value it needs
                          is already in `values`, because the parent asked the frame for every
                          longhand in order to know whether they agree. */}
                      {entry.parts && expanded.has(entry.id)
                        ? entry.parts.map(part => {
                          const sub = partEntry(entry, part);
                          return (
                            <Stepper
                              key={sub.id}
                              isPart
                              label={sp.label(sub)}
                              value={formatNumber(sub, values, unitContext, unitOf(sub))}
                              unit={unitOf(sub)}
                              units={sub.units}
                              mixed={isMixed(sub, values)}
                              disabled={disabled}
                              atMin={atLadderEnd(sub, values, -1, unitContext)}
                              atMax={atLadderEnd(sub, values, 1, unitContext)}
                              onStep={direction => onStep(sub, direction)}
                              onValue={text => onTypeValue(sub, text)}
                              onUnit={unit => onUnit(sub, unit)}
                            />
                          );
                        })
                        : null}
                    </>
                  ) : null}
                  {entry.control === 'segmented' ? (
                    <SegmentedControl
                      label={sp.label(entry)}
                      options={entry.options.map(o => ({ ...o, label: sp.option(entry.property, o.value, o.label) }))}
                      active={activeOptionValue(entry, values)}
                      disabled={disabled}
                      onSelect={value => onSelectOption(entry, value)}
                    />
                  ) : null}
                  {entry.control === 'swatch' ? (
                    <SwatchRow
                      label={sp.label(entry)}
                      pickerValue={hexColor(readValue(entry, values))}
                      swatches={swatches}
                      selected={selectedSwatch(readValue(entry, values))}
                      disabled={disabled}
                      onSelect={value => onSwatch(entry, value)}
                      onReset={props.removeStyle && canReset(state, entry.property)
                        ? () => onResetColor(entry)
                        : undefined}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Single notification surface for post-write messages. */}
      {lost.length > 0 || tokenNote ? (
        <div className="shrink-0 border-t p-2 flex flex-col gap-2">
          {lost.length > 0 ? (
            <Alert
              tone="danger"
              title={ts('changesNotApplied', { count: lost.length })}
              actions={
                <Button
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => props.onAskAgent(lossAgentPrompt(lost, state.declarations))}
                >
                  {ts('askAgent')}
                </Button>
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
                  <Button
                    data-osw-token-note-agent
                    size="sm"
                    className="h-6 text-xs"
                    onClick={() => {
                      props.onAskAgent(tokenAgentPrompt(tokenNote.entry, tokenNote.token, tokenNote.next));
                      setTokenNote(null);
                    }}
                  >
                    {ts('changeTokenInstead')}
                  </Button>
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
