'use client';

import React, { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import type { DebugEvent } from '@/lib/stores/types';
import { phraseStepParts, type StepTranslator, type Tally, type TallyStep } from '@/lib/quick-edit/tally';
import { collate, phraseCollated } from '@/lib/quick-edit/collate';
import { reasoningHead, reasoningTail, stepDetail, type DetailRow } from '@/lib/quick-edit/detail';
import type { FormingStep } from '@/lib/quick-edit/forming';
import type { Usage } from '@/lib/quick-edit/runs';
import type { ToolCall } from '@/components/chat-panel/event-processor';
import { ToolDisplay } from '@/components/chat-panel/transcript-items';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { UsageBreakdown } from './usage-info';

/**
 * A row that opens. It highlights under the pointer, the highlight reaching a little past its words
 * so they do not touch its edge: the bleed is margin given back as padding, so the row's contents
 * stay where they were, and its width is its box plus the bleed, since a button does not stretch to
 * its container on its own.
 */
export function RowButton({ className, style, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      {...props}
      className={cn('-mx-1 px-1 rounded cursor-pointer hover:bg-muted/50 transition-colors', className)}
      style={{ width: 'calc(100% + 0.5rem)', ...style }}
    />
  );
}

/**
 * Every row of an opened group shares the step row's shape: its words, what it counts, a chevron.
 * The words carry its state, with no icon beside them: "Wrote index.html", "Editing index.html…",
 * "Tried to edit index.html, but it failed".
 */
const ROW = 'flex items-center gap-2 text-left text-xs';
const Chevron = ({ open }: { open?: boolean }) => (
  <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform text-muted-foreground', open && 'rotate-90')} />
);
/** The words of a row that is still happening, which pulse. */
const LIVE = 'animate-pulse';

/** A step's words, with the files it names in the quieter colour: "Read " and then "main.js". */
function StepWords({ step, t }: { step: Parameters<typeof phraseStepParts>[0]; t: StepTranslator }) {
  const { before, files, after } = phraseStepParts(step, t);
  return <>{before}{files && <span className="text-muted-foreground">{files}</span>}{after}</>;
}

/**
 * One entry under a group, hung from the line that runs down from the group's caret: a tick into
 * its first line, and the line running on to the next entry, stopping at the last one's tick. What
 * an entry opens onto stays inside it, so the line runs alongside that too. A call's box puts its
 * first line lower than a row does, and the tick goes with it.
 */
function Branch({ box = false, children }: { box?: boolean; children: React.ReactNode }) {
  return (
    <li
      className={cn(
        'relative pl-4 space-y-2',
        'before:absolute before:left-[5px] before:-top-2 before:bottom-0 before:border-l before:border-border last:before:bottom-auto',
        'after:absolute after:left-[5px] after:w-2 after:border-t after:border-border',
        box ? 'after:top-[14px] last:before:h-[22px]' : 'after:top-2 last:before:h-4',
      )}
    >
      {children}
    </li>
  );
}

/** The entries under a group, a list of their own so the last of them ends the line. */
function Tree({ children }: { children: React.ReactNode }) {
  return <ul className="space-y-2">{children}</ul>;
}

/**
 * One step, and when it has calls to show, the way into them: the row opens onto its calls' rows
 * (`ToolDisplay`). While its call runs, the step is worded as happening ("Writing index.html…"), and
 * a step that failed says so ("Tried to write index.html, but it failed").
 */
function StepRow({ step, open, onToggle }: { step: TallyStep; open?: boolean; onToggle?: () => void }) {
  const t = useTranslations('quickEdit.step');
  const tRunning = useTranslations('quickEdit.stepRunning');
  const tFailed = useTranslations('quickEdit.stepFailed');
  const running = !step.done && !step.failed;
  const content = (
    <>
      <span className={cn('flex-1 min-w-0', running && LIVE)}>
        <StepWords step={step} t={step.failed ? tFailed : running ? tRunning : t} />
      </span>
      {step.steps > 1 && (
        <span className="shrink-0 text-muted-foreground tabular-nums">x{step.steps}</span>
      )}
    </>
  );
  if (!onToggle) return <div className="flex items-center gap-2 text-xs">{content}</div>;
  return (
    <RowButton aria-expanded={open} onClick={onToggle} className={ROW}>
      {content}
      <Chevron open={open} />
    </RowButton>
  );
}

/**
 * The call the model is writing, before it runs: what it does, and for a file, how many lines are
 * in so far. No code shows here; opened, the call's row (`ToolDisplay`) streams the command.
 */
export function FormingRow({ step, open, onToggle }: { step: FormingStep; open?: boolean; onToggle?: () => void }) {
  const tRunning = useTranslations('quickEdit.stepRunning');
  const t = useTranslations('quickEdit');
  const content = (
    <>
      <span className={cn('flex-1 min-w-0', LIVE)}><StepWords step={step} t={tRunning} /></span>
      {step.lines > 0 && (
        <span className="shrink-0 text-muted-foreground tabular-nums">{t('lines', { count: step.lines })}</span>
      )}
    </>
  );
  if (!onToggle) return <div className="flex items-center gap-2 text-xs">{content}</div>;
  return (
    <RowButton aria-expanded={open} onClick={onToggle} className={ROW}>
      {content}
      <Chevron open={open} />
    </RowButton>
  );
}

/**
 * A stretch of the model's reasoning, as a row: its first line, opening onto the whole in a
 * reasoning box, and while it is still being written, its newest words. Among a
 * group's steps it takes their colour, so the rows read as one list; on its own, above the prose it
 * led to, it is quiet.
 */
function ReasoningRow({ text, complete, open, onToggle, quiet }: { text: string; complete: boolean; open: boolean; onToggle: () => void; quiet: boolean }) {
  const t = useTranslations('quickEdit.activity');
  const tone = quiet && 'text-muted-foreground';
  if (!complete) {
    return (
      <div className="flex w-full items-center gap-2 text-xs">
        <span className={cn('flex-1 min-w-0 truncate', tone, LIVE)}>{reasoningTail(text) || t('thinking')}</span>
      </div>
    );
  }
  return (
    <>
      <RowButton aria-expanded={open} onClick={onToggle} className={ROW}>
        <span className={cn('flex-1 min-w-0 truncate', tone)}>{reasoningHead(text)}</span>
        <Chevron open={open} />
      </RowButton>
      {open && (
        <div className="text-xs bg-muted/50 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto">
          <MarkdownRenderer content={text} />
        </div>
      )}
    </>
  );
}

/**
 * The calls behind an opened step, each in full. The step's row is what opens and closes them. In a
 * tree, each call is an entry of its own.
 */
function StepCalls({ calls, tree = false }: { calls: ToolCall[]; tree?: boolean }) {
  return (
    <>
      {calls.map((call) => {
        const box = <ToolDisplay key={call.id} tool={call} />;
        return tree ? <Branch key={call.id} box>{box}</Branch> : box;
      })}
    </>
  );
}

/**
 * An opened group's rows: its reasoning, its steps and the call being written, in order. In a tree,
 * each row is an entry, holding what it opens onto. In the simple view a step does not open onto the
 * calls behind it; reasoning opens in full, as it does above the prose it led to.
 */
function DetailRows({ rows, tree = false, simple = false }: { rows: DetailRow[]; tree?: boolean; simple?: boolean }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const entry = (key: string, content: React.ReactNode) =>
    tree ? <Branch key={key}>{content}</Branch> : <React.Fragment key={key}>{content}</React.Fragment>;
  return (
    <>
      {rows.map((row) => {
        const opened = open.has(row.key);
        switch (row.kind) {
          case 'reasoning':
            return entry(row.key, <ReasoningRow text={row.text} complete={row.complete} open={opened} onToggle={() => toggle(row.key)} quiet={!tree} />);
          case 'forming':
            return entry(row.key, (
              <>
                <FormingRow step={row.step} open={opened} onToggle={simple ? undefined : () => toggle(row.key)} />
                {opened && <StepCalls calls={[row.call]} />}
              </>
            ));
          case 'step':
            return entry(row.key, (
              <>
                <StepRow step={row.step} open={opened} onToggle={!simple && row.calls.length > 0 ? () => toggle(row.key) : undefined} />
                {opened && <StepCalls calls={row.calls} />}
              </>
            ));
        }
      })}
    </>
  );
}

/**
 * The reasoning of a response that ran no tools, which no group holds: its rows on their own, before
 * the prose they led to. The response has landed, so its reasoning is finished.
 */
export function ReasoningRows({ events }: { events: DebugEvent[] }) {
  const rows = useMemo(() => stepDetail(events, false).filter((row) => row.kind === 'reasoning'), [events]);
  return <DetailRows rows={rows} />;
}

/**
 * A stretch of steps as one sentence that opens onto the steps.
 *
 * The sentence is the collation: "Read 3 files, then edited index.html, rebuilt the site". While the
 * stretch is still going, the step in flight, or the call being written, shows under it. Open, the
 * sentence gives way to every step with the reasoning between them, read from the stretch's own
 * `events`; each step opens onto its calls, and a finished list ends on what the stretch cost.
 */
export function TallyList({ tally, live, events, usage = null, forming = null, thinking = false, simple = false }: {
  tally: Tally;
  live: boolean;
  /** Quick edit's simple view: no step opens onto its calls; reasoning opens as it does anywhere. */
  simple?: boolean;
  /** The stretch's own events, for its reasoning and calls. Without them it opens onto its steps alone. */
  events?: DebugEvent[];
  usage?: Usage | null;
  /** The call the model is writing now, when it belongs to this stretch. */
  forming?: FormingStep | null;
  /** The model is reasoning about this stretch's next step. Open, the reasoning row streams it. */
  thinking?: boolean;
}) {
  const t = useTranslations('quickEdit.collate');
  const [open, setOpen] = useState(false);
  const detail = useMemo(() => (open && events ? stepDetail(events, live) : null), [open, events, live]);

  const collated = collate(tally);
  if (!collated) return null;
  const line = phraseCollated(collated, t);
  const writing = live ? forming : null;
  const thought = live && thinking;

  // A single step is its own summary. Collating it would put one row behind a disclosure and
  // restate it in more general words ("Edited index.html" over "Read index.html"), so the step
  // is shown as itself instead; it opens onto what is behind it, when there is anything.
  if (tally.steps.length === 1) {
    return <SingleStep step={tally.steps[0]} events={events} live={live} writing={writing} thinking={thought} simple={simple} />;
  }

  const latest = tally.steps[tally.steps.length - 1];
  const inFlight = live && latest && !latest.done ? latest : null;
  // Keyed by position in the tally, which only ever appends or revises its last step.
  const rows = tally.steps.map((step, i) => ({ ...step, key: i }));

  return (
    <div className="space-y-1.5">
      <RowButton
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-start gap-1 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn('h-3 w-3 mt-[3px] shrink-0 transition-transform', open && 'rotate-90')} />
        <span>{line}</span>
      </RowButton>

      {open ? (
        <div className="space-y-2">
          <Tree>
            {detail
              ? <DetailRows rows={detail} tree simple={simple} />
              : rows.map((step) => <Branch key={step.key}><StepRow step={step} /></Branch>)}
          </Tree>
          {!live && usage && <div className="pl-4"><UsageBreakdown usage={usage} /></div>}
        </div>
      ) : (inFlight || writing || thought) && (
        <Tree>
          <Branch>{inFlight ? <StepRow step={inFlight} /> : writing ? <FormingRow step={writing} /> : <ThinkingRow />}</Branch>
        </Tree>
      )}
    </div>
  );
}

/** The model reasoning about what comes next, under a closed group: open, the reasoning row streams it. */
function ThinkingRow() {
  const t = useTranslations('quickEdit.activity');
  return (
    <div className="flex w-full items-center gap-2 text-xs">
      <span className={cn('flex-1 min-w-0 truncate', LIVE)}>{t('thinking')}</span>
    </div>
  );
}

/**
 * A stretch of one step: the step itself, opening onto its reasoning and calls. In the simple view it
 * opens onto its reasoning alone, the one level it has, and only when it has any.
 */
function SingleStep({ step, events, live, writing, thinking, simple }: { step: TallyStep; events?: DebugEvent[]; live: boolean; writing: FormingStep | null; thinking: boolean; simple: boolean }) {
  const [open, setOpen] = useState(false);
  const thoughts = useMemo(() => (simple && events ? stepDetail(events, live).filter((r) => r.kind === 'reasoning') : null), [simple, events, live]);
  const detail = useMemo(() => (open && events ? (thoughts ?? stepDetail(events, live)) : null), [open, events, thoughts, live]);
  const openable = thoughts ? thoughts.length > 0 : events !== undefined && step.callIds.length > 0;
  const row = <StepRow step={step} open={open} onToggle={openable ? () => setOpen((v) => !v) : undefined} />;
  if (!detail && !writing && !thinking) return row;
  return (
    <div className="space-y-2">
      {row}
      {detail && (
        <Tree>
          <DetailRows rows={detail.filter((r) => r.kind === 'reasoning')} tree simple={simple} />
          <StepCalls calls={detail.flatMap((r) => (r.kind === 'step' ? r.calls : []))} tree />
        </Tree>
      )}
      {writing ? <FormingRow step={writing} /> : thinking && !detail && <ThinkingRow />}
    </div>
  );
}
