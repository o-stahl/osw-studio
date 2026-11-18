'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { cn, logger } from '@/lib/utils';
import type { VariableDefinition, VariableKind } from '@/lib/direct-edit/css-variables';
import type { VariableWrite } from '@/lib/direct-edit/apply-variable';
import { hexColor } from './tokens';

/**
 * The project's custom properties in the Styles tab: listed when nothing is selected, and behind a
 * row's variable name when something is. A change goes into the stylesheet that declares the
 * variable, so everything that uses it follows.
 *
 * The list is whatever the CSS defines (`scanProjectVariables`): no manifest, no naming convention.
 */

/** Wait this long after the last change before writing: a colour dragged through a hundred values is one write. */
export const VARIABLE_COMMIT_MS = 350;

export interface VariableHost {
  /** Writes the value into the definition's stylesheet. */
  onApply: (def: VariableDefinition, value: string) => Promise<VariableWrite>;
  /** Shows a value on the pages before it is written; `null` takes that back. */
  onPreview?: (name: string, value: string | null) => void;
}

/** A definition's own key: a name can be defined in several rules and files. */
export const variableKey = (def: VariableDefinition) => `${def.file}|${def.context.join('|')}|${def.selector}|${def.name}`;

/** Whether a change can be shown before it is written: only where it stands for the whole document, unconditionally. */
const previews = (def: VariableDefinition) => def.root && def.context.length === 0;

/** Where a definition stands, when that is anything but a plain `:root`. */
export function variableContext(def: VariableDefinition): string | null {
  if (def.context.length === 0 && /^(?::root|html)$/i.test(def.selector)) return null;
  return [...def.context, def.selector].join(' ');
}

/**
 * A colour as `#rrggbb` for the browser's picker: parsed where the notation is a simple one, else
 * painted on a canvas and read back, which takes whatever the browser can paint (`oklch()`). Null
 * for one it cannot, such as a colour built from other variables.
 */
export function pickerHex(value: string): string | null {
  const parsed = hexColor(value);
  if (parsed) return parsed;
  if (typeof document === 'undefined' || /var\(/.test(value)) return null;
  try {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    // An unparseable colour leaves the fill as it was: two different starting fills tell that apart.
    ctx.fillStyle = '#010203';
    ctx.fillStyle = value;
    const first = ctx.fillStyle;
    ctx.fillStyle = '#030201';
    ctx.fillStyle = value;
    if (first !== ctx.fillStyle) return null;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

const NUMBER = /^([+-]?(?:\d+\.?\d*|\.\d+))([a-z%]*)$/i;

/** One step of a length, in its own unit: whole pixels and percents, eighths of a rem. */
export function stepLength(value: string, direction: 1 | -1): string | null {
  const m = NUMBER.exec(value.trim());
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const step = unit === 'rem' || unit === 'em' ? 0.125 : unit === 'ms' ? 10 : unit === '' || unit === 's' ? 0.1 : 1;
  const next = Math.round((Number(m[1]) + direction * step) * 1000) / 1000;
  return `${next}${m[2]}`;
}

const FIELD = 'h-6 min-w-0 rounded border bg-background px-1.5 font-mono text-[11px] outline-none focus:border-ring';

/** One definition's value, as a control that fits what the value is. */
export function VariableField({ def, host }: { def: VariableDefinition; host: VariableHost }) {
  const t = useTranslations('styles.variables');
  /** What the user has set and the file does not say yet. */
  const [draft, setDraft] = useState<string | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  /** Why the last write did not happen: the host's reason, or `failed` when the write threw. */
  const [failed, setFailed] = useState<VariableWrite['reason'] | 'failed' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The value the timer is waiting to write. */
  const pending = useRef<string | null>(null);
  const hostRef = useRef(host);
  hostRef.current = host;
  const defRef = useRef(def);
  defRef.current = def;

  // The file caught up with the draft, or changed under it with nothing waiting: the file is what shows.
  useEffect(() => {
    if (timer.current === null) setDraft(null);
  }, [def.value]);

  /** Writes the waiting value now, if there is one. */
  const write = useCallback(() => {
    const value = pending.current;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
    if (value === null) return;
    const target = defRef.current;
    void (async () => {
      let failure: VariableWrite['reason'] | 'failed';
      try {
        const result = await hostRef.current.onApply(target, value);
        if (result.ok) return;
        failure = result.reason ?? 'gone';
      } catch (error) {
        logger.error('Styles: writing a variable threw', error);
        failure = 'failed';
      }
      // Nothing was written: the pages go back to what the file says, and so does the field.
      if (previews(target)) hostRef.current.onPreview?.(target.name, null);
      setDraft(null);
      setFailed(failure);
    })();
  }, []);

  const change = useCallback((next: string) => {
    const value = next.trim();
    if (value === '') return;
    setDraft(value);
    setFailed(null);
    if (previews(defRef.current)) hostRef.current.onPreview?.(defRef.current.name, value);
    pending.current = value;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(write, VARIABLE_COMMIT_MS);
  }, [write]);

  const shown = draft ?? def.value;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  /** `typing`, where the cleanup below can read it. */
  const typingRef = useRef<string | null>(null);
  const edit = useCallback((text: string | null) => {
    typingRef.current = text;
    setTyping(text);
  }, []);

  // The field goes away (a selection replaces the list, the popover closes) with text typed and not
  // yet left, or with the pages already showing a change that is still waiting: both are written,
  // as leaving the field would write them, rather than lost or left on the pages alone.
  useEffect(() => () => {
    const typed = typingRef.current;
    if (typed !== null && typed.trim() !== shownRef.current) change(typed);
    write();
  }, [change, write]);

  // The popover hears Escape on the document and closes, which can take the field away before the
  // key reaches its own handler. The window hears the key first, so text Escape drops is never
  // written by the cleanup above.
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = typing !== null;
  useEffect(() => {
    if (!editing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && event.target === inputRef.current) typingRef.current = null;
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [editing]);

  const text = (
    <input
      ref={inputRef}
      type="text"
      data-osw-variable-value
      aria-label={t('valueOf', { name: def.name })}
      spellCheck={false}
      value={typing ?? shown}
      onChange={event => edit(event.target.value)}
      onBlur={() => { if (typing !== null && typing.trim() !== shown) change(typing); edit(null); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') { (event.target as HTMLInputElement).blur(); }
        // Escape abandons what was typed. Leaving the field from here would run the blur handler of
        // the render that still holds the text, and write it.
        if (event.key === 'Escape') { event.preventDefault(); edit(null); }
      }}
      className={cn(FIELD, 'flex-1')}
    />
  );

  let control: React.ReactNode = text;
  if (def.kind === 'color') {
    const hex = pickerHex(shown);
    // A colour worked out from other variables has no colour of its own to open a picker on: it is
    // edited as the expression it is.
    control = hex === null ? text : (
      <>
        <Tip label={t('pick', { name: def.name })}>
          <input
            type="color"
            data-osw-variable-colour
            aria-label={t('pick', { name: def.name })}
            value={hex}
            onChange={event => change(event.target.value)}
            className="size-6 shrink-0 cursor-pointer rounded border bg-transparent p-0"
          />
        </Tip>
        {text}
      </>
    );
  } else if (def.kind === 'length') {
    const step = (direction: 1 | -1) => { const next = stepLength(shown, direction); if (next !== null) change(next); };
    control = (
      <>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" aria-label={t('decrease', { name: def.name })} onClick={() => step(-1)}>
          <Minus className="size-3" />
        </Button>
        {text}
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6 shrink-0" aria-label={t('increase', { name: def.name })} onClick={() => step(1)}>
          <Plus className="size-3" />
        </Button>
      </>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1">{control}</div>
      {failed ? <p data-osw-variable-failed className="text-[11px] text-destructive">{t(`reason.${failed}`, { file: def.file })}</p> : null}
    </div>
  );
}

const KINDS: readonly VariableKind[] = ['color', 'length', 'font', 'shadow', 'other'];

export interface ThemeVariablesProps extends VariableHost {
  variables: readonly VariableDefinition[];
  /** How many times the CSS reads each variable, by name. */
  uses: Readonly<Record<string, number>>;
}

/** Every variable the project's CSS defines, grouped by what its value is. */
export function ThemeVariables({ variables, uses, ...host }: ThemeVariablesProps) {
  const t = useTranslations('styles.variables');
  if (variables.length === 0) return null;
  return (
    <div data-osw-variables className="flex flex-col gap-3 text-left">
      <div>
        <p className="text-xs font-medium">{t('title')}</p>
        <p className="text-[11px] text-muted-foreground">{t('hint')}</p>
      </div>
      {KINDS.map((kind) => {
        const group = variables.filter(def => def.kind === kind);
        if (group.length === 0) return null;
        return (
          <section key={kind} data-osw-variable-group={kind} className="flex flex-col gap-1.5">
            <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground">{t(`groups.${kind}`)}</h4>
            {group.map((def) => {
              const context = variableContext(def);
              const count = uses[def.name] ?? 0;
              return (
                <div key={variableKey(def)} data-osw-variable={def.name} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-2">
                  <Tip label={`${def.file} · ${count === 0 ? t('notUsed') : t('uses', { count })}`} align="start">
                    <div className="min-w-0 pt-1">
                      <div className="truncate font-mono text-[11px]">{def.name}</div>
                      {context ? <div className="truncate text-[10px] text-muted-foreground">{context}</div> : null}
                    </div>
                  </Tip>
                  <VariableField def={def} host={host} />
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
