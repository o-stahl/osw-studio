'use client';

import React, { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Minus, Pipette, Plus, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  UNIT_LABELS,
  stepLadder,
  valueNames,
  type SegmentedEntry,
  type SegmentedOption,
  type StepperEntry,
  type StyleKeyword,
  type StyleProperty,
  type StyleUnit,
} from './properties';

/**
 * Unit conversion maths, value stepping logic, and presentational controls
 * (Stepper, SegmentedControl, SwatchRow) for the Styles tab.
 */

/** Root font size from the frame, used for unit conversion. No fallback to 16: the frame reports the real value. */
export interface UnitContext {
  rootFontSize: number | null;
}

/** Nothing has been read back from the frame yet. The default for every function that takes one. */
export const unknownUnitContext: UnitContext = { rootFontSize: null };

/** Ladder rungs are exact halves and quarters; this only absorbs the noise of dividing by 16. */
const EPSILON = 1e-6;

/** A computed length: a number, optionally with `px`. Anything else — `%`, `auto`, `normal` — is not. */
const PX_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:px)?$/;

/** A typed value: a bare number, with no unit and no expression. */
const TYPED_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;

/**
 * A computed length in px, or `null` when the string is not one.
 *
 * `null` rather than `0` for `auto`, `normal`, `50%` and an empty reply, because a control that
 * showed `0` for `line-height: normal` would be inviting the user to step it down to something it
 * never was.
 */
export function parsePx(computed: string | undefined | null): number | null {
  if (typeof computed !== 'string') return null;
  const text = computed.trim();
  if (text === '' || !PX_RE.test(text)) return null;
  const n = Number.parseFloat(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * The one computed string this entry is showing, or `null`.
 *
 * `null` covers both "the frame has not answered / has no value" and "the sides disagree". They are
 * different states to a user and the same state to a control: there is no single number to show and
 * no option to light up. {@link isMixed} tells them apart for the label.
 */
export function readValue(entry: StyleProperty, values: Record<string, string>): string | null {
  const names = valueNames(entry);
  if (names.length === 0) return null;
  let agreed: string | null = null;
  for (const name of names) {
    const raw = values[name];
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const text = raw.trim();
    if (agreed === null) agreed = text;
    else if (agreed !== text) return null;
  }
  return agreed;
}

/** The sides all answered, and they do not agree — a padding of `1rem 2rem` read one side at a time. */
export function isMixed(entry: StyleProperty, values: Record<string, string>): boolean {
  const names = valueNames(entry);
  if (names.length < 2) return false;
  const seen = new Set<string>();
  for (const name of names) {
    const raw = values[name];
    if (typeof raw !== 'string' || raw.trim() === '') return false;
    seen.add(raw.trim());
  }
  return seen.size > 1;
}

/** Conversion factor: px per one unit of `unit`. `null` when the divisor is unknown or zero. */
export function pxPerUnit(
  entry: StyleProperty,
  values: Record<string, string>,
  ctx: UnitContext = unknownUnitContext,
  unit?: StyleUnit,
): number | null {
  // Only a stepper has a unit at all: a segmented control writes keywords and a swatch writes
  // colours, and neither is ever read back through a divisor.
  if (entry.control !== 'stepper') return 1;
  const target = unit ?? entry.unit;
  if (target === 'px') return 1;
  if (target === 'rem') {
    const root = ctx.rootFontSize;
    return root !== null && root > 0 ? root : null;
  }
  const divisor = entry.divisor ? parsePx(values[entry.divisor]) : null;
  return divisor !== null && divisor > 0 ? divisor : null;
}

/** The entry's computed value expressed in `unit`, or `null` when it cannot be read or converted. */
function toUnitNumber(
  entry: StyleProperty,
  values: Record<string, string>,
  ctx: UnitContext = unknownUnitContext,
  unit?: StyleUnit,
): number | null {
  const px = parsePx(readValue(entry, values));
  if (px === null) return null;
  const per = pxPerUnit(entry, values, ctx, unit);
  return per === null || per === 0 ? null : px / per;
}

/** The entry's computed value in **ladder** space — its own unit, whatever is being displayed. */
export function toLadderNumber(
  entry: StyleProperty,
  values: Record<string, string>,
  ctx: UnitContext = unknownUnitContext,
): number | null {
  return toUnitNumber(entry, values, ctx);
}

/** A number as the string that gets written: `1.5` + `rem` → `1.5rem`, `1.5` + `` → `1.5`. */
export function writeValue(n: number, unit: string): string {
  return `${Number(n.toFixed(4))}${unit}`;
}

/** Just the digits the value input shows, in `unit`. `null` when there is no single number. */
export function formatNumber(
  entry: StyleProperty,
  values: Record<string, string>,
  ctx: UnitContext = unknownUnitContext,
  unit?: StyleUnit,
): string | null {
  if (entry.control !== 'stepper') return readValue(entry, values);
  const n = toUnitNumber(entry, values, ctx, unit);
  return n === null ? null : writeValue(n, '');
}

/**
 * What the control displays, in the unit it writes.
 *
 * The frame answers in px whatever the source said, so a stepper displaying `rem` has to divide
 * before it can show a number the user will recognise. A keyword or colour entry has nothing to
 * convert and shows what came back.
 */
export function formatComputed(
  entry: StyleProperty,
  values: Record<string, string>,
  ctx: UnitContext = unknownUnitContext,
  unit?: StyleUnit,
): string | null {
  if (entry.control !== 'stepper') return readValue(entry, values);
  const n = toUnitNumber(entry, values, ctx, unit);
  return n === null ? null : writeValue(n, unit ?? entry.unit);
}

/** Converts the numeric value when the unit changes, preserving the element's rendered size. */
export function convertUnit(
  entry: StepperEntry,
  values: Record<string, string>,
  to: StyleUnit,
  ctx: UnitContext = unknownUnitContext,
): string | null {
  const px = parsePx(readValue(entry, values));
  if (px === null) return null;
  const per = pxPerUnit(entry, values, ctx, to);
  if (per === null || per === 0) return null;
  return writeValue(px / per, to);
}

/** Parses a bare number. Tolerates a trailing copy of the current unit; rejects other suffixes. */
export function typedValue(text: string, unit: StyleUnit): string | null {
  const trimmed = text.trim();
  const body = unit !== '' && trimmed.toLowerCase().endsWith(unit)
    ? trimmed.slice(0, -unit.length).trim()
    : trimmed;
  if (!TYPED_RE.test(body)) return null;
  const n = Number.parseFloat(body);
  return Number.isFinite(n) ? writeValue(n, unit) : null;
}

/** Exact match only. An unrecognised value lights up nothing. */
export function optionMatches(
  entry: SegmentedEntry,
  option: SegmentedOption,
  values: Record<string, string>,
): boolean {
  const raw = readValue(entry, values);
  if (raw === null) return false;
  const normalized = raw.toLowerCase();
  return normalized === option.value.toLowerCase()
    || (option.matches?.some(m => m.toLowerCase() === normalized) ?? false);
}

/** The single active option's value, or `null` when the computed value matches none of them. */
export function activeOptionValue(
  entry: SegmentedEntry,
  values: Record<string, string>,
): string | null {
  const matched = entry.options.filter(option => optionMatches(entry, option, values));
  return matched.length === 1 ? matched[0].value : null;
}

/** Steps to the next ladder rung in the requested direction. Off-ladder values snap to the nearest rung. */
export function stepValue(
  entry: StepperEntry,
  values: Record<string, string>,
  direction: 1 | -1,
  ctx: UnitContext = unknownUnitContext,
  unit?: StyleUnit,
): string | null {
  const target = unit ?? entry.unit;
  const rung = stepLadder(entry.ladder, toLadderNumber(entry, values, ctx), direction);
  if (target === entry.unit) return writeValue(rung, target);
  const perLadder = pxPerUnit(entry, values, ctx);
  const perTarget = pxPerUnit(entry, values, ctx, target);
  if (perLadder === null || perTarget === null || perTarget === 0) return null;
  return writeValue((rung * perLadder) / perTarget, target);
}

/** The ladder's bottom rung in `unit`, where a drag on the label stops. `null` when it cannot be converted. */
export function ladderFloor(
  entry: StepperEntry,
  values: Record<string, string>,
  ctx: UnitContext,
  unit: StyleUnit,
): number | null {
  const first = entry.ladder[0];
  if (unit === entry.unit || first === 0) return first;
  const perLadder = pxPerUnit(entry, values, ctx);
  const perTarget = pxPerUnit(entry, values, ctx, unit);
  if (perLadder === null || perTarget === null || perTarget === 0) return null;
  return (first * perLadder) / perTarget;
}

/** Is the value already at the end of the ladder in this direction? Disables the button. */
export function atLadderEnd(
  entry: StepperEntry,
  values: Record<string, string>,
  direction: 1 | -1,
  ctx: UnitContext = unknownUnitContext,
): boolean {
  const current = toLadderNumber(entry, values, ctx);
  if (current === null) return false;
  const end = direction === 1 ? entry.ladder[entry.ladder.length - 1] : entry.ladder[0];
  return Math.abs(current - end) < EPSILON;
}

const ROW = 'flex items-center justify-between gap-2 py-1';
const LABEL = 'text-xs text-muted-foreground truncate';
/** A label and the dot before it, side by side, shrinking before the control does. */
const LABEL_BOX = 'flex items-center gap-1 min-w-0';

/** Pixels of pointer travel per step when a label is dragged. */
export const SCRUB_PX = 2;

export interface SetDotProps {
  /** The row's label, for the button's name. */
  label: string;
  /** What its tooltip says: which width's block sets it, and that a press resets it. */
  tip: string;
  disabled?: boolean;
  /** Take the row's properties out of this width's block. */
  onReset: () => void;
}

/**
 * The dot before a row's label: this width's block in `/overrides.css` sets the row's property.
 * Pressing it removes those declarations, so the value falls back to the stylesheet's.
 */
export function SetDot({ label, tip, disabled, onReset }: SetDotProps) {
  const t = useTranslations('styles');
  return (
    <Tip label={tip} side="left">
      <button
        type="button"
        data-osw-set-dot
        aria-label={t('resetRow', { label })}
        disabled={disabled}
        onClick={onReset}
        className="h-4 w-3 shrink-0 flex items-center justify-center rounded-sm hover:bg-accent disabled:opacity-40 disabled:pointer-events-none"
      >
        <span className="size-1.5 rounded-full bg-primary" />
      </button>
    </Tip>
  );
}

/**
 * A press-and-drag on a label, as steps: `onStep(n)` with the steps from where the drag started
 * (Shift for tens), `onStart` once the pointer has moved, `onEnd` when it lets go or the browser
 * cancels the pointer. A drag swallows the click that would otherwise follow it.
 */
function useScrub(opts: { onStart?: () => void; onStep?: (steps: number) => void; onEnd?: () => void; disabled?: boolean }) {
  const ref = useRef(opts);
  ref.current = opts;
  const dragged = useRef(false);
  const onPointerDown = (event: React.PointerEvent) => {
    if (!ref.current.onStep || ref.current.disabled || event.button !== 0) return;
    const x0 = event.clientX;
    let moved = false;
    let last = 0;
    const move = (e: PointerEvent) => {
      const steps = Math.trunc((e.clientX - x0) / SCRUB_PX) * (e.shiftKey ? 10 : 1);
      if (!moved && steps === 0) return;
      if (!moved) { moved = true; ref.current.onStart?.(); }
      if (steps !== last) { last = steps; ref.current.onStep?.(steps); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!moved) return;
      dragged.current = true;
      setTimeout(() => { dragged.current = false; }, 0);
      ref.current.onEnd?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  return { onPointerDown, dragged };
}

const GROUP = 'flex items-center shrink-0 overflow-hidden rounded-[2rem] border bg-background';

/** `min-w-0` is load-bearing: without it flex items overflow and misalign. */
const SEGMENT = 'h-6 rounded-none border-l first:border-l-0 min-w-0 shrink-0';
const SEGMENT_BUTTON = `${SEGMENT} px-1.5`;
/** Marks a keyword among the unit menu's values, which are otherwise units (`''` is one). */
const KEYWORD_PREFIX = 'keyword:';

/** Fixed widths so columns align across rows. */
const VALUE_WIDTH = 'w-14';
/** Room for a keyword (`none`, `auto`) beside the chevron as well as a unit. */
const UNIT_WIDTH = 'w-[3.25rem]';

export interface StepperProps {
  label: string;
  /** The number only, in {@link unit} — the input's content. `null` when there is no single value. */
  value: string | null;
  /** The unit the control is writing in right now. */
  unit: StyleUnit;
  /** Every unit offered, in menu order. */
  units: readonly StyleUnit[];
  mixed?: boolean;
  disabled?: boolean;
  atMin?: boolean;
  atMax?: boolean;
  onStep: (direction: 1 | -1) => void;
  /**
   * A typed value, on Enter or on leaving the field. Raw text: what is writable is
   * {@link typedValue}'s decision, not the widget's, so an unusable entry is refused in one place.
   */
  onValue: (text: string) => void;
  onUnit: (unit: StyleUnit) => void;
  /** Keywords offered after the units (`auto`, `none`); picking one calls {@link onKeyword}. */
  keywords?: readonly StyleKeyword[];
  /** The keyword the value is now, shown in the unit menu; `null` when it is a number. */
  keyword?: StyleKeyword | null;
  onKeyword?: (keyword: StyleKeyword) => void;
  /** This value has sides or corners that can be opened up. See `StepperEntry.parts`. */
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** Rendered as one of those sides, rather than as the value itself. Indented, and never a toggle. */
  isPart?: boolean;
  /** The set dot, when this width's block sets the property. */
  dot?: React.ReactNode;
  /** Dragging the label: started, moved `steps` from the start, ended. Absent, the label does not drag. */
  onScrubStart?: () => void;
  onScrub?: (steps: number) => void;
  onScrubEnd?: () => void;
}

/** The value is a button until clicked, then an input. Prevents style-computed replies from overwriting mid-edit. */
export function Stepper({
  label,
  value,
  unit,
  units,
  mixed,
  disabled,
  atMin,
  atMax,
  onStep,
  onValue,
  onUnit,
  keywords,
  keyword,
  onKeyword,
  expandable,
  expanded,
  onToggleExpand,
  isPart,
  dot,
  onScrubStart,
  onScrub,
  onScrubEnd,
}: StepperProps) {
  const t = useTranslations('styles');
  const [draft, setDraft] = useState<string | null>(null);
  /** What the field opened on: left as that, it writes nothing. */
  const opened = useRef('');
  const scrub = useScrub({ onStart: onScrubStart, onStep: onScrub, onEnd: onScrubEnd, disabled });
  const scrubProps = onScrub && !disabled
    // `touch-action: none` so a touch drag scrubs rather than scrolling the panel.
    ? { onPointerDown: scrub.onPointerDown, 'data-osw-scrub': '', style: { cursor: 'ew-resize' as const, touchAction: 'none' as const } }
    : {};

  const open = () => {
    opened.current = value ?? '';
    setDraft(opened.current);
  };
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() === opened.current.trim()) return;
    onValue(draft);
  };

  return (
    <div className={ROW}>
      <span className={cn(LABEL_BOX, isPart && 'pl-4')}>
      {dot}
      {expandable ? (
        <Tip label={expanded ? t('tips.hideSides') : t('tips.showSides')} side="left">
          <button
            type="button"
            data-osw-stepper-expand
            aria-expanded={Boolean(expanded)}
            aria-label={t('sidesOf', { label })}
            onClick={() => { if (!scrub.dragged.current) onToggleExpand?.(); }}
            className={cn(LABEL, 'flex items-center gap-1 text-left hover:text-foreground cursor-pointer')}
            {...scrubProps}
          >
            <ChevronDown className={cn('size-3 shrink-0 transition-transform', !expanded && '-rotate-90')} />
            {label}
          </button>
        </Tip>
      ) : (
        <span className={cn(LABEL, 'select-none')} {...scrubProps}>{label}</span>
      )}
      </span>
      <div className={GROUP}>
        {/* No tooltip while a step is off: the span a disabled button needs would break the group's
            segment borders, and an end of the ladder needs no explaining. */}
        <Tip label={disabled || atMin ? undefined : t('decrease', { label })}>
          <Button
            type="button"
            // `ghost`, not `outline`: the wrapper draws the one border the group has, and an `outline`
            // button would bring a second one back — plus a `border-r-0` that `twMerge` then drops.
            variant="ghost"
            size="xs"
            aria-label={t('decrease', { label })}
            disabled={disabled || atMin}
            onClick={() => onStep(-1)}
            className={SEGMENT_BUTTON}
          >
            <Minus className="size-3" />
          </Button>
        </Tip>

        {draft === null ? (
          <Tip label={disabled ? undefined : t('tips.typeValue')}>
          <button
            type="button"
            data-osw-stepper-value
            aria-label={t('valueOf', { label })}
            disabled={disabled}
            // The value the field opens on is what is on screen, so clicking and typing over it
            // starts from what the element actually is rather than from an empty box.
            onClick={open}
            className={cn(
              VALUE_WIDTH,
              // Right-aligned, and `truncate` so a value with more to say than the box has room for
              // is clipped rather than allowed to widen the group.
              'bg-transparent text-xs tabular-nums text-right pr-1.5 truncate cursor-text',
              'hover:bg-accent disabled:opacity-50 disabled:pointer-events-none',
              SEGMENT,
            )}
          >
            {value ?? (mixed ? t('mixed') : '—')}
          </button>
          </Tip>
        ) : (
          <input
            type="text"
            inputMode="decimal"
            data-osw-stepper-input
            aria-label={t('valueOf', { label })}
            autoFocus
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); commit(); }
              // Escape abandons the draft. Committing on blur would otherwise write the half-typed
              // value the user just said they did not want.
              if (event.key === 'Escape') { event.preventDefault(); setDraft(null); }
            }}
            className={cn(
              VALUE_WIDTH,
              'bg-transparent text-xs tabular-nums text-right pr-1.5 outline-none',
              // An *inset* ring: the wrapper clips to its radius, so an ordinary ring — which paints
              // outside the element's border box — would be cut off at the top and bottom and would
              // paint over the neighbouring segments at the sides.
              'focus:inset-ring-1 focus:inset-ring-ring',
              SEGMENT,
            )}
          />
        )}

        {/* A native select: the app already uses one for the console's entry point and the
            workspaces view's role picker, it needs no portal, and its popup is the platform's. */}
        <Tip label={disabled ? undefined : t('unitOf', { label })}>
        <div className={cn('relative flex items-center', UNIT_WIDTH, SEGMENT)}>
          <select
            data-osw-stepper-unit
            aria-label={t('unitOf', { label })}
            disabled={disabled}
            value={keyword ? `${KEYWORD_PREFIX}${keyword}` : unit}
            onChange={(event) => {
              const picked = event.target.value;
              if (picked.startsWith(KEYWORD_PREFIX)) onKeyword?.(picked.slice(KEYWORD_PREFIX.length) as StyleKeyword);
              else onUnit(picked as StyleUnit);
            }}
            // `min-w-0` for the reason SEGMENT gives: a `<select>`'s intrinsic width is its widest
            // option, and `w-full` alone does not stop it claiming that much.
            className="appearance-none bg-transparent text-xs pl-1.5 pr-4 h-full w-full min-w-0 outline-none cursor-pointer disabled:opacity-50 disabled:pointer-events-none"
          >
            {units.map(option => (
              <option key={option || 'unitless'} value={option}>{UNIT_LABELS[option]}</option>
            ))}
            {keywords?.map(option => (
              <option key={option} value={`${KEYWORD_PREFIX}${option}`}>{option}</option>
            ))}
          </select>
          <ChevronDown className="size-3 absolute right-0.5 pointer-events-none opacity-60" />
        </div>
        </Tip>

        <Tip label={disabled || atMax ? undefined : t('increase', { label })}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={t('increase', { label })}
            disabled={disabled || atMax}
            onClick={() => onStep(1)}
            className={SEGMENT_BUTTON}
          >
            <Plus className="size-3" />
          </Button>
        </Tip>
      </div>
    </div>
  );
}

export interface SegmentedControlProps {
  label: string;
  options: readonly SegmentedOption[];
  /** The active option's value, or `null` — which renders every option inactive, deliberately. */
  active: string | null;
  disabled?: boolean;
  onSelect: (value: string) => void;
  /** The set dot, when this width's block sets the property. */
  dot?: React.ReactNode;
  /** A word per option for its tooltip, where the label alone is a symbol (`Aa`). */
  tips?: Readonly<Record<string, string>>;
}

export function SegmentedControl({ label, options, active, disabled, onSelect, dot, tips }: SegmentedControlProps) {
  return (
    <div className={ROW}>
      <span className={LABEL_BOX}>{dot}<span className={LABEL}>{label}</span></span>
      <div className="flex items-center rounded-md border overflow-hidden shrink-0">
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            aria-pressed={active === option.value}
            aria-label={tips?.[option.value]}
            title={tips?.[option.value]}
            disabled={disabled}
            onClick={() => onSelect(option.value)}
            className={cn(
              'px-2 h-6 text-xs border-l first:border-l-0 disabled:opacity-40 disabled:pointer-events-none',
              active === option.value
                ? 'bg-primary/15 text-primary'
                : 'bg-background hover:bg-accent',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * One colour the row offers.
 *
 * Carries the token's `name` because pressing a swatch writes `var(--name)`, not the literal, so the
 * name is what the press is actually about — and it is the only thing that tells two tokens apart
 * once they are both rendered as a coloured square. `null` for the fallback palette, which belongs
 * to no token.
 */
export interface SwatchOption {
  name: string | null;
  value: string;
}

export interface SwatchRowProps {
  label: string;
  /** Colours offered. The project's own tokens where it declares any. */
  swatches: readonly SwatchOption[];
  /** Decided by the caller to avoid an import cycle with tokens.ts. */
  selected?: string | null;
  /**
   * The hex the picker opens on — the computed colour, converted by the caller.
   *
   * Converted outside this file because the parser lives in `./tokens.ts`, which already imports
   * {@link readValue} from here. Absent falls back to black, which is what an `input[type=color]`
   * shows for an unreadable value anyway.
   */
  pickerValue?: string | null;
  disabled?: boolean;
  onSelect: (value: string) => void;
  /**
   * Remove this element's own override for the property, so the colour falls back to the
   * stylesheet's.
   *
   * Absent means there is nothing to remove — the panel offers no Reset rather than one that would
   * do nothing. See `canReset` in `./state.ts` for when that is known.
   */
  onReset?: () => void;
  /** The set dot, when this width's block sets the property. */
  dot?: React.ReactNode;
}

/** The browser's screen colour picker, where it has one (Chromium). */
interface EyeDropperApi { open(): Promise<{ sRGBHex: string }> }
const eyeDropper = (): (new () => EyeDropperApi) | null =>
  typeof window !== 'undefined' && 'EyeDropper' in window
    ? (window as unknown as { EyeDropper: new () => EyeDropperApi }).EyeDropper
    : null;

export function SwatchRow({
  label,
  swatches,
  selected,
  pickerValue,
  disabled,
  onSelect,
  onReset,
  dot,
}: SwatchRowProps) {
  const t = useTranslations('styles');
  const tc = useTranslations('common');
  const current = swatches.find(swatch => swatch.value === selected) ?? null;
  const Dropper = eyeDropper();

  return (
    <div className={ROW}>
      <span className={cn(LABEL_BOX, 'shrink-0')}>{dot}<span className={LABEL}>{label}</span></span>
      <Popover>
        <PopoverTrigger asChild>
          <Tip label={current?.name ? `${current.name} — ${current.value}` : (pickerValue ?? t('noSingleColour'))} align="end">
            <button
              type="button"
              data-osw-color-trigger
              aria-label={t('colourOf', { label })}
              disabled={disabled}
              className="h-6 shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 bg-background hover:bg-accent disabled:opacity-40 disabled:pointer-events-none"
            >
              <span
                className="size-4 rounded-full border"
                style={pickerValue ? { background: pickerValue } : undefined}
              />
              <ChevronDown className="size-3 text-muted-foreground" />
            </button>
          </Tip>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-64 p-3" data-osw-color-popover>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {t('projectColours')}
          </div>
          {/* Named, because pressing one writes `var(--name)` and the name is the thing that makes
              two identically-coloured squares tell themselves apart. */}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {swatches.map(swatch => (
              <Tip key={`${swatch.name ?? ''}:${swatch.value}`} label={swatch.name ? `${swatch.name} — ${swatch.value}` : swatch.value}>
                <button
                  type="button"
                  data-osw-swatch={swatch.value}
                  aria-label={swatch.name ?? swatch.value}
                  aria-pressed={selected === swatch.value}
                  disabled={disabled}
                  onClick={() => onSelect(swatch.value)}
                  className={cn(
                    'size-5 rounded border disabled:opacity-40 disabled:pointer-events-none',
                    selected === swatch.value && 'ring-2 ring-primary ring-offset-1',
                  )}
                  style={{ background: swatch.value }}
                />
              </Tip>
            ))}
          </div>
          {current?.name ? (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {t.rich('following', { name: current.name, token: (chunks) => <span className="font-mono">{chunks}</span> })}
            </p>
          ) : null}

          <div className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground">
            {tc('labels.custom')}
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <Tip label={disabled ? undefined : t('tips.pickColour')}>
            <input
              type="color"
              data-osw-color-picker
              aria-label={t('customColour', { label })}
              disabled={disabled}
              value={pickerValue ?? '#000000'}
              onChange={event => onSelect(event.target.value)}
              className="size-6 rounded border bg-transparent p-0 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
            />
            </Tip>
            <span className="font-mono text-[11px] text-muted-foreground">
              {pickerValue ?? '—'}
            </span>
            {Dropper ? (
              <Tip label={t('tips.eyedropper')}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-osw-eyedropper
                  aria-label={t('eyedropper')}
                  disabled={disabled}
                  className="ml-auto h-6 w-6"
                  onClick={() => {
                    // A cancelled pick rejects; that is the person changing their mind, not an error.
                    new Dropper().open().then(result => onSelect(result.sRGBHex)).catch(() => {});
                  }}
                >
                  <Pipette className="size-3" />
                </Button>
              </Tip>
            ) : null}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {t('pinsColour')}
          </p>

          {onReset ? (
            <div className="mt-3 flex justify-end border-t pt-2">
              <Tip label={t('tips.resetColour')}>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-osw-color-reset
                  aria-label={t('resetColour', { label })}
                  disabled={disabled}
                  onClick={onReset}
                >
                  <RotateCcw className="size-3" />
                  {t('reset')}
                </Button>
              </Tip>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

export interface SelectRowProps {
  label: string;
  options: readonly SegmentedOption[];
  /** The option in force, or `null` when the value is none of them (shown as itself). */
  value: string | null;
  /** What to show when `value` is null: the value as it is, so a select never claims another one. */
  current?: string | null;
  disabled?: boolean;
  onSelect: (value: string) => void;
  dot?: React.ReactNode;
}

/** A choice from a list, in the stepper's pill: a native select, as the unit picker is. */
export function SelectRow({ label, options, value, current, disabled, onSelect, dot }: SelectRowProps) {
  const unknown = value === null ? (current ?? '') : null;
  return (
    <div className={ROW}>
      <span className={LABEL_BOX}>{dot}<span className={LABEL}>{label}</span></span>
      <div className="relative flex items-center h-6 w-40 rounded-[2rem] border bg-background min-w-0 shrink-0">
        <select
          data-osw-select
          aria-label={label}
          disabled={disabled}
          value={value ?? `__current:${unknown}`}
          onChange={event => onSelect(event.target.value)}
          className="appearance-none bg-transparent text-xs pl-2 pr-6 h-full w-full min-w-0 outline-none cursor-pointer disabled:opacity-50 disabled:pointer-events-none"
        >
          {value === null ? <option value={`__current:${unknown}`} disabled>{unknown || '—'}</option> : null}
          {options.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <ChevronDown className="size-3 absolute right-2 pointer-events-none text-muted-foreground" />
      </div>
    </div>
  );
}

export interface SwitchRowProps {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  dot?: React.ReactNode;
}

/** A property with two values, as the studio's Switch. */
export function SwitchRow({ label, checked, disabled, onChange, dot }: SwitchRowProps) {
  return (
    <div className={ROW}>
      <span className={LABEL_BOX}>{dot}<span className={LABEL}>{label}</span></span>
      <Switch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

/** `flex-start`, `center`, `flex-end`: the three places on each axis the pad offers. */
const PAD_PLACES = ['flex-start', 'center', 'flex-end'] as const;

/** A computed alignment as one of the pad's places, or `null` for anything else. */
function padPlace(value: string | null | undefined): (typeof PAD_PLACES)[number] | null {
  const v = (value ?? '').trim();
  if (v === 'normal' || v === 'start' || v === 'left' || v === 'flex-start' || v === 'self-start') return 'flex-start';
  if (v === 'end' || v === 'right' || v === 'flex-end' || v === 'self-end') return 'flex-end';
  if (v === 'center') return 'center';
  return null;
}

export interface AlignPadProps {
  /** The main axis runs across (a row) rather than down. */
  row: boolean;
  justify: string | null;
  align: string | null;
  /** `justify-content: space-between` is on: every column of the main axis lights. */
  between: boolean;
  /** `align-items: stretch` is on: nothing lights on the cross axis. */
  stretch: boolean;
  disabled?: boolean;
  /** A cell: where on the main axis and on the cross axis. */
  onPick: (main: (typeof PAD_PLACES)[number], cross: (typeof PAD_PLACES)[number]) => void;
}

/** Nine positions for a flex container's children: main axis across, cross axis down (swapped for a column). */
export function AlignPad({ row, justify, align, between, stretch, disabled, onPick }: AlignPadProps) {
  const t = useTranslations('styles');
  const main = padPlace(justify);
  const cross = padPlace(align);
  const cells = [];
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) {
      const m = PAD_PLACES[row ? x : y];
      const c = PAD_PLACES[row ? y : x];
      const on = (between || m === main) && !stretch && c === cross;
      cells.push(
        <button
          key={`${x},${y}`}
          type="button"
          data-osw-pad={`${x},${y}`}
          aria-pressed={on}
          aria-label={t('padCell', { justify: m, align: c })}
          title={`justify-content: ${m} · align-items: ${c}`}
          disabled={disabled}
          onClick={() => onPick(m, c)}
          className={cn('h-5 w-5 rounded-sm flex items-center justify-center disabled:opacity-40', on ? 'bg-primary/15' : 'hover:bg-accent')}
        >
          <span className={cn('block rounded-full', on ? cn(row ? 'h-1.5 w-3' : 'h-3 w-1.5', 'bg-primary') : 'size-1.5 bg-muted-foreground/40')} />
        </button>,
      );
    }
  }
  return (
    <div role="group" aria-label={t('alignment')} className="grid grid-cols-3 gap-0.5 rounded-md border bg-background p-0.5 shrink-0">
      {cells}
    </div>
  );
}
