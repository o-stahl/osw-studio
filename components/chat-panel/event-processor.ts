/**
 * Stateful, incremental event processor that transforms DebugEvents into chat Turns.
 *
 * Extracted from the ChatPanel useMemo so the logic can be unit-tested without
 * React rendering. The ChatPanel hooks into this via process() on each render.
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
  type: 'waiting' | 'reasoning' | 'plan' | 'agent' | 'progress' | 'tool' | 'text' | 'error' | 'error_paused' | 'user' | 'synthetic_error' | 'project_context' | 'compaction' | 'ask' | 'approval' | 'interview_gate' | 'notice' | 'api_stopped';
  timestamp: number;
  data: any;
  eventId?: string;
  complete?: boolean;
  focusContext?: { domPath: string; snippet: string };
  semanticBlocks?: Array<{ name: string; domPath: string; position: string; description: string }>;
  attachedFiles?: Array<{ name: string }>;
}

export interface Turn {
  id: string;
  items: TurnItem[];
  usage?: any;
  iteration?: number;
  checkpointId?: string;
  taskStartTime?: number;
}

interface DeltaAccum {
  text: string;
  fragmentCount: number;
}

interface ProcessorState {
  result: Turn[];
  currentTurn: Turn;
  currentIterationTools: ToolCall[];
  itemIdCounter: number;
  taskStartTime: number;
  prevTaskCumulativeTokens: number;
  prevTaskCumulativeCost: number;
  textAccum: Map<string, DeltaAccum>;
  toolParamAccum: Map<string, DeltaAccum>;
  toolCmdCache: Map<string, string | null>;
  /** The model OpenRouter's free router last answered with in this response, so only a change is shown. */
  lastRouterModel: string | null;
}

function extractPartialCmd(raw: string): string | null {
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
 * them as one. Kept here, beside the transcript that first needed it, and imported by anything else
 * that cuts the stream by request.
 */
export function isInjectedUserMessage(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  return content.includes('<automated_reminder>')
    || content.includes('Before finishing, run the status command')
    || content.includes(INCOMPLETE_PREFIX);
}

function freshState(): ProcessorState {
  return {
    result: [],
    currentTurn: { id: `turn-${Date.now()}`, items: [] },
    currentIterationTools: [],
    itemIdCounter: 0,
    taskStartTime: 0,
    prevTaskCumulativeTokens: 0,
    prevTaskCumulativeCost: 0,
    textAccum: new Map(),
    toolParamAccum: new Map(),
    toolCmdCache: new Map(),
    lastRouterModel: null,
  };
}

export class EventProcessor {
  private lastProcessedEventId: string | null = null;
  private lastEventVersions = new Map<string, number>();
  private state: ProcessorState = freshState();

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

    // Check if any conversation_message was updated (e.g. projectContext merged)
    let needsFullReparse = false;
    for (let i = 0; i < startIndex; i++) {
      const evt = events[i];
      if (evt.event === 'conversation_message' && evt.version) {
        const storedVersion = this.lastEventVersions.get(evt.id);
        if (storedVersion !== undefined && storedVersion !== evt.version) {
          needsFullReparse = true;
          break;
        }
      }
    }
    if (needsFullReparse) {
      this.lastEventVersions = new Map();
      state = freshState();
      this.state = state;
      startIndex = 0;
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
      return [...state.result, ...(state.currentTurn.items.length > 0 ? [state.currentTurn] : [])];
    }

    const eventsToProcess = [
      ...coalescedEvents,
      ...events.slice(startIndex),
    ];

    for (const event of eventsToProcess) {
      // "Trying again" only describes the wait it is in. Whatever comes next ends that wait.
      if (event.event !== 'retry' && event.event !== 'waiting') {
        state.currentTurn.items = state.currentTurn.items.filter(item => !(item.type === 'notice' && item.data?.kind === 'retrying'));
      }
      switch (event.event) {
        case 'retry': {
          const last = state.currentTurn.items[state.currentTurn.items.length - 1];
          const data = { kind: 'retrying', provider: event.data?.provider ?? '', status: event.data?.status ?? 0 };
          if (last?.type === 'notice' && last.data?.kind === 'retrying') last.data = data;
          else state.currentTurn.items.push({ id: `item-${state.itemIdCounter++}`, type: 'notice', timestamp: event.timestamp, data });
          break;
        }

        case 'model_picked':
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'notice',
            timestamp: event.timestamp,
            data: { kind: 'picked', provider: event.data?.provider ?? '', toModel: event.data?.model ?? '' },
          });
          break;

        case 'model_resolved': {
          // OpenRouter's free router may answer a request with a different model than the last. The
          // notice goes where that happened, and only when it did, not before every step.
          const model = event.data?.model ?? '';
          if (model === state.lastRouterModel) break;
          state.lastRouterModel = model;
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'notice',
            timestamp: event.timestamp,
            data: { kind: 'resolved', provider: event.data?.provider ?? '', toModel: model },
          });
          break;
        }

        case 'model_switched':
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'notice',
            timestamp: event.timestamp,
            data: {
              kind: 'switched',
              provider: event.data?.provider ?? '',
              fromModel: event.data?.fromModel ?? '',
              toModel: event.data?.toModel ?? '',
              reason: event.data?.reason ?? 'busy',
            },
          });
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
          break;

        case 'waiting':
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'waiting',
            timestamp: event.timestamp,
            data: null,
          });
          break;

        case 'reasoning_start':
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
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
            state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
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
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
          break;
        }

        case 'reasoning_complete':
          state.currentTurn.items.forEach(item => {
            if (item.type === 'reasoning') item.complete = true;
          });
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
          break;

        case 'toolCalls': {
          state.currentTurn.items.forEach(item => {
            if (item.type === 'reasoning') item.complete = true;
          });
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
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
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
          state.currentTurn.items.forEach(item => {
            if (item.type === 'reasoning') item.complete = true;
          });
          const deltaItems = event.data?.all || [event.data];
          const accum = state.textAccum.get(event.id) || { text: '', fragmentCount: 0 };
          for (let i = accum.fragmentCount; i < deltaItems.length; i++) {
            accum.text += deltaItems[i]?.text || '';
          }
          accum.fragmentCount = deltaItems.length;
          state.textAccum.set(event.id, accum);
          if (accum.text.trim()) {
            const matchingTextItem = state.currentTurn.items.find(
              item => item.type === 'text' && item.eventId === event.id
            );
            if (matchingTextItem) {
              matchingTextItem.data = accum.text;
            } else {
              state.currentTurn.items.push({
                id: `item-${state.itemIdCounter++}`,
                type: 'text',
                timestamp: event.timestamp,
                data: accum.text,
                eventId: event.id,
              });
            }
          }
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
          break;
        }

        case 'plan_message':
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'plan',
            timestamp: event.timestamp,
            data: event.data?.content || '',
          });
          break;

        case 'ask':
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'ask',
            timestamp: event.timestamp,
            data: {
              prompt: event.data?.prompt,
              options: Array.isArray(event.data?.options) ? event.data.options : [],
            },
          });
          break;

        case 'approval_required':
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'approval',
            timestamp: event.timestamp,
            data: {
              gateKey: event.data?.gateKey,
              command: event.data?.command,
              capabilityLabel: event.data?.capabilityLabel,
            },
          });
          break;

        case 'agent_message':
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'agent',
            timestamp: event.timestamp,
            data: event.data?.content || '',
          });
          break;

        case 'task_progress':
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'progress',
            timestamp: event.timestamp,
            data: event.data?.content || '',
          });
          break;

        case 'interview_gate':
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'interview_gate',
            timestamp: event.timestamp,
            data: event.data,
          });
          break;

        case 'conversation_message': {
          if (event.version) this.lastEventVersions.set(event.id, event.version);
          const message = event.data?.message;
          if (message?.role === 'user') {
            if (isInjectedUserMessage(message.content)) break;
            const isSyntheticError = message.ui_metadata?.isSyntheticError === true;
            if (!isSyntheticError && state.currentTurn.items.length > 0) {
              state.result.push(state.currentTurn);
              state.currentTurn = {
                id: `turn-${Date.now()}-${state.result.length}`,
                items: [],
              };
            }
            if (!isSyntheticError) {
              state.lastRouterModel = null;
              state.taskStartTime = event.timestamp;
              const lastUsageTurn = [...state.result].reverse().find(t => t.usage);
              if (lastUsageTurn?.usage) {
                state.prevTaskCumulativeTokens = lastUsageTurn.usage.totalUsage?.totalTokens || lastUsageTurn.usage.usage?.totalTokens || 0;
                state.prevTaskCumulativeCost = lastUsageTurn.usage.totalCost ?? 0;
              }
            }
            const projectContext = message.ui_metadata?.projectContext;
            if (projectContext && !isSyntheticError) {
              state.currentTurn.items.push({
                id: `item-${state.itemIdCounter++}`,
                type: 'project_context',
                timestamp: event.timestamp,
                data: projectContext,
              });
            }
            // Use ?? so an intentionally-empty displayContent (e.g. an audio-only
            // message) stays empty instead of falling back to the raw content,
            // which carries the project-context prefix.
            const displayContent = message.ui_metadata?.displayContent ?? message.content ?? '';
            state.currentTurn.items.push({
              id: `item-${state.itemIdCounter++}`,
              type: isSyntheticError ? 'synthetic_error' : 'user',
              timestamp: event.timestamp,
              data: displayContent,
              focusContext: message.ui_metadata?.focusContext,
              semanticBlocks: message.ui_metadata?.semanticBlocks,
              attachedFiles: message.ui_metadata?.attachedFiles,
            });
          } else if (message?.role === 'assistant') {
            // Reconstruct reasoning and tool calls from buffered conversation_message
            // (delta events aren't buffered, so on replay this is the only source)
            if (message.reasoning_details?.length) {
              for (const detail of message.reasoning_details) {
                if (detail.text?.trim()) {
                  const existing = state.currentTurn.items.find(
                    item => item.type === 'reasoning' && item.data === detail.text
                  );
                  if (!existing) {
                    state.currentTurn.items.push({
                      id: `item-${state.itemIdCounter++}`,
                      type: 'reasoning',
                      timestamp: event.timestamp,
                      data: detail.text,
                      complete: true,
                    });
                  }
                }
              }
            }
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
            if (message.content?.trim()) {
              // Dedup against the streamed assistant_delta text item (same
              // content already shown live). On replay there is no streamed
              // item, so this pushes fresh.
              const existingText = state.currentTurn.items.find(
                item => item.type === 'text' && item.data === message.content
              );
              if (!existingText) {
                state.currentTurn.items.push({
                  id: `item-${state.itemIdCounter++}`,
                  type: 'text',
                  timestamp: event.timestamp,
                  data: message.content,
                });
              }
            }
            state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
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

        case 'user_message':
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'user',
            timestamp: event.timestamp,
            data: event.data?.content || '',
          });
          break;

        case 'error':
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'error',
            timestamp: event.timestamp,
            data: event.data,
          });
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
          break;

        case 'api_stopped':
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'api_stopped',
            timestamp: event.timestamp,
            data: event.data,
          });
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
          break;

        // Earlier versions paused on a provider error instead of stopping. Kept so those threads
        // still render.
        case 'error_paused':
          state.currentTurn.items.push({
            id: `item-${state.itemIdCounter++}`,
            type: 'error_paused',
            timestamp: event.timestamp,
            data: event.data,
          });
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
          break;

        case 'usage':
          state.currentTurn.usage = {
            ...event.data,
            timestamp: event.timestamp,
            taskTokenOffset: state.prevTaskCumulativeTokens,
            taskCostOffset: state.prevTaskCumulativeCost,
            taskTokens: event.data.taskTokens,
            taskCost: event.data.taskCost,
          };
          state.currentTurn.taskStartTime = state.taskStartTime;
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
          break;

        case 'checkpoint_created': {
          // Restore and Retry go after the response the checkpoint closes.
          const items = state.currentTurn.items.filter((item) => item.type !== 'waiting');
          // A server run snapshots the project before it starts, while the turn holds only the
          // user's message; that snapshot stays in the checkpoints panel, not under the prompt.
          if (items.some((item) => item.type === 'user') && items.every((item) => item.type === 'user' || item.type === 'project_context')) break;
          // A run's last step opens a turn and can end without adding to it, so the checkpoint taken
          // at the end arrives on an empty turn that the next message would join. It belongs to the
          // response, which is the last turn already closed.
          if (items.length === 0) {
            // Nothing closed yet means the response is older than the events kept here; its
            // checkpoint has no place in this view, and must not land on the next prompt.
            if (state.result.length > 0) state.result[state.result.length - 1].checkpointId = event.data?.checkpointId;
            break;
          }
          state.currentTurn.checkpointId = event.data?.checkpointId;
          break;
        }

        case 'iteration':
          state.currentTurn.iteration = event.data?.iteration;
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
          if (state.currentTurn.items.length > 0) {
            state.result.push(state.currentTurn);
            state.currentTurn = {
              id: `turn-${Date.now()}-${state.result.length}`,
              items: [],
            };
          }
          state.currentIterationTools = [];
          break;

        case 'compaction':
          state.currentTurn.items.push({
            id: `compaction-${event.id}`,
            type: 'compaction',
            timestamp: event.timestamp,
            data: event.data,
          });
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
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
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

    return [...state.result, ...(state.currentTurn.items.length > 0 ? [state.currentTurn] : [])];
  }
}
