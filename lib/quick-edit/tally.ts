import type { DebugEvent } from '@/lib/stores/types';
import { parseToolArgs, type ActionKind } from '@/lib/agent-activity/parse-command';

/**
 * The redacted account of a run: which files the agent touched and what it did to them.
 *
 * A tally carries no tool arguments, command text, diffs, reasoning or raw model output: a step is a
 * described action and a file name, never the command that produced it. The thread keeps the events
 * a group was folded from beside its tally (`RunSegment` in `runs.ts`), so an opened group can show
 * its calls; the simple view leaves those calls closed (`DetailRows`, `SingleStep` in
 * `tally-list.tsx`).
 */

type RunStatus = 'idle' | 'working' | 'done' | 'failed' | 'waiting';

export interface TallyStep {
  /** What kind of action it was: worded by {@link phraseStep}, and collated into a sentence. */
  kind: ActionKind;
  /** The file it acted on, when it named one the tally accepts, the first when it named several. */
  path: string | null;
  /** Every file it acted on, `path` first: a `cat` of two files reads both. */
  paths: string[];
  /** How many consecutive identical actions collapsed into this line. */
  steps: number;
  /**
   * The tool calls behind the line, one per collapsed action. Ids only: the call itself is looked
   * up in the run's events when the step is opened, never carried here.
   */
  callIds: string[];
  done: boolean;
  failed: boolean;
}

export interface Tally {
  status: RunStatus;
  steps: TallyStep[];
  /**
   * Commands the run has issued, counting each one rather than each line.
   *
   * The dock heads the list with this, so it has to survive the collapsing that `steps` does: three
   * writes to one file are one line and three commands.
   */
  commandCount: number;
  /**
   * Paths the run wrote, deduplicated, in the order they were first touched.
   *
   * Read from the actions themselves as well as from `files_changed`: only a server-run generation
   * emits that event, so a run in the browser would otherwise report having changed nothing.
   */
  filesChanged: string[];
  /** Set when the run fails or is stopped: the outcome, worded by the thread under `quickEdit.summary`. */
  summary: TallySummary | null;
}

export type TallySummary = { kind: 'failed' } | { kind: 'stopped' };

/** The kinds whose line names the file. The rest read the same whatever they touched. */
const NAMED_KINDS = new Set<ActionKind>(['write', 'read', 'edit', 'create', 'delete', 'move', 'copy']);

/** Words a step under `quickEdit.step`: the kind's sentence, with the file's name where it has one. */
export type StepTranslator = (key: ActionKind, values: { has: 'yes' | 'no'; file: string }) => string;

/** What a step's line is worded from: its kind and its files. A call still being written has one file. */
type StepPhrase = Pick<TallyStep, 'kind' | 'path'> & { paths?: string[] };

/** How many file names a line lists before it counts the rest. */
const NAMES_SHOWN = 3;

/** A placeholder no file name holds, standing in for the names to find where a locale puts them. */
const FILE_MARK = '\uE000';

/**
 * One action as one line, split around the files it names so a surface can set them apart:
 * "Read " + "main.js, style.css" + "". A line that names none is all `before`.
 *
 * Only file names reach the line, never the command: an action whose kind has no useful file, or
 * whose target was not a project path, is phrased without one rather than falling back to raw
 * command text.
 */
export function phraseStepParts(step: StepPhrase, t: StepTranslator): { before: string; files: string; after: string } {
  const paths = step.paths ?? (step.path ? [step.path] : []);
  if (!NAMED_KINDS.has(step.kind) || paths.length === 0) {
    return { before: t(step.kind, { has: 'no', file: '' }), files: '', after: '' };
  }
  const names = paths.slice(0, NAMES_SHOWN).map(fileName).join(', ');
  const files = paths.length > NAMES_SHOWN ? `${names} +${paths.length - NAMES_SHOWN}` : names;
  const line = t(step.kind, { has: 'yes', file: FILE_MARK });
  const at = line.indexOf(FILE_MARK);
  if (at === -1) return { before: t(step.kind, { has: 'yes', file: files }), files: '', after: '' };
  return { before: line.slice(0, at), files, after: line.slice(at + FILE_MARK.length) };
}

/** One action as one line, as plain words. */
export function phraseStep(step: StepPhrase, t: StepTranslator): string {
  const { before, files, after } = phraseStepParts(step, t);
  return before + files + after;
}

/** Two actions read as the same line: same kind, and the same files where the kind names them. */
function sameLine(a: Pick<TallyStep, 'kind' | 'paths'>, b: Pick<TallyStep, 'kind' | 'paths'>): boolean {
  return a.kind === b.kind && (!NAMED_KINDS.has(a.kind) || a.paths.join('\n') === b.paths.join('\n'));
}

/** The actions that leave a file different from how they found it. */
const WRITING_KINDS = new Set<ActionKind>(['write', 'edit', 'create', 'delete', 'move', 'copy']);

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function pushFile(files: string[], path: unknown): void {
  if (typeof path === 'string' && path !== '' && !files.includes(path)) files.push(path);
}

export function buildTally(events: DebugEvent[]): Tally {
  const steps: TallyStep[] = [];
  const filesChanged: string[] = [];
  /** Which line each in-flight tool call landed on, so its result marks the right one. */
  const stepByCallId = new Map<string, number>();
  let status: RunStatus = 'idle';
  let summary: TallySummary | null = null;

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;

    // The switch is the allowlist: it has no default, so an event with no case here contributes
    // nothing. A second list of permitted names would only add a place to forget.
    switch (event.event) {
      case 'toolCalls':
        if (status !== 'waiting') status = 'working';
        break;
      case 'tool_status': {
        const callId = typeof data.toolCallId === 'string' ? data.toolCallId : null;

        if (data.status === 'executing') {
          if (status !== 'waiting') status = 'working';
          const parsed = parseToolArgs(data.args);
          if (parsed && WRITING_KINDS.has(parsed.kind)) for (const changed of parsed.paths) pushFile(filesChanged, changed);

          const kind: ActionKind = parsed?.kind ?? 'other';
          const path = parsed?.path ?? null;
          const paths = parsed?.paths ?? [];
          const last = steps[steps.length - 1];
          // Consecutive identical actions are one line with a count, which is what makes this a
          // tally rather than a transcript with the words taken out. A run reports each call as
          // finished before starting the next, so merging has to reopen the line it merges into
          // rather than treat a finished line as closed. A line that failed takes no more: the line
          // says it failed, and the attempt after it is worded on its own.
          let index: number;
          if (last && !last.failed && sameLine(last, { kind, paths })) {
            last.steps += 1;
            last.done = false;
            index = steps.length - 1;
          } else {
            index = steps.push({ kind, path, paths, steps: 1, callIds: [], done: false, failed: false }) - 1;
          }
          if (callId) {
            stepByCallId.set(callId, index);
            steps[index].callIds.push(callId);
          }
          break;
        }

        if (data.status === 'completed' || data.status === 'failed') {
          const index = callId ? stepByCallId.get(callId) : undefined;
          const at = index === undefined ? steps.length - 1 : index;
          const step = steps[at];
          if (step && data.status === 'failed' && step.steps > 1 && at === steps.length - 1 && callId && step.callIds[step.callIds.length - 1] === callId) {
            // The attempt that failed comes off the line it was merged into, which keeps the
            // attempts before it that worked.
            step.steps -= 1;
            step.callIds.pop();
            step.done = true;
            steps.push({ kind: step.kind, path: step.path, paths: step.paths, steps: 1, callIds: [callId], done: true, failed: true });
          } else if (step) {
            step.done = true;
            if (data.status === 'failed') step.failed = true;
          }
          if (callId) stepByCallId.delete(callId);
        }
        break;
      }
      case 'files_changed': {
        // The runner emits `paths`; a locally dispatched event may carry file objects instead.
        const raw = Array.isArray(data.paths) ? data.paths : Array.isArray(data.files) ? data.files : [];
        for (const entry of raw) {
          pushFile(filesChanged, typeof entry === 'string' ? entry : (entry as { path?: string })?.path);
        }
        break;
      }
      case 'approval_required':
        status = 'waiting';
        break;
      case 'error':
      case 'error_paused':
      case 'api_stopped':
        status = 'failed';
        summary = { kind: 'failed' };
        break;
      case 'stopped':
        status = 'idle';
        summary = { kind: 'stopped' };
        break;
      case 'task_complete': {
        // How the run ended, as both paths report it. A run that paused on a gated command ends
        // there but still waits for the person's answer.
        const result = data.result;
        if (result === 'stopped' || result === 'cancelled' || summary?.kind === 'stopped') {
          status = 'idle';
          summary = { kind: 'stopped' };
        } else if (result === 'failed') {
          status = 'failed';
          summary = { kind: 'failed' };
        } else if (!(status === 'waiting' && data.exitReason === 'awaiting_user') && status !== 'failed') {
          status = 'done';
        }
        break;
      }
    }
  }

  // Marked after the whole stream is counted: a write's status can be recorded after the completion
  // that follows it.
  if (status === 'done') {
    for (const step of steps) step.done = true;
  }

  const commandCount = steps.reduce((total, step) => total + step.steps, 0);

  return { status, steps, commandCount, filesChanged, summary };
}
