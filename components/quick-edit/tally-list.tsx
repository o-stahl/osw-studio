'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { phraseStep, type Tally, type TallyStep } from '@/lib/quick-edit/tally';
import { collate, phraseCollated } from '@/lib/quick-edit/collate';

/**
 * How tall the open list gets before it scrolls, in steps.
 *
 * Expressed in rows because that is the thing being limited, and resolved to a height that lands on
 * a row boundary so the list never clips one through its text. The two measurements are the row's
 * own line height and the `space-y-2` between rows, so both have to change with those classes.
 */
const EXPANDED_STEPS = 8;
const STEP_ROW_HEIGHT = 16;
const STEP_ROW_GAP = 8;
const EXPANDED_MAX_HEIGHT = EXPANDED_STEPS * STEP_ROW_HEIGHT + (EXPANDED_STEPS - 1) * STEP_ROW_GAP;

function StepRow({ step }: { step: TallyStep }) {
  const t = useTranslations('quickEdit.step');
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="shrink-0 flex">
        {step.failed
          ? <X className="h-3 w-3 text-destructive" />
          : step.done
            ? <Check className="h-3 w-3 text-primary" />
            : <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </span>
      <span className={cn('flex-1 min-w-0', step.failed && 'text-muted-foreground')}>{phraseStep(step, t)}</span>
      {step.steps > 1 && (
        <span className="shrink-0 text-muted-foreground tabular-nums">x{step.steps}</span>
      )}
    </div>
  );
}

/**
 * A stretch of steps as one sentence that opens onto the steps.
 *
 * The sentence is the collation: "Read 3 files, then edited index.html, rebuilt the site". While the
 * stretch is still going, the step in flight shows under it until it finishes and joins the
 * sentence. Open, the sentence gives way to every step, in a box that scrolls past eight.
 */
export function TallyList({ tally, live }: { tally: Tally; live: boolean }) {
  const t = useTranslations('quickEdit.collate');
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [tally.steps.length, tally.commandCount]);

  const collated = collate(tally);
  if (!collated) return null;
  const line = phraseCollated(collated, t);

  // A single step is its own summary. Collating it would put one row behind a disclosure and
  // restate it in more general words ("Edited index.html" over "Read index.html"), so the step
  // is shown as itself instead, with no chevron to open.
  if (tally.steps.length === 1) {
    return <StepRow step={tally.steps[0]} />;
  }

  const latest = tally.steps[tally.steps.length - 1];
  const inFlight = live && latest && !latest.done ? latest : null;
  // Keyed by position in the tally, which only ever appends or revises its last step.
  const rows = tally.steps.map((step, i) => ({ ...step, key: i }));

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-start gap-1 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight className={cn('h-3 w-3 mt-[3px] shrink-0 transition-transform', open && 'rotate-90')} />
        <span>{line}</span>
      </button>

      {open ? (
        <div ref={listRef} className="space-y-2 overflow-y-auto pr-1 pl-4" style={{ maxHeight: EXPANDED_MAX_HEIGHT }}>
          {rows.map((step) => <StepRow key={step.key} step={step} />)}
        </div>
      ) : inFlight && (
        <div className="pl-4">
          <StepRow step={inFlight} />
        </div>
      )}
    </div>
  );
}
