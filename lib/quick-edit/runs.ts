import type { DebugEvent } from '@/lib/stores/types';
import type { ContentBlock } from '@/lib/llm/types';
import type { LimitNoticeData, StoppedData } from '@/components/chat-panel/limit-cards';
import { buildTally, type Tally } from './tally';
import { isInjectedUserMessage } from '@/components/chat-panel/event-processor';
import { toolCommand } from '@/lib/agent-activity/parse-command';
import { parseStatusCommand } from '@/lib/llm/status-command';
import { describeForming, type FormingStep } from './forming';
import type { InterviewGate } from '@/lib/interview/completion';

/**
 * The event stream cut into runs: one per request a person made.
 *
 * The chat panel groups events by model iteration, which is the right grain for a developer reading
 * a transcript and the wrong one for someone who asked for a change and wants to know what came of
 * it. A run starts at a user message and ends at the next; everything between is what the agent did
 * about it, folded into a tally.
 */

/**
 * What a run, or a group of its steps, cost: the model calls behind it.
 *
 * Summed from the orchestrator's `usage` events. The provider adapter reports each call too;
 * counting both would count every call twice.
 */
export interface Usage {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
}

/** What a run cost, and how long it took: from the request to the report of its last call. */
export interface RunUsage extends Usage {
  ms: number;
}

/** A note in the run that is not the agent's: the transcript's own notices, in order. */
export type RunNotice =
  | { kind: 'compaction'; before: number; after: number }
  | { kind: 'limit'; data: LimitNoticeData }
  /** An error sent back to the model as the user, marked `isSyntheticError`, which only older histories carry. */
  | { kind: 'correction'; text: string }
  /** What an interview's completion check found: missing items, or done with its follow-up. */
  | { kind: 'interview'; gate: InterviewGate };

/**
 * One stretch of a run, in the order it happened.
 *
 * `text` is the model's prose, addressed to the person and shown as written. `steps` is a stretch of
 * tool activity folded into a tally, with the events it was folded from so an opened group can show
 * its reasoning and calls. `reasoning` is the reasoning of a response that ran no tools, which no
 * group would hold, placed before its prose. `notice` is a compaction, a limit or model note, an
 * interview's completion check or, in older histories, a correction; it ends a stretch the way prose
 * does. Prose is placed before the steps of the response that wrote it, though that response's
 * message is committed only after its tools ran.
 *
 * A group's `usage` is what the responses whose tools it holds cost. A response that wrote prose or
 * only reasoned, and a call outside any response (a compaction, the completion judge, the skill
 * check), count toward the run's usage alone. Null when no call is the group's own.
 */
export type RunSegment =
  | { kind: 'text'; text: string }
  | { kind: 'steps'; tally: Tally; events: DebugEvent[]; usage: Usage | null }
  | { kind: 'reasoning'; events: DebugEvent[] }
  | { kind: 'notice'; notice: RunNotice };

/**
 * What the agent is doing at this moment, read off the last event: reasoning, writing a message,
 * or running commands. Meaningful only while the run is live; it says nothing about a finished run.
 */
type RunActivity = 'thinking' | 'writing' | 'working' | null;

/**
 * What was attached to a request besides its words: the element picked on the page, the blocks
 * placed, the files and clips brought along. Read from the same `ui_metadata` the chat panel
 * reads, so a request is marked up here exactly as it is in the workspace.
 */
export interface RunContext {
  focusContext?: { domPath: string; snippet: string };
  semanticBlocks?: Array<{ name: string; domPath: string; position: string; description: string }>;
  attachedFiles?: Array<{ name: string }>;
  /** Image and audio blocks, as they appear in the message content. */
  contentBlocks?: ContentBlock[];
}

export interface Run {
  /** The user message's event id, stable for keying a list. */
  id: string;
  /** The person's own words. */
  request: string;
  /** What came with them. */
  context: RunContext;
  /** What happened, in order. */
  segments: RunSegment[];
  activity: RunActivity;
  /** The checkpoint written when this run finished, if it finished. */
  checkpointId: string | null;
  /** The gated command a waiting run is stopped on, with its command line. Null unless the run is waiting. */
  approval: { gateKey: string; capabilityLabel: string; command: string | null } | null;
  /** The provider stop the run ended on, for the card that offers a way on. */
  stopped: { id: string; data: StoppedData } | null;
  /** All of the run's model calls: the transcript's usage line. Null before the first call. */
  usage: RunUsage | null;
  /**
   * The run's own account of what it did, from its last `status --done`, for a finished run whose
   * last segment is not prose: what was done, the task it was for, what remains.
   */
  closing: { text: string; task: string; remaining: string } | null;
  /** The tool call the model is writing right now, before it runs. Null when none is. */
  forming: FormingStep | null;
  /** The question the run ended on, from `ask`, with the answers it offered. */
  ask: { prompt: string | null; options: string[] } | null;
  /** The error the run ended on, in its own words. */
  error: { message: string; stack: string } | null;
  tally: Tally;
}

/** The text of a message whose content may be a string or content blocks. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('\n');
}

interface Message {
  role?: unknown;
  content?: unknown;
  reasoning_details?: unknown;
  ui_metadata?: {
    displayContent?: unknown;
    isSyntheticError?: unknown;
    focusContext?: RunContext['focusContext'];
    semanticBlocks?: RunContext['semanticBlocks'];
    attachedFiles?: RunContext['attachedFiles'];
  };
}

/** The context marking of a request, or an empty one when it came with nothing. */
function requestContext(message: Message): RunContext {
  const meta = message.ui_metadata;
  const content = meta?.displayContent ?? message.content;
  const blocks = Array.isArray(content)
    ? content.filter((b): b is ContentBlock =>
        typeof b === 'object' && b !== null
        && ((b as { type?: unknown }).type === 'image_url' || (b as { type?: unknown }).type === 'input_audio'))
    : [];
  return {
    ...(meta?.focusContext ? { focusContext: meta.focusContext } : {}),
    ...(meta?.semanticBlocks?.length ? { semanticBlocks: meta.semanticBlocks } : {}),
    ...(meta?.attachedFiles?.length ? { attachedFiles: meta.attachedFiles } : {}),
    ...(blocks.length ? { contentBlocks: blocks } : {}),
  };
}

function messageOf(event: DebugEvent): Message | null {
  if (event.event !== 'conversation_message') return null;
  const message = (event.data as { message?: unknown } | undefined)?.message;
  return typeof message === 'object' && message !== null ? message as Message : null;
}

/**
 * Whether this user message is one the person sent.
 *
 * The harness also speaks as the user, to nudge, remind or report an error, and the client keeps
 * what the person typed apart from what was added around it. A run starts only at the former.
 */
function isPersonsRequest(message: Message): boolean {
  if (message.role !== 'user') return false;
  if (message.ui_metadata?.isSyntheticError === true) return false;
  return !isInjectedUserMessage(message.content);
}

/** The person's own words: the display copy when the client kept one, else the content. */
function requestText(message: Message): string {
  return messageText(message.ui_metadata?.displayContent ?? message.content).trim();
}

/** What the last telling event says the agent is doing. */
function activityOf(events: DebugEvent[]): RunActivity {
  for (let i = events.length - 1; i >= 0; i--) {
    switch (events[i].event) {
      case 'reasoning_start':
      case 'reasoning_delta':
        return 'thinking';
      case 'assistant_delta':
        return 'writing';
      case 'toolCalls':
      case 'tool_status':
      case 'tool_param_delta':
        return 'working';
      case 'conversation_message':
      case 'reasoning_complete':
      case 'task_complete':
      case 'stopped':
      case 'error':
        return null;
    }
  }
  return null;
}

/** One model call, as the orchestrator reported it. */
interface Call {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
}

/**
 * The call an orchestrator `usage` event reports, or null for any other usage event.
 *
 * The orchestrator's events are the ones carrying `taskTokens`; the provider adapter reports the
 * same call without it, and is left out so nothing is counted twice.
 */
function callOf(event: DebugEvent): Call | null {
  const data = (event.data ?? {}) as { taskTokens?: unknown; usage?: Record<string, unknown> };
  if (typeof data.taskTokens !== 'number' || !data.usage) return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const u = data.usage;
  return {
    promptTokens: n(u.promptTokens),
    cachedTokens: n(u.cachedTokens),
    completionTokens: n(u.completionTokens),
    reasoningTokens: n(u.reasoningTokens),
    totalTokens: n(u.totalTokens),
    cost: n(u.cost),
  };
}

/** The calls behind one part of a run, added up as the run is read. */
interface Spend {
  calls: Call[];
}

function summarize(spends: Spend[]): Usage | null {
  const calls = spends.flatMap((spend) => spend.calls);
  if (calls.length === 0) return null;
  const sum = (key: keyof Call) => calls.reduce((total, call) => total + call[key], 0);
  return {
    calls: calls.length,
    promptTokens: sum('promptTokens'),
    cachedTokens: sum('cachedTokens'),
    completionTokens: sum('completionTokens'),
    reasoningTokens: sum('reasoningTokens'),
    totalTokens: sum('totalTokens'),
    cost: sum('cost'),
  };
}

/** Whether a response's events hold any reasoning: streamed, or only on its finished message. */
function thought(events: DebugEvent[], message: Message): boolean {
  if (events.some((event) => event.event === 'reasoning_delta' && deltaText(event).trim() !== '')) return true;
  const details = Array.isArray(message.reasoning_details) ? message.reasoning_details : [];
  return details.some((detail) => typeof (detail as { text?: unknown })?.text === 'string' && (detail as { text: string }).text.trim() !== '');
}

/** The prose a streamed delta event holds so far: one fragment, or the store's coalesced `all`. */
function deltaText(event: DebugEvent): string {
  const data = (event.data ?? {}) as { all?: Array<{ text?: unknown }>; text?: unknown };
  const fragments = Array.isArray(data.all) ? data.all : [data];
  return fragments.map((fragment) => (typeof fragment?.text === 'string' ? fragment.text : '')).join('');
}

/** The command a tool call is running, from its `tool_status` arguments. */
function commandOf(event: DebugEvent): string | null {
  return toolCommand((event.data as { args?: unknown } | undefined)?.args);
}

/** The events a run ends on. */
const RUN_ENDS = new Set(['task_complete', 'stopped', 'api_stopped', 'error', 'error_paused']);

/**
 * One model response and the tools it asked for. Its spend goes to the message that came of it:
 * its prose when it wrote any, otherwise the group its tools fell in.
 */
interface Iteration {
  spend: Spend;
  /** The response has landed; calls after this are side calls (the compaction, the completion judge). */
  landed: boolean;
}

function finish(start: DebugEvent, events: DebugEvent[]): Run {
  let checkpointId: string | null = null;
  let approval: Run['approval'] = null;
  let stopped: Run['stopped'] = null;
  let ask: Run['ask'] = null;
  let error: Run['error'] = null;
  const segments: RunSegment[] = [];
  const spendsOf = new Map<RunSegment, Spend[]>();
  const claim = (segment: RunSegment, spend: Spend) => {
    const list = spendsOf.get(segment) ?? [];
    if (!list.includes(spend)) list.push(spend);
    spendsOf.set(segment, list);
  };

  // Tool activity accumulates until the model speaks or a notice lands, then folds into one steps
  // segment. A stretch that held no steps carries its events and spends into the next one.
  let stretch: DebugEvent[] = [];
  let stretchSpends: Spend[] = [];
  let iteration: Iteration | null = null;
  /** Where the current iteration's events begin in `stretch`. */
  let iterationAt = 0;
  /** The current response's prose, once it has started. */
  let prose: Extract<RunSegment, { kind: 'text' }> | null = null;
  /** Streamed prose so far in the current response, by delta event, in order. */
  let streamed = new Map<string, string>();
  const calls: Call[] = [];
  let lastUsageAt: number | null = null;
  let retrying: LimitNoticeData | null = null;
  let lastRouterModel: string | null = null;
  let statusDone: { text: string; task: string; remaining: string } | null = null;
  /**
   * The current response's tool calls that have not started running, with their arguments so far:
   * what the call was opened with, until streamed fragments arrive, which then are the arguments, as
   * the transcript reads them.
   */
  let pendingCalls = new Map<string, string>();
  let streamedArgs = new Map<string, string>();
  /** One of the current response's calls is running, so none of them is still being written. */
  let callRunning = false;

  const flush = (part: DebugEvent[], spends: Spend[]): boolean => {
    if (part.length === 0) return false;
    const tally = buildTally(part);
    if (tally.steps.length === 0) return false;
    const segment: RunSegment = { kind: 'steps', tally, events: part, usage: null };
    segments.push(segment);
    for (const spend of spends) claim(segment, spend);
    return true;
  };
  /** Fold everything so far into a group. */
  const flushAll = () => {
    if (flush(stretch, stretchSpends)) {
      stretch = [];
      stretchSpends = [];
      iterationAt = 0;
    }
  };
  /** Fold the stretch before the current response into a group, keeping the response's own events. */
  const flushBeforeIteration = () => {
    if (!iteration) return flushAll();
    const before = stretch.slice(0, iterationAt);
    const own = iteration.spend;
    if (flush(before, stretchSpends.filter((spend) => spend !== own))) {
      stretch = stretch.slice(iterationAt);
      stretchSpends = stretchSpends.includes(own) ? [own] : [];
      iterationAt = 0;
    }
  };
  /** A notice ends the stretch; one before the response lands leaves that response's events after it. */
  const pushNotice = (notice: RunNotice) => {
    if (iteration && !iteration.landed) flushBeforeIteration();
    else flushAll();
    segments.push({ kind: 'notice', notice });
  };
  const startProse = (text: string): Extract<RunSegment, { kind: 'text' }> => {
    flushBeforeIteration();
    const segment: Extract<RunSegment, { kind: 'text' }> = { kind: 'text', text };
    segments.push(segment);
    if (iteration) {
      const own = iteration.spend;
      stretchSpends = stretchSpends.filter((spend) => spend !== own);
    }
    return segment;
  };
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.event !== 'retry' && event.event !== 'waiting') retrying = null;

    switch (event.event) {
      case 'approval_required':
        if (typeof data.gateKey === 'string') {
          approval = {
            gateKey: data.gateKey,
            capabilityLabel: typeof data.capabilityLabel === 'string' ? data.capabilityLabel : data.gateKey,
            command: typeof data.command === 'string' && data.command.trim() !== '' ? data.command : null,
          };
        }
        break;
      case 'checkpoint_created':
        if (typeof data.checkpointId === 'string') checkpointId = data.checkpointId;
        break;
      case 'api_stopped':
      case 'error_paused':
        stopped = { id: event.id, data: data as StoppedData };
        break;
      case 'error':
        error = {
          message: typeof data.message === 'string' ? data.message.trim() : '',
          stack: typeof data.stack === 'string' ? data.stack.trim() : '',
        };
        break;
      case 'task_complete': {
        // A run that failed without throwing says why only here ("Exited after 3 nudge attempts").
        const why = typeof data.error === 'string' ? data.error.trim() : '';
        if (data.result === 'failed' && why !== '') {
          const before = error as Run['error'];
          if (before === null || before.message === '') error = { message: why, stack: before === null ? '' : before.stack };
        }
        break;
      }
      case 'ask': {
        const options = Array.isArray(data.options)
          ? data.options.filter((option): option is string => typeof option === 'string' && option.trim() !== '')
          : [];
        const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
        if (options.length > 0) ask = { prompt: prompt || null, options };
        break;
      }
      case 'interview_gate':
        pushNotice({ kind: 'interview', gate: data as unknown as InterviewGate });
        break;
      case 'iteration':
        pendingCalls = new Map();
        streamedArgs = new Map();
        callRunning = false;
        iteration = { spend: { calls: [] }, landed: false };
        stretchSpends.push(iteration.spend);
        iterationAt = stretch.length;
        prose = null;
        streamed = new Map();
        break;
      case 'usage': {
        const call = callOf(event);
        if (call) {
          calls.push(call);
          lastUsageAt = event.timestamp;
          // A response's own call. One outside any response counts toward the run's usage alone.
          if (iteration && !iteration.landed) iteration.spend.calls.push(call);
        }
        break;
      }
      case 'compaction': {
        pushNotice({
          kind: 'compaction',
          before: typeof data.preCompactTokens === 'number' ? data.preCompactTokens : 0,
          after: typeof data.postCompactEstimate === 'number' ? data.postCompactEstimate : 0,
        });
        continue;
      }
      case 'retry':
        // Only describes the wait it is in, as in the transcript: anything after it ends that wait.
        retrying = { kind: 'retrying', provider: typeof data.provider === 'string' ? data.provider : '', status: typeof data.status === 'number' ? data.status : 0 };
        break;
      case 'model_picked':
        pushNotice({ kind: 'limit', data: { kind: 'picked', provider: String(data.provider ?? ''), toModel: String(data.model ?? '') } });
        break;
      case 'model_resolved': {
        // OpenRouter's free router may answer with a different model; noted only when it changes.
        const model = String(data.model ?? '');
        if (model !== lastRouterModel) {
          lastRouterModel = model;
          pushNotice({ kind: 'limit', data: { kind: 'resolved', provider: String(data.provider ?? ''), toModel: model } });
        }
        break;
      }
      case 'model_switched':
        pushNotice({
          kind: 'limit',
          data: {
            kind: 'switched',
            provider: String(data.provider ?? ''),
            fromModel: String(data.fromModel ?? ''),
            toModel: String(data.toModel ?? ''),
            reason: (data.reason as LimitNoticeData['reason']) ?? 'busy',
          },
        });
        break;
      case 'assistant_delta': {
        streamed.set(event.id, deltaText(event));
        const text = [...streamed.values()].join('').trim();
        if (text === '') break;
        if (prose) prose.text = text;
        else prose = startProse(text);
        continue;
      }
      case 'toolCalls':
        for (const call of (Array.isArray(data.toolCalls) ? data.toolCalls : []) as Array<{ id?: unknown; function?: { arguments?: unknown } }>) {
          if (typeof call?.id === 'string') pendingCalls.set(call.id, typeof call.function?.arguments === 'string' ? call.function.arguments : '');
        }
        break;
      case 'tool_param_delta': {
        // A coalesced delta event holds its own fragments; a call's arguments can span several.
        const fragments = (Array.isArray(data.all) ? data.all : [data]) as Array<{ toolId?: unknown; fragment?: unknown; partialArguments?: unknown }>;
        for (const f of fragments) {
          if (typeof f?.toolId !== 'string') continue;
          const piece = typeof f.fragment === 'string' ? f.fragment : typeof f.partialArguments === 'string' ? f.partialArguments : '';
          streamedArgs.set(f.toolId, (streamedArgs.get(f.toolId) ?? '') + piece);
          if (!pendingCalls.has(f.toolId)) pendingCalls.set(f.toolId, '');
        }
        break;
      }
      case 'tool_status': {
        if (data.status === 'executing') {
          callRunning = true;
          if (typeof data.toolCallId === 'string') pendingCalls.delete(data.toolCallId);
        }
        const command = data.status === 'executing' ? commandOf(event) : null;
        const status = command ? parseStatusCommand(command) : null;
        if (status?.done) statusDone = { text: status.done, task: status.task, remaining: status.remaining };
        break;
      }
    }

    const message = messageOf(event);
    if (message?.role === 'assistant') {
      const text = messageText(message.content).trim();
      // The finished message replaces what streamed; with no stream, it goes before this
      // response's steps, which ran before the message was committed.
      if (text !== '') {
        if (prose) prose.text = text;
        else prose = startProse(text);
      }
      if (iteration) iteration.landed = true;
      // A response that ran no tools leaves its reasoning to no group: it gets its own place,
      // before the prose it led to, with the message whose reasoning a replay carries.
      const own = [...stretch.slice(iterationAt), event];
      if (thought(own, message) && buildTally(own).steps.length === 0) {
        // The steps of the responses before this one come first, as a group of their own. With
        // prose, starting it already put them there.
        if (!prose) flushBeforeIteration();
        const segment: RunSegment = { kind: 'reasoning', events: [...stretch.slice(iterationAt), event] };
        const at = prose ? segments.indexOf(prose) : -1;
        if (at === -1) segments.push(segment);
        else segments.splice(at, 0, segment);
        if (!prose && iteration) {
          const spend = iteration.spend;
          stretchSpends = stretchSpends.filter((s) => s !== spend);
        }
        stretch = stretch.slice(0, iterationAt);
        prose = null;
        streamed = new Map();
        continue;
      }
      prose = null;
      streamed = new Map();
    } else if (message?.role === 'user' && message.ui_metadata?.isSyntheticError === true) {
      pushNotice({ kind: 'correction', text: messageText(message.content).trim() });
      continue;
    }
    // The assistant's message stays with its steps too: its tool calls and reasoning are what an
    // opened group shows.
    stretch.push(event);
  }
  flushAll();
  if (retrying) pushNotice({ kind: 'limit', data: retrying });

  const tally = buildTally(events);
  const last = segments[segments.length - 1];
  let closing: Run['closing'] = null;
  if (tally.status === 'done' && last?.kind !== 'text' && statusDone) {
    closing = { text: statusDone.text, task: statusDone.task, remaining: statusDone.remaining };
  }
  for (const segment of segments) {
    if (segment.kind === 'steps') segment.usage = summarize(spendsOf.get(segment) ?? []);
  }
  const spent = summarize([{ calls }]);
  const usage = spent && { ...spent, ms: lastUsageAt === null ? 0 : Math.max(0, lastUsageAt - start.timestamp) };
  // The call being written is the newest one not yet running, while the run has not ended.
  const ended = events.some((event) => RUN_ENDS.has(event.event));
  const writingId = !ended && !callRunning ? [...pendingCalls.keys()].pop() : undefined;
  const writing = writingId !== undefined ? streamedArgs.get(writingId) ?? pendingCalls.get(writingId) : undefined;
  const forming = writing !== undefined ? describeForming(writing) : null;

  return {
    id: start.id,
    request: requestText(messageOf(start)!),
    context: requestContext(messageOf(start)!),
    segments,
    activity: activityOf(events),
    checkpointId,
    approval: tally.status === 'waiting' ? approval : null,
    stopped,
    usage,
    closing,
    forming,
    ask,
    error,
    tally,
  };
}

export function splitRuns(events: DebugEvent[]): Run[] {
  const runs: Run[] = [];
  let start: DebugEvent | null = null;
  let current: DebugEvent[] = [];

  for (const event of events) {
    const message = messageOf(event);
    if (message && isPersonsRequest(message)) {
      if (start) runs.push(finish(start, current));
      start = event;
      current = [];
      continue;
    }
    // Anything before the first request has no one to answer to and is dropped.
    if (start) current.push(event);
  }
  if (start) runs.push(finish(start, current));
  return runs;
}
