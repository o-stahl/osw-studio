'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Minus, Plus, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  UNIT_LABELS,
  stepLadder,
  valueNames,
  type SegmentedEntry,
  type SegmentedOption,
  type StepperEntry,
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
  if (entry.control === 'swatch' || entry.kind === 'keyword') return readValue(entry, values);
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

/** What a control shows when the frame has no single value for it. */
function placeholder(mixed: boolean, mixedLabel: string): string {
  return mixed ? mixedLabel : '—';
}

const GROUP = 'flex items-center shrink-0 overflow-hidden rounded-[2rem] border bg-background';

/** `min-w-0` is load-bearing: without it flex items overflow and misalign. */
const SEGMENT = 'h-6 rounded-none border-l first:border-l-0 min-w-0 shrink-0';
const SEGMENT_BUTTON = `${SEGMENT} px-1.5`;
/** Fixed widths so columns align across rows. */
const VALUE_WIDTH = 'w-14';
const UNIT_WIDTH = 'w-12';

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
  /** This value has sides or corners that can be opened up. See `StepperEntry.parts`. */
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** Rendered as one of those sides, rather than as the value itself. Indented, and never a toggle. */
  isPart?: boolean;
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
  expandable,
  expanded,
  onToggleExpand,
  isPart,
}: StepperProps) {
  const t = useTranslations('styles');
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    onValue(draft);
  };

  return (
    <div className={ROW}>
      {expandable ? (
        <button
          type="button"
          data-osw-stepper-expand
          aria-expanded={Boolean(expanded)}
          aria-label={`${label} sides`}
          onClick={onToggleExpand}
          className={cn(LABEL, 'flex items-center gap-1 text-left hover:text-foreground cursor-pointer')}
        >
          <ChevronDown className={cn('size-3 shrink-0 transition-transform', !expanded && '-rotate-90')} />
          {label}
        </button>
      ) : (
        <span className={cn(LABEL, isPart && 'pl-4')}>{label}</span>
      )}
      <div className={GROUP}>
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

        {draft === null ? (
          <button
            type="button"
            data-osw-stepper-value
            aria-label={`${label} value`}
            disabled={disabled}
            // The value the field opens on is what is on screen, so clicking and typing over it
            // starts from what the element actually is rather than from an empty box.
            onClick={() => setDraft(value ?? '')}
            className={cn(
              VALUE_WIDTH,
              // Right-aligned, and `truncate` so a value with more to say than the box has room for
              // is clipped rather than allowed to widen the group.
              'bg-transparent text-xs tabular-nums text-right pr-1.5 truncate cursor-text',
              'hover:bg-accent disabled:opacity-50 disabled:pointer-events-none',
              SEGMENT,
            )}
          >
            {value ?? placeholder(Boolean(mixed), t('mixed'))}
          </button>
        ) : (
          <input
            type="text"
            inputMode="decimal"
            data-osw-stepper-input
            aria-label={`${label} value`}
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
        <div className={cn('relative flex items-center', UNIT_WIDTH, SEGMENT)}>
          <select
            data-osw-stepper-unit
            aria-label={`${label} unit`}
            disabled={disabled}
            value={unit}
            onChange={event => onUnit(event.target.value as StyleUnit)}
            // `min-w-0` for the reason SEGMENT gives: a `<select>`'s intrinsic width is its widest
            // option, and `w-full` alone does not stop it claiming that much.
            className="appearance-none bg-transparent text-xs pl-1.5 pr-4 h-full w-full min-w-0 outline-none cursor-pointer disabled:opacity-50 disabled:pointer-events-none"
          >
            {units.map(option => (
              <option key={option || 'unitless'} value={option}>{UNIT_LABELS[option]}</option>
            ))}
          </select>
          <ChevronDown className="size-3 absolute right-0.5 pointer-events-none opacity-60" />
        </div>

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
}

export function SegmentedControl({ label, options, active, disabled, onSelect }: SegmentedControlProps) {
  return (
    <div className={ROW}>
      <span className={LABEL}>{label}</span>
      <div className="flex items-center rounded-md border overflow-hidden shrink-0">
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            aria-pressed={active === option.value}
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
}

export function SwatchRow({
  label,
  swatches,
  selected,
  pickerValue,
  disabled,
  onSelect,
  onReset,
}: SwatchRowProps) {
  const t = useTranslations('styles');
  const tc = useTranslations('common');
  const current = swatches.find(swatch => swatch.value === selected) ?? null;

  return (
    <div className={ROW}>
      <span className={cn(LABEL, 'shrink-0')}>{label}</span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-osw-color-trigger
            aria-label={t('colourOf', { label })}
            title={current?.name ? `${current.name} — ${current.value}` : (pickerValue ?? t('noSingleColour'))}
            disabled={disabled}
            className="h-6 shrink-0 inline-flex items-center gap-1 rounded-full border px-1.5 bg-background hover:bg-accent disabled:opacity-40 disabled:pointer-events-none"
          >
            <span
              className="size-4 rounded-full border"
              style={pickerValue ? { background: pickerValue } : undefined}
            />
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>

        <PopoverContent align="end" className="w-64 p-3" data-osw-color-popover>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {t('projectColours')}
          </div>
          {/* Named, because pressing one writes `var(--name)` and the name is the thing that makes
              two identically-coloured squares tell themselves apart. */}
          <div className="mt-1.5 flex flex-wrap gap-1">
            {swatches.map(swatch => (
              <button
                key={`${swatch.name ?? ''}:${swatch.value}`}
                type="button"
                aria-label={swatch.name ?? swatch.value}
                aria-pressed={selected === swatch.value}
                title={swatch.name ? `${swatch.name} — ${swatch.value}` : swatch.value}
                disabled={disabled}
                onClick={() => onSelect(swatch.value)}
                className={cn(
                  'size-5 rounded border disabled:opacity-40 disabled:pointer-events-none',
                  selected === swatch.value && 'ring-2 ring-primary ring-offset-1',
                )}
                style={{ background: swatch.value }}
              />
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
            <input
              type="color"
              data-osw-color-picker
              aria-label={t('customColour', { label })}
              disabled={disabled}
              value={pickerValue ?? '#000000'}
              onChange={event => onSelect(event.target.value)}
              className="size-6 rounded border bg-transparent p-0 cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
            />
            <span className="font-mono text-[11px] text-muted-foreground">
              {pickerValue ?? '—'}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            {t('pinsColour')}
          </p>

          {onReset ? (
            <div className="mt-3 flex justify-end border-t pt-2">
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
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
