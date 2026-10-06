import type { DebugEvent } from '@/lib/stores/types';
import { parseToolArgs, type ActionKind } from '@/lib/agent-activity/parse-command';

/**
 * The redacted account of a run, for the quick-edit dock.
 *
 * A projection of the same event stream the chat panel renders, reduced to what someone who did not
 * ask for a transcript needs: which files the agent touched and what it did to them. Tool arguments,
 * command text, diffs, reasoning and raw model output are never carried, so the dock cannot leak
 * them by rendering a field it was handed. A step is a described action and a file name, never the
 * command that produced it.
 */

type RunStatus = 'idle' | 'working' | 'done' | 'failed' | 'waiting';

export interface TallyStep {
  /** What kind of action it was: worded by {@link phraseStep}, and collated into a sentence. */
  kind: ActionKind;
  /** The file it acted on, when it named one the tally accepts. */
  path: string | null;
  /** How many consecutive identical actions collapsed into this line. */
  steps: number;
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
  /** Set once the run ends: the outcome, worded by the thread under `quickEdit.summary`. */
  summary: TallySummary | null;
}

export type TallySummary = { kind: 'failed' } | { kind: 'stopped' } | { kind: 'changed'; files: number };

/** The kinds whose line names the file. The rest read the same whatever they touched. */
const NAMED_KINDS = new Set<ActionKind>(['write', 'read', 'edit', 'create', 'delete', 'move', 'copy']);

/** Words a step under `quickEdit.step`: the kind's sentence, with the file's name where it has one. */
export type StepTranslator = (key: ActionKind, values: { has: 'yes' | 'no'; file: string }) => string;

/**
 * One action as one line.
 *
 * Only the file name reaches the line, never the command: an action whose kind has no useful file,
 * or whose target was not a project path, is phrased without one rather than falling back to raw
 * command text.
 */
export function phraseStep(step: Pick<TallyStep, 'kind' | 'path'>, t: StepTranslator): string {
  const file = NAMED_KINDS.has(step.kind) && step.path ? fileName(step.path) : '';
  return t(step.kind, { has: file ? 'yes' : 'no', file });
}

/** Two actions read as the same line: same kind, and the same file where the kind names one. */
function sameLine(a: Pick<TallyStep, 'kind' | 'path'>, b: Pick<TallyStep, 'kind' | 'path'>): boolean {
  return a.kind === b.kind && (!NAMED_KINDS.has(a.kind) || a.path === b.path);
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
          if (parsed && parsed.path && WRITING_KINDS.has(parsed.kind)) pushFile(filesChanged, parsed.path);

          const kind: ActionKind = parsed?.kind ?? 'other';
          const path = parsed?.path ?? null;
          const last = steps[steps.length - 1];
          // Consecutive identical actions are one line with a count, which is what makes this a
          // tally rather than a transcript with the words taken out. A run reports each call as
          // finished before starting the next, so merging has to reopen the line it merges into
          // rather than treat a finished line as closed.
          let index: number;
          if (last && sameLine(last, { kind, path })) {
            last.steps += 1;
            last.done = false;
            index = steps.length - 1;
          } else {
            index = steps.push({ kind, path, steps: 1, done: false, failed: false }) - 1;
          }
          if (callId) stepByCallId.set(callId, index);
          break;
        }

        if (data.status === 'completed' || data.status === 'failed') {
          const index = callId ? stepByCallId.get(callId) : undefined;
          const step = index === undefined ? steps[steps.length - 1] : steps[index];
          if (step) {
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
      case 'task_complete':
        if (status !== 'failed') status = 'done';
        break;
    }
  }

  // Phrased after the whole stream is counted: a write's status can be recorded after the
  // completion that follows it, and a summary written at that moment would deny the file it lists.
  if (status === 'done') {
    for (const step of steps) step.done = true;
    summary = { kind: 'changed', files: filesChanged.length };
  }

  const commandCount = steps.reduce((total, step) => total + step.steps, 0);

  return { status, steps, commandCount, filesChanged, summary };
}
