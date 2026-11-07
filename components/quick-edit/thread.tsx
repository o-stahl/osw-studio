'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronRight, Info, Redo2, RefreshCw, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Run, RunContext, RunNotice, RunSegment, RunUsage } from '@/lib/quick-edit/runs';
import type { ModelRef } from '@/lib/llm/models/assignment';
import type { FormingStep } from '@/lib/quick-edit/forming';
import { FormingRow, ReasoningRows, RowButton, TallyList } from './tally-list';
import { MessageContext } from '@/components/message-context';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { useApprovalSentence } from '@/lib/i18n/use-approval-sentence';
import { CompactionNotice, InterviewGateCard, SyntheticErrorDisplay, UsageLine, useDuration } from '@/components/chat-panel/transcript-items';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { LimitNotice, StoppedCard } from '@/components/chat-panel/limit-cards';
import { ChipsBlock } from '@/components/chat-panel/chips';
import type { InterviewHandoff } from '@/lib/interview/types';

/**
 * The conversation as a person who asked for changes reads it: their message, then a card of what
 * came of it, with each stretch of tool activity folded into one sentence, the agent's own words
 * shown as written, and the way back.
 *
 * The chat panel's conversation in the studio, in quick edit and in describe mode. The card shows no
 * command or output until a group or step is opened, and in the simple view not then either;
 * reasoning shows as a row's first line. It ends on the run's usage line, which shows from the first
 * model call and grows as the run goes on.
 */

export interface ChatThreadProps {
  runs: Run[];
  /**
   * The simple view, in quick edit and in describe mode outside the studio view, which keeps to the
   * change and the way back: a step does not open onto its calls, an approval says what the agent
   * wants without the command it is for, an earlier run offers Restore without Retry, and the empty
   * thread asks for a change.
   */
  simple?: boolean;
  /**
   * What the agent says before anything is asked, as describe mode opens: a card of its own above
   * the runs, in place of the empty thread's line.
   */
  opening?: string;
  generating: boolean;
  isDirty: boolean;
  /** Put the project back to how it was after the given run. */
  onRestore: (checkpointId: string) => void;
  /** Run a request again from the state before it, given the checkpoint it finished on. */
  onRetry?: (checkpointId: string) => void;
  /** Carry on a task a provider stopped, on the model picked on its card when one was. */
  onContinue?: (withModel?: ModelRef) => void;
  /** Undo the newest run. Null when there is nothing before it to go back to. */
  onUndoLatest: (() => void) | null;
  /** Redo what the last undo took back. Null when nothing has been undone. */
  onRedoLatest: (() => void) | null;
  onSave: () => void;
  /** Answer the gated command a waiting run is stopped on. */
  onAllow: (gateKey: string, capabilityLabel: string) => void;
  onDeny: (gateKey: string, capabilityLabel: string) => void;
  /** Answer the question a run ended on with one of its options, as the next message. */
  onAnswer?: (value: string) => void;
  /** Take the follow-up an interview offers once its completion check passes. */
  onHandoff?: (handoff: InterviewHandoff) => void;
}

/**
 * The person's message, with the context marking the composer gave it: the element that was picked,
 * the blocks placed, the files and clips attached. The composer's own component, read-only here, and
 * it renders nothing when the request came with nothing.
 */
function Request({ text, context }: { text: string; context: RunContext }) {
  const t = useTranslations('quickEdit');
  const images = context.contentBlocks?.filter((b) => b.type === 'image_url');
  const audio = context.contentBlocks?.filter((b) => b.type === 'input_audio');
  return (
    <div className="text-sm text-foreground bg-primary/10 px-3 py-2 rounded border border-primary/20">
      <div className="font-semibold text-primary mb-1 text-xs">{t('you')}</div>
      <p className="leading-relaxed whitespace-pre-wrap">{text}</p>
      <MessageContext
        focusContext={context.focusContext}
        semanticBlocks={context.semanticBlocks}
        fileNames={context.attachedFiles}
        imageBlocks={images?.length ? images : undefined}
        audioBlocks={audio?.length ? audio : undefined}
        defaultOpen={!!audio?.length && text === ''}
        readOnly
      />
    </div>
  );
}

/**
 * The agent's prose as written, at the size the conversation reads at: the renderer's lists and
 * tables are set at it, so paragraphs are too, and it keeps the renderer's spacing.
 */
function Prose({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed [&>div>:last-child]:mb-0">
      <MarkdownRenderer content={text} />
    </div>
  );
}

/** An auto-correction: a row that opens onto what the model was told. */
function Correction({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return <SyntheticErrorDisplay content={text} isExpanded={open} onToggle={() => setOpen((v) => !v)} />;
}

/** What a notice needs from the thread: an interview's follow-up, which waits while a task runs. */
interface NoticeActions {
  onHandoff?: (handoff: InterviewHandoff) => void;
  generating: boolean;
}

function Notice({ notice, onHandoff, generating }: { notice: RunNotice } & NoticeActions) {
  switch (notice.kind) {
    case 'compaction':
      return <CompactionNotice before={notice.before} after={notice.after} />;
    case 'limit':
      return <LimitNotice data={notice.data} />;
    case 'correction':
      return <Correction text={notice.text} />;
    case 'interview':
      return <InterviewGateCard gate={notice.gate} onHandoff={onHandoff} disabled={generating} />;
  }
}

function Segment({ segment, live, forming, thinking, simple, ...actions }: { segment: RunSegment; live: boolean; forming: FormingStep | null; thinking: boolean; simple: boolean } & NoticeActions) {
  switch (segment.kind) {
    case 'text':
      return <Prose text={segment.text} />;
    case 'reasoning':
      return <ReasoningRows events={segment.events} />;
    case 'steps':
      return <TallyList tally={segment.tally} events={segment.events} usage={segment.usage} live={live} forming={forming} thinking={thinking} simple={simple} />;
    case 'notice':
      return <Notice notice={segment.notice} {...actions} />;
  }
}

/** The agent speaking again: its prose, or the reasoning that led to it. */
const speaks = (segment: RunSegment | undefined) => segment?.kind === 'text' || segment?.kind === 'reasoning';

/**
 * Where a batch of tool calls ends and the agent speaks, or the run closes: a faint rule, quieter
 * than a notice's, so a notice still reads as an event.
 */
function Separator() {
  return (
    <div className="py-1">
      <div className="border-t border-dashed border-border/60" />
    </div>
  );
}

/**
 * The run's own account of what it did, from its `status --done`: a row like a step, the account on
 * up to two lines, opening onto all of it and the task it was for. What remains shows only when
 * something does.
 */
function StatusRow({ closing }: { closing: NonNullable<Run['closing']> }) {
  const t = useTranslations('quickEdit.status');
  const [open, setOpen] = useState(false);
  const remaining = closing.remaining.trim();
  const row = (
    <RowButton aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex items-start gap-2 text-left text-xs">
      <span className={cn('flex-1 min-w-0 leading-relaxed', !open && 'line-clamp-2')}>{closing.text}</span>
      <ChevronRight className={cn('h-3 w-3 shrink-0 mt-1 transition-transform text-muted-foreground', open && 'rotate-90')} />
    </RowButton>
  );
  if (!open) return row;
  const label = (text: string) => <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{text}</div>;
  return (
    <>
      {row}
      <div className="bg-muted/30 rounded-md p-2 space-y-2">
        <div>{label(t('task'))}<div className="text-xs leading-relaxed">{closing.task}</div></div>
        {remaining !== '' && remaining.toLowerCase() !== 'none' && (
          <div>{label(t('remaining'))}<div className="text-xs leading-relaxed">{remaining}</div></div>
        )}
      </div>
    </>
  );
}

/**
 * The question a run ended on, from `ask`, with the answers it offered: picking one sends it as the
 * next message. Only the newest run's question can still be answered;
 * an older one keeps its options as a record of what was asked, with the one picked marked, or all
 * of them faded when the answer was typed instead.
 */
function Question({ ask, answer, answerable, onAnswer }: { ask: NonNullable<Run['ask']>; answer: string | null; answerable: boolean; onAnswer?: (value: string) => void }) {
  return (
    <div>
      {ask.prompt && <p className="text-sm leading-relaxed">{ask.prompt}</p>}
      <div className={cn(!answerable && answer === null && 'opacity-60')}>
        <ChipsBlock options={ask.options} picked={answer} onSelect={(value) => onAnswer?.(value)} disabled={!answerable} />
      </div>
    </div>
  );
}

/** The option a question was answered with: the next request, when it is one, as a chip sends it. */
function answerTo(ask: Run['ask'], next: Run | undefined): string | null {
  if (!ask || !next) return null;
  return ask.options.find((option) => option.trim() === next.request) ?? null;
}

/**
 * What went wrong, in the error's own words, with its stack trace a row away when it has one. An
 * error that came without words keeps the card's own sentence.
 */
function ErrorRow({ error, fallback }: { error: Run['error']; fallback: string }) {
  const t = useTranslations('chat');
  const [open, setOpen] = useState(false);
  const stack = error?.stack ?? '';
  return (
    <div className="space-y-1.5">
      <div className="text-xs leading-relaxed text-destructive whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
        {error?.message || fallback}
      </div>
      {stack !== '' && (
        <>
          <RowButton aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex items-center gap-2 text-left text-xs text-muted-foreground">
            <span className="flex-1 min-w-0">{t('stackTrace')}</span>
            <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
          </RowButton>
          {open && (
            <pre className="text-[10px] text-muted-foreground bg-muted/50 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto">{stack}</pre>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The time with an (i) that opens onto the tokens and cost, for a last line with no room for them.
 * A popover, opened by a tap, since a tooltip opens only on hover and the line runs short on phones.
 */
function ShortFigures({ usage }: { usage: RunUsage }) {
  const t = useTranslations('quickEdit');
  const duration = useDuration();
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      {Math.round(usage.ms / 1000) > 0 && <span>{duration(usage.ms)}</span>}
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" aria-label={t('figures')} className="flex rounded p-0.5 cursor-pointer hover:text-foreground">
            <Info className="h-3 w-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-fit px-3 py-1.5 border-primary/40 bg-[color-mix(in_oklab,var(--primary)_15%,var(--popover))]">
          <UsageLine tokens={usage.totalTokens} cost={usage.cost} ms={0} className="text-primary" />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * A card's last line: the activity while the run goes on, the actions once it is done, and the
 * run's figures on the right. Where the line has no room for the tokens and cost, they move into an
 * (i) beside the time. Measured rather than set at a width, since the room left depends on which
 * buttons show and how far the figures have grown; the full figures stay in place while hidden, so
 * their width can still be read.
 */
function FooterRow({ usage, children }: { usage: RunUsage | null; children: React.ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const figuresRef = useRef<HTMLDivElement>(null);
  const [short, setShort] = useState(false);

  const measure = useCallback(() => {
    const row = rowRef.current;
    const left = leftRef.current;
    const figures = figuresRef.current;
    // Nothing laid out to read (a hidden panel): the full figures.
    if (!row || !left || !figures || row.clientWidth === 0) {
      setShort(false);
      return;
    }
    const gap = (el: Element) => parseFloat(getComputedStyle(el).columnGap) || 0;
    const items = Array.from(left.children) as HTMLElement[];
    const leftWidth = items.reduce((sum, el) => sum + el.offsetWidth, 0) + Math.max(0, items.length - 1) * gap(left);
    setShort(leftWidth + gap(row) + figures.offsetWidth > row.clientWidth);
  }, []);

  // After every render, since the buttons and the figures change as the run does, and on resize.
  useLayoutEffect(measure);
  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div ref={rowRef} className="relative flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
      <div ref={leftRef} className="flex flex-wrap gap-1.5">{children}</div>
      {usage && (
        <div ref={figuresRef} className="whitespace-nowrap" style={short ? { position: 'absolute', visibility: 'hidden' } : undefined}>
          <UsageLine tokens={usage.totalTokens} cost={usage.cost} ms={usage.ms} />
        </div>
      )}
      {usage && short && <ShortFigures usage={usage} />}
    </div>
  );
}

export function ChatThread({ runs, simple = false, opening, generating, isDirty, onRestore, onRetry, onContinue, onUndoLatest, onRedoLatest, onSave, onAllow, onDeny, onAnswer, onHandoff }: ChatThreadProps) {
  const tc = useTranslations('common');
  const tchat = useTranslations('chat');
  const t = useTranslations('quickEdit');
  const tsum = useTranslations('quickEdit.summary');
  const wantsTo = useApprovalSentence();
  if (runs.length === 0 && !opening) {
    return (
      <p className="text-xs text-muted-foreground p-2">
        {simple ? t('emptyThread') : tchat('noMessages')}
      </p>
    );
  }

  const latest = runs[runs.length - 1];

  return (
    <div className="space-y-3">
      {opening && (
        <div className="rounded-lg border border-border bg-card px-3 py-2.5">
          <Prose text={opening} />
        </div>
      )}
      {runs.map((run, index) => {
        const isLatest = run === latest;
        // A request the store has recorded but not yet started answering has no events and no
        // outcome; it reads as working, not as a run that changed nothing.
        const pending = isLatest && !generating && run.segments.length === 0 && run.tally.status === 'idle' && run.tally.summary === null;
        const live = isLatest && (generating || pending);
        const failed = run.tally.status === 'failed';
        const waiting = run.tally.status === 'waiting';
        const lastSegment = run.segments[run.segments.length - 1];
        // The call being written shows under the group it will join, or on its own when nothing
        // came before it but prose or a notice.
        const forming = live ? run.forming : null;
        const formingInGroup = forming && lastSegment?.kind === 'steps' ? forming : null;
        const formingAlone = forming && !formingInGroup ? forming : null;
        // Reasoning about a group's next step is that group's to show, as the call being written is.
        const thinkingInGroup = live && run.activity === 'thinking' && lastSegment?.kind === 'steps';
        // The in-flight step, the call being written and the group's reasoning show where they are;
        // the activity line covers the rest, under streaming prose too: a response can go on past
        // its prose into a tool call that arrives all at once.
        const activityLabel = live && !forming && !thinkingInGroup
          ? run.activity === 'working' && lastSegment?.kind === 'steps' ? null : t(`activity.${run.activity ?? 'working'}`)
          : null;
        // The answer: the prose a finished run ended on, set apart above the actions with the
        // reasoning that led to it, or failing that the run's own `status --done`, as a row.
        const closingProse = run.tally.status === 'done' && lastSegment?.kind === 'text' ? lastSegment : null;
        const beforeLast = run.segments[run.segments.length - 2];
        const closingThought = closingProse && beforeLast?.kind === 'reasoning' ? beforeLast : null;
        const segments = run.segments.slice(0, run.segments.length - (closingProse ? 1 : 0) - (closingThought ? 1 : 0));
        const lastShown = segments[segments.length - 1];
        const statusRow = !closingProse && run.closing ? run.closing : null;
        // A run that simply worked says nothing more at the end: the steps above already said it, in
        // more detail than a count of files does. Anything else still reports itself, because nothing
        // else in the card would: a failure, in the error's own words, and a run the person stopped
        // ("Stopped."). A provider stop has its card above, which says it better.
        const outcome = run.tally.status !== 'done' && !run.stopped ? run.tally.summary : null;
        // What the run ended on sits between what came before it and the actions, and each is ruled
        // off from what is above it, unless that is a notice, which divides.
        const ended = closingProse !== null || statusRow !== null || run.ask !== null || outcome !== null;
        const above = (waiting && run.approval && isLatest) || run.stopped ? 'card' : lastShown?.kind ?? null;
        const endRule = ended && above !== null && above !== 'notice';
        const footRule = ended || (above !== null && above !== 'notice');

        return (
          <div key={run.id} className="space-y-2">
            <Request text={run.request} context={run.context} />

            <div
                className={cn('rounded-lg border bg-card px-3 py-2.5 space-y-2', live ? 'border-primary/40' : 'border-border')}
                {...(run.checkpointId ? { 'data-checkpoint-id': run.checkpointId } : {})}
              >
                {segments.map((segment, i) => (
                  <React.Fragment key={i}>
                    <Segment
                      segment={segment}
                      live={live && i === run.segments.length - 1}
                      forming={i === run.segments.length - 1 ? formingInGroup : null}
                      thinking={i === run.segments.length - 1 && thinkingInGroup}
                      simple={simple}
                      onHandoff={onHandoff}
                      generating={generating}
                    />
                    {segment.kind === 'steps' && speaks(segments[i + 1]) && <Separator />}
                  </React.Fragment>
                ))}

                {formingAlone && <FormingRow step={formingAlone} />}

                {run.stopped && (
                  <StoppedCard data={run.stopped.data} live={isLatest && !generating} onContinue={onContinue} />
                )}

                {waiting && run.approval && isLatest && (
                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 space-y-1.5">
                    <p className="text-xs font-medium">
                      {wantsTo(run.approval.gateKey, run.approval.capabilityLabel)}
                    </p>
                    {!simple && run.approval.command && (
                      <p className="text-[11px] text-muted-foreground font-mono truncate">{run.approval.command}</p>
                    )}
                    <p className="text-[11px] text-muted-foreground">{t('canUndo')}</p>
                    <div className="flex gap-1.5 pt-0.5">
                      <Button variant="accent" size="xs" onClick={() => onAllow(run.approval!.gateKey, run.approval!.capabilityLabel)} disabled={generating}>{t('allow')}</Button>
                      <Button variant="outline" size="xs" onClick={() => onDeny(run.approval!.gateKey, run.approval!.capabilityLabel)} disabled={generating}>{t('dont')}</Button>
                    </div>
                  </div>
                )}

                {/* While the run goes on, its last line is the activity on the left and what it has
                    cost so far on the right, where the figures stay once it ends. */}
                {live && (activityLabel || run.usage) && (
                  <FooterRow usage={run.usage}>
                    {activityLabel && <p className="text-xs text-muted-foreground animate-pulse">{activityLabel}</p>}
                  </FooterRow>
                )}

                {!live && endRule && <Separator />}
                {!live && (
                  <div className="space-y-2">
                    {closingThought && <ReasoningRows events={closingThought.events} />}
                    {closingProse && <Prose text={closingProse.text} />}
                    {statusRow && <StatusRow closing={statusRow} />}
                    {run.ask && <Question ask={run.ask} answer={answerTo(run.ask, runs[index + 1])} answerable={isLatest && onAnswer !== undefined} onAnswer={onAnswer} />}
                    {outcome && (
                      failed ? <ErrorRow error={run.error} fallback={tsum('failed')} /> : (
                        <p className="text-xs text-muted-foreground">
                          {tsum(outcome.kind)}
                        </p>
                      )
                    )}
                    {footRule && <Separator />}
                    {/* The actions and what the run cost, on one line: the actions where a hand
                        goes first, the figures out of the way on the right. */}
                    <FooterRow usage={run.usage}>
                      {isLatest ? (
                        <>
                          {/* The button flips with the project: once the change is undone, the same
                              spot offers to put it back. */}
                          {onRedoLatest ? (
                            <Button variant="outline" size="xs" onClick={onRedoLatest} disabled={generating}>
                              <Redo2 className="h-3 w-3 mr-1" />
                              {t('redoThis')}
                            </Button>
                          ) : onUndoLatest && (
                            <Button variant="outline" size="xs" onClick={onUndoLatest} disabled={generating}>
                              <Undo2 className="h-3 w-3 mr-1" />
                              {t('undoThis')}
                            </Button>
                          )}
                          {onRetry && run.checkpointId && (
                            <Button variant="outline" size="xs" onClick={() => onRetry(run.checkpointId!)} disabled={generating}>
                              <RefreshCw className="h-3 w-3 mr-1" />
                              {tc('actions.retry')}
                            </Button>
                          )}
                          {isDirty && (
                            <Button variant="accent" size="xs" onClick={onSave} disabled={generating}>
                              <Check className="h-3 w-3 mr-1" />
                              {tc('actions.save')}
                            </Button>
                          )}
                        </>
                      ) : run.checkpointId && (
                        <>
                          <Button variant="outline" size="xs" onClick={() => onRestore(run.checkpointId!)} disabled={generating}>
                            <Undo2 className="h-3 w-3 mr-1" />
                            {tc('actions.restore')}
                          </Button>
                          {!simple && onRetry && (
                            <Button variant="outline" size="xs" onClick={() => onRetry(run.checkpointId!)} disabled={generating}>
                              <RefreshCw className="h-3 w-3 mr-1" />
                              {tc('actions.retry')}
                            </Button>
                          )}
                        </>
                      )}
                    </FooterRow>
                  </div>
                )}
              </div>
          </div>
        );
      })}
    </div>
  );
}
