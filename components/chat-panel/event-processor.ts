/**
 * Stateful, incremental event processor: the tool calls and streamed reasoning a run's events carry,
 * in turns.
 *
 * Two readers: `ChatPanel` counts the turns (the first-message tip, the connect chooser, the
 * suggestions, the empty state), counts the person's messages (scrolling follows the thread again
 * after one) and reads the tool calls for the large-write pacing notice; `stepDetail`
 * (`lib/quick-edit/detail.ts`) reads an opened group's calls and reasoning. The thread itself is
 * drawn from `splitRuns`.
 *
 * A turn starts at each response and at each message the person sends. Anything the agent says or
 * reports in it, a message, a notice, an error, makes the turn count without becoming an item, since
 * nothing draws those from here.
 */
import type { DebugEvent } from '@/lib/stores/types';
import { classifyCommand } from '@/lib/agent-activity/classify-command';
import { INCOMPLETE_PREFIX } from '@/lib/interview/completion';

export interface ToolCall {
  id: string;
  name: string;
  parameters?: any;
  /** `stopped`: still in flight when the run ended, so it never reported back. */
  status?: 'pending' | 'executing' | 'completed' | 'failed' | 'stopped';
  result?: any;
  error?: string;
}

export interface TurnItem {
  id: string;
  type: 'reasoning' | 'tool';
  timestamp: number;
  data: any;
  /** The `reasoning_delta` event a streamed stretch of reasoning came in. */
  eventId?: string;
  complete?: boolean;
}

export interface Turn {
  id: string;
  items: TurnItem[];
}

interface DeltaAccum {
  text: string;
  fragmentCount: number;
}

/** What else is in the current turn: none of it is an item, but each makes the turn count. */
interface TurnContent {
  /** The agent is waiting on a response; gone once something comes back. */
  waiting: boolean;
  /** A retry is waiting on the provider; gone with whatever comes next. */
  retrying: boolean;
  /** A message, a notice or an error, which stays. */
  said: boolean;
}

interface ProcessorState {
  result: Turn[];
  currentTurn: Turn;
  content: TurnContent;
  currentIterationTools: ToolCall[];
  itemIdCounter: number;
  textAccum: Map<string, DeltaAccum>;
  toolParamAccum: Map<string, DeltaAccum>;
  toolCmdCache: Map<string, string | null>;
  /** The model OpenRouter's free router last answered with in this response; only a change counts. */
  lastRouterModel: string | null;
  /** The messages the person has sent. */
  requests: number;
}

/** The command a tool call's arguments carry so far, while the model is still writing them. */
export function extractPartialCmd(raw: string): string | null {
  const match = raw.match(/^\s*\{\s*"(?:command|cmd)"\s*:\s*"((?:\\.|[^"\\])*)/);
  if (!match) return null;
  try {
    return JSON.parse('"' + match[1] + '"');
  } catch {
    return match[1] || null;
  }
}

/**
 * Whether a user-role message came from the harness rather than the person.
 *
 * Reminders, nudges and retries are sent as user messages so they steer the model, and the interview
 * gate's incomplete feedback is too; none of them are anything a person typed, so no surface renders
 * them as one. Imported by anything that cuts the stream by request.
 */
export function isInjectedUserMessage(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  return content.includes('<automated_reminder>')
    || content.includes('Before finishing, run the status command')
    || content.includes(INCOMPLETE_PREFIX);
}

function noContent(): TurnContent {
  return { waiting: false, retrying: false, said: false };
}

function freshState(): ProcessorState {
  return {
    result: [],
    currentTurn: { id: `turn-${Date.now()}`, items: [] },
    content: noContent(),
    currentIterationTools: [],
    itemIdCounter: 0,
    textAccum: new Map(),
    toolParamAccum: new Map(),
    toolCmdCache: new Map(),
    lastRouterModel: null,
    requests: 0,
  };
}

function hasContent(state: ProcessorState): boolean {
  const { waiting, retrying, said } = state.content;
  return state.currentTurn.items.length > 0 || waiting || retrying || said;
}

/** Close the current turn, when it holds anything, and start the next. */
function nextTurn(state: ProcessorState): void {
  if (!hasContent(state)) return;
  state.result.push(state.currentTurn);
  state.currentTurn = { id: `turn-${Date.now()}-${state.result.length}`, items: [] };
  state.content = noContent();
}

function turnsOf(state: ProcessorState): Turn[] {
  return [...state.result, ...(hasContent(state) ? [state.currentTurn] : [])];
}

export class EventProcessor {
  private lastProcessedEventId: string | null = null;
  private lastEventVersions = new Map<string, number>();
  private state: ProcessorState = freshState();

  /** How many messages the person has sent, in the events read so far. */
  get requests(): number {
    return this.state.requests;
  }

  process(events: DebugEvent[]): Turn[] {
    let state = this.state;

    if (events.length === 0) {
      this.lastProcessedEventId = null;
      this.lastEventVersions = new Map();
      this.state = freshState();
      return [];
    }

    // Find start index (pruning-safe)
    let startIndex = 0;
    if (this.lastProcessedEventId) {
      const idx = events.findIndex(e => e.id === this.lastProcessedEventId);
      if (idx !== -1) {
        startIndex = idx + 1;
      } else {
        this.lastEventVersions = new Map();
        state = freshState();
        this.state = state;
      }
    }

    const newEventsCount = events.length - startIndex;

    // Re-process coalesced events in lookback window
    const coalescedEvents: DebugEvent[] = [];
    const lookbackStart = Math.max(0, startIndex - 4);
    for (let i = lookbackStart; i < startIndex; i++) {
      const evt = events[i];
      if (evt.event === 'assistant_delta' || evt.event === 'tool_param_delta' || evt.event === 'reasoning_delta') {
        const storedVersion = this.lastEventVersions.get(evt.id);
        if (evt.version && storedVersion !== evt.version) {
          coalescedEvents.push(evt);
          this.lastEventVersions.set(evt.id, evt.version);
        }
      }
    }

    if (newEventsCount === 0 && coalescedEvents.length === 0) {
      return turnsOf(state);
    }

    const eventsToProcess = [
      ...coalescedEvents,
      ...events.slice(startIndex),
    ];

    const stopWaiting = () => { state.content.waiting = false; };
    const markReasoningComplete = () => {
      state.currentTurn.items.forEach(item => {
        if (item.type === 'reasoning') item.complete = true;
      });
    };

    for (const event of eventsToProcess) {
      // "Trying again" only describes the wait it is in. Whatever comes next ends that wait.
      if (event.event !== 'retry' && event.event !== 'waiting') state.content.retrying = false;
      switch (event.event) {
        case 'retry':
          state.content.retrying = true;
          break;

        case 'model_picked':
          state.content.said = true;
          break;

        case 'model_resolved': {
          // OpenRouter's free router may answer a request with a different model than the last; only
          // a change is noted.
          const model = event.data?.model ?? '';
          if (model === state.lastRouterModel) break;
          state.lastRouterModel = model;
          state.content.said = true;
          break;
        }

        case 'model_switched':
          state.content.said = true;
          stopWaiting();
          break;

        case 'waiting':
          state.content.waiting = true;
          break;

        case 'reasoning_start':
          stopWaiting();
          break;

        case 'reasoning_delta': {
          const reasoningItems = event.data?.all || [event.data];
          const accum = state.textAccum.get(event.id) || { text: '', fragmentCount: 0 };
          for (let i = accum.fragmentCount; i < reasoningItems.length; i++) {
            accum.text += reasoningItems[i]?.text || '';
          }
          accum.fragmentCount = reasoningItems.length;
          state.textAccum.set(event.id, accum);
          if (!accum.text.trim()) {
            stopWaiting();
            break;
          }
          const matchingReasoningItem = state.currentTurn.items.find(
            item => item.type === 'reasoning' && item.eventId === event.id
          );
          if (matchingReasoningItem) {
            matchingReasoningItem.data = accum.text;
          } else {
            state.currentTurn.items.push({
              id: `item-${state.itemIdCounter++}`,
              type: 'reasoning',
              timestamp: event.timestamp,
              data: accum.text,
              eventId: event.id,
            });
          }
          stopWaiting();
          break;
        }

        case 'reasoning_complete':
          markReasoningComplete();
          stopWaiting();
          break;

        case 'toolCalls': {
          markReasoningComplete();
          const calls = event.data?.toolCalls || [];
          for (const call of calls) {
            let parameters: Record<string, unknown> = {};
            try {
              parameters = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
            } catch {
              const raw = call.function?.arguments || '';
              const partialCmd = extractPartialCmd(raw);
              parameters = partialCmd !== null ? { command: partialCmd, _raw: raw } : { _raw: raw };
            }
            const tool: ToolCall = {
              id: call.id || `tool-${state.currentIterationTools.length}`,
              name: call.function?.name || 'unknown',
              parameters,
              status: 'pending',
            };
            state.currentTurn.items.push({
              id: `item-${state.itemIdCounter++}`,
              type: 'tool',
              timestamp: event.timestamp,
              data: tool,
            });
            state.currentIterationTools.push(tool);
          }
          stopWaiting();
          break;
        }

        case 'tool_status': {
          const { toolCallId, toolIndex, status, result: toolStatusResult, error, args } = event.data || {};
          // Match by toolCallId first (reliable), then by index, then by last pending/executing
          let tool: ToolCall | undefined;
          if (toolCallId) {
            tool = state.currentIterationTools.find(t => t.id === toolCallId);
          }
          if (!tool && toolIndex != null) {
            tool = state.currentIterationTools[toolIndex];
          }
          if (!tool) {
            for (let i = state.currentIterationTools.length - 1; i >= 0; i--) {
              const t = state.currentIterationTools[i];
              if (t.status === 'pending' || t.status === 'executing') { tool = t; break; }
            }
          }
          if (tool) {
            tool.status = status;
            if (toolStatusResult) tool.result = toolStatusResult;
            if (error) tool.error = error;
            if (status === 'executing') {
              if (tool.parameters?._raw && typeof tool.parameters._raw === 'string') {
                try { tool.parameters = JSON.parse(tool.parameters._raw); } catch { /* leave _raw */ }
              } else if (args && typeof args === 'string') {
                try { tool.parameters = JSON.parse(args); } catch { /* ignore */ }
              }
            }
          }
          break;
        }

        case 'tool_healed': {
          const healedTool = state.currentIterationTools[event.data?.toolIndex];
          if (healedTool) {
            healedTool.name = event.data.name || 'bash';
            if (event.data.parameters) healedTool.parameters = event.data.parameters;
          }
          break;
        }

        case 'tool_result': {
          let toolResult: ToolCall | undefined;
          if (event.data?.toolCallId) {
            toolResult = state.currentIterationTools.find(t => t.id === event.data.toolCallId);
          }
          if (!toolResult) {
            toolResult = state.currentIterationTools[event.data?.toolIndex];
          }
          if (toolResult && event.data?.result) {
            toolResult.result = event.data.result;
          }
          break;
        }

        case 'tool_param_delta': {
          const paramDeltaItems = event.data?.all || [event.data];
          const globalAccum = state.textAccum.get(event.id) || { text: '', fragmentCount: 0 };
          const seenTools = new Set<string>();
          for (let i = globalAccum.fragmentCount; i < paramDeltaItems.length; i++) {
            const { toolId, fragment, partialArguments } = paramDeltaItems[i] || {};
            if (!toolId) continue;
            const accum = state.toolParamAccum.get(toolId) || { text: '', fragmentCount: 0 };
            accum.text += fragment ?? partialArguments ?? '';
            accum.fragmentCount++;
            seenTools.add(toolId);
            state.toolParamAccum.set(toolId, accum);
          }
          globalAccum.fragmentCount = paramDeltaItems.length;
          state.textAccum.set(event.id, globalAccum);
          for (const toolId of seenTools) {
            const accum = state.toolParamAccum.get(toolId)!;
            const toolItem = state.currentTurn.items.find(
              item => item.type === 'tool' && (item.data as ToolCall)?.id === toolId
            );
            if (toolItem) {
              const tool = toolItem.data as ToolCall;
              if (!state.toolCmdCache.has(toolId) || state.toolCmdCache.get(toolId) === null) {
                state.toolCmdCache.set(toolId, extractPartialCmd(accum.text));
              }
              const cachedCmd = state.toolCmdCache.get(toolId);
              tool.parameters = cachedCmd !== null && cachedCmd !== undefined
                ? { command: cachedCmd, _raw: accum.text }
                : { _raw: accum.text };
            }
          }
          break;
        }

        case 'assistant_delta': {
          markReasoningComplete();
          const deltaItems = event.data?.all || [event.data];
          const accum = state.textAccum.get(event.id) || { text: '', fragmentCount: 0 };
          for (let i = accum.fragmentCount; i < deltaItems.length; i++) {
            accum.text += deltaItems[i]?.text || '';
          }
          accum.fragmentCount = deltaItems.length;
          state.textAccum.set(event.id, accum);
          if (accum.text.trim()) state.content.said = true;
          stopWaiting();
          break;
        }

        case 'plan_message':
        case 'ask':
        case 'approval_required':
        case 'agent_message':
        case 'task_progress':
        case 'interview_gate':
        case 'user_message':
        case 'compaction':
          state.content.said = true;
          break;

        case 'conversation_message': {
          const message = event.data?.message;
          if (message?.role === 'user') {
            if (isInjectedUserMessage(message.content)) break;
            // An error sent back to the model as the user stays in the response it interrupted.
            const isSyntheticError = message.ui_metadata?.isSyntheticError === true;
            if (!isSyntheticError) {
              nextTurn(state);
              state.lastRouterModel = null;
              state.requests++;
            }
            state.content.said = true;
          } else if (message?.role === 'assistant') {
            // Delta events aren't buffered, so on replay the finished message is the only source of
            // its tool calls.
            if (message.tool_calls?.length) {
              for (const call of message.tool_calls) {
                const existingTool = state.currentIterationTools.find(t => t.id === call.id);
                if (existingTool) {
                  // Tool already exists from toolCalls event — update parameters if empty
                  if (!existingTool.parameters?.command || existingTool.parameters.command === '') {
                    try { existingTool.parameters = JSON.parse(call.function.arguments); } catch { /* ignore */ }
                  }
                } else {
                  let parameters: Record<string, unknown> = {};
                  try { parameters = JSON.parse(call.function.arguments); } catch { parameters = { _raw: call.function.arguments }; }
                  const tool: ToolCall = {
                    id: call.id,
                    name: call.function?.name || 'unknown',
                    parameters,
                    status: 'pending',
                  };
                  state.currentTurn.items.push({
                    id: `item-${state.itemIdCounter++}`,
                    type: 'tool',
                    timestamp: event.timestamp,
                    data: tool,
                  });
                  state.currentIterationTools.push(tool);
                }
              }
            }
            const thought = (message.reasoning_details ?? []).some((detail: { text?: string }) => detail?.text?.trim());
            if (thought || message.content?.trim()) state.content.said = true;
            stopWaiting();
          } else if (message?.role === 'tool') {
            // Match tool result to its tool call
            const matchedTool = state.currentIterationTools.find(t => t.id === message.tool_call_id);
            if (matchedTool) {
              if (message.content) matchedTool.result = message.content;
              if (matchedTool.status === 'pending' || matchedTool.status === 'executing') {
                matchedTool.status = message.content?.startsWith('Error:') ? 'failed' : 'completed';
                if (matchedTool.status === 'failed') matchedTool.error = message.content;
              }
            }
          }
          break;
        }

        case 'error':
        case 'api_stopped':
        // Earlier versions paused on a provider error instead of stopping.
        case 'error_paused':
          state.content.said = true;
          stopWaiting();
          break;

        case 'usage':
          stopWaiting();
          break;

        case 'iteration':
          stopWaiting();
          nextTurn(state);
          state.currentIterationTools = [];
          break;

        case 'agent_progress': {
          const { event: innerEvent, data: innerData, agentIndex, parentToolIndex: pti } = event.data || {};
          const label = `subagent ${agentIndex || 1}`;
          let agentTool: ToolCall | undefined;
          if (typeof pti === 'number') {
            agentTool = state.currentIterationTools[pti];
          }
          if (!agentTool || classifyCommand(agentTool.parameters?.command ?? agentTool.parameters?.cmd) !== 'agent') {
            agentTool = state.currentIterationTools.find(
              t => t.status === 'executing' && classifyCommand(t.parameters?.command ?? t.parameters?.cmd) === 'agent'
            );
          }
          if (!agentTool) break;
          if (innerEvent === 'agent_start') {
            agentTool.result = `[${label}] starting...`;
          } else if (innerEvent === 'agent_done') {
            agentTool.result = `[${label}] done (${innerData?.elapsed || '?'}s)`;
          } else if (innerEvent === 'tool_status' && innerData?.status === 'executing') {
            let cmd = '';
            try { const a = JSON.parse(innerData.args || '{}'); cmd = a?.command || a?.cmd || ''; } catch { cmd = innerData.args || ''; }
            agentTool.result = `[${label}] ${cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd}`;
          }
          break;
        }

        case 'stopped':
        case 'task_complete': {
          stopWaiting();
          // A tool still in flight when the run ends never reports back; without this it spins
          // for good.
          for (const turn of [...state.result, state.currentTurn]) {
            for (const item of turn.items) {
              const tool = item.type === 'tool' ? (item.data as ToolCall) : null;
              if (tool && (tool.status === 'pending' || tool.status === 'executing')) tool.status = 'stopped';
            }
          }
          break;
        }
      }
    }

    if (newEventsCount > 0) {
      this.lastProcessedEventId = events[events.length - 1].id;
    }

    return turnsOf(state);
  }
}
