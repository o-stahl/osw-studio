/**
 * Stateful, incremental event processor that transforms DebugEvents into chat Turns.
 *
 * Extracted from the ChatPanel useMemo so the logic can be unit-tested without
 * React rendering. The ChatPanel hooks into this via process() on each render.
 */
import type { DebugEvent } from '@/lib/stores/types';

export interface ToolCall {
  id: string;
  name: string;
  parameters?: any;
  status?: 'pending' | 'executing' | 'completed' | 'failed';
  result?: any;
  error?: string;
}

export interface TurnItem {
  id: string;
  type: 'waiting' | 'reasoning' | 'plan' | 'agent' | 'progress' | 'tool' | 'text' | 'error' | 'error_paused' | 'user' | 'synthetic_error' | 'project_context' | 'compaction' | 'ask';
  timestamp: number;
  data: any;
  eventId?: string;
  complete?: boolean;
  focusContext?: { domPath: string; snippet: string };
  semanticBlocks?: Array<{ name: string; domPath: string; position: string; description: string }>;
}

export interface Turn {
  id: string;
  items: TurnItem[];
  usage?: any;
  iteration?: number;
  checkpointId?: string;
  taskStartTime?: number;
}

interface ProcessorState {
  result: Turn[];
  currentTurn: Turn;
  currentIterationTools: ToolCall[];
  itemIdCounter: number;
  taskStartTime: number;
  prevTaskCumulativeTokens: number;
  prevTaskCumulativeCost: number;
}

function extractPartialCmd(raw: string): string | null {
  const match = raw.match(/^\s*\{\s*"cmd"\s*:\s*"((?:\\.|[^"\\])*)/);
  if (!match) return null;
  try {
    return JSON.parse('"' + match[1] + '"');
  } catch {
    return match[1] || null;
  }
}

export function classifyShellCommand(cmd: string | string[] | undefined): 'shell' | 'write' | 'status' | 'delegate' {
  if (!cmd) return 'shell';
  const s = (Array.isArray(cmd) ? cmd.join(' ') : String(cmd)).trimStart();
  if (/^delegate\b/.test(s)) return 'delegate';
  if (/^status\b/.test(s)) return 'status';
  if (/^build\b/.test(s)) return 'status';
  if (/^cat\s.*>/.test(s)) return 'write';
  if (/^cat\s*>/.test(s)) return 'write';
  if (/<<-?\s*['"]?\w+/.test(s)) return 'write';
  if (/^sed\s+-i\b/.test(s)) return 'write';
  if (/^ss\b/.test(s)) return 'write';
  if (/^(mkdir|touch|rm|mv|cp)\b/.test(s)) return 'write';
  if (/^echo\b.*>>?\s*\//.test(s)) return 'write';
  return 'shell';
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
      switch (event.event) {
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
          const reasoningDeltaItems = event.data?.all || [event.data];
          const allReasoningText = reasoningDeltaItems.map((d: any) => d?.text || '').join('');
          const trimmedReasoningText = allReasoningText.trim();
          if (!trimmedReasoningText) {
            state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
            break;
          }
          let matchingReasoningItem = state.currentTurn.items.find(
            item => item.type === 'reasoning' && item.eventId === event.id
          );
          if (matchingReasoningItem) {
            matchingReasoningItem.data = allReasoningText;
          } else {
            state.currentTurn.items.push({
              id: `item-${state.itemIdCounter++}`,
              type: 'reasoning',
              timestamp: event.timestamp,
              data: allReasoningText,
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
              parameters = partialCmd !== null ? { cmd: partialCmd, _raw: raw } : { _raw: raw };
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
          const { toolIndex, status, result: toolStatusResult, error } = event.data || {};
          const tool = state.currentIterationTools[toolIndex];
          if (tool) {
            tool.status = status;
            if (toolStatusResult) tool.result = toolStatusResult;
            if (error) tool.error = error;
            if (status === 'executing' && tool.parameters?._raw && typeof tool.parameters._raw === 'string') {
              try { tool.parameters = JSON.parse(tool.parameters._raw); } catch { /* leave _raw */ }
            }
          }
          break;
        }

        case 'tool_healed': {
          const healedTool = state.currentIterationTools[event.data?.toolIndex];
          if (healedTool) {
            healedTool.name = event.data.name || 'shell';
            if (event.data.parameters) healedTool.parameters = event.data.parameters;
          }
          break;
        }

        case 'tool_result': {
          const toolResult = state.currentIterationTools[event.data?.toolIndex];
          if (toolResult && event.data?.result) {
            toolResult.result = event.data.result;
          }
          break;
        }

        case 'tool_param_delta': {
          const paramDeltaItems = event.data?.all || [event.data];
          const fragmentsByTool = new Map<string, string>();
          for (const paramDelta of paramDeltaItems) {
            const { toolId, fragment, partialArguments } = paramDelta || {};
            if (!toolId) continue;
            const text = fragment ?? partialArguments ?? '';
            fragmentsByTool.set(toolId, (fragmentsByTool.get(toolId) || '') + text);
          }
          for (const [toolId, cumulative] of fragmentsByTool) {
            const toolItem = state.currentTurn.items.find(
              item => item.type === 'tool' && (item.data as ToolCall)?.id === toolId
            );
            if (toolItem) {
              const tool = toolItem.data as ToolCall;
              try { tool.parameters = JSON.parse(cumulative); } catch {
                const partialCmd = extractPartialCmd(cumulative);
                tool.parameters = partialCmd !== null ? { cmd: partialCmd, _raw: cumulative } : { _raw: cumulative };
              }
            }
          }
          break;
        }

        case 'assistant_delta': {
          state.currentTurn.items.forEach(item => {
            if (item.type === 'reasoning') item.complete = true;
          });
          const deltaItems = event.data?.all || [event.data];
          let matchingTextItem = state.currentTurn.items.find(
            item => item.type === 'text' && item.eventId === event.id
          );
          const allText = deltaItems.map((d: any) => d?.text || '').join('');
          if (allText.trim()) {
            if (matchingTextItem) {
              matchingTextItem.data = allText;
            } else {
              state.currentTurn.items.push({
                id: `item-${state.itemIdCounter++}`,
                type: 'text',
                timestamp: event.timestamp,
                data: allText,
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

        case 'conversation_message': {
          if (event.version) this.lastEventVersions.set(event.id, event.version);
          const message = event.data?.message;
          if (message?.role === 'user') {
            if (message.content?.includes('Before finishing, run the status command')) break;
            const isSyntheticError = message.ui_metadata?.isSyntheticError === true;
            if (!isSyntheticError && state.currentTurn.items.length > 0) {
              state.result.push(state.currentTurn);
              state.currentTurn = {
                id: `turn-${Date.now()}-${state.result.length}`,
                items: [],
              };
            }
            if (!isSyntheticError) {
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
            const displayContent = message.ui_metadata?.displayContent || message.content || '';
            state.currentTurn.items.push({
              id: `item-${state.itemIdCounter++}`,
              type: isSyntheticError ? 'synthetic_error' : 'user',
              timestamp: event.timestamp,
              data: displayContent,
              focusContext: message.ui_metadata?.focusContext,
              semanticBlocks: message.ui_metadata?.semanticBlocks,
            });
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
          };
          state.currentTurn.taskStartTime = state.taskStartTime;
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
          break;

        case 'checkpoint_created':
          state.currentTurn.checkpointId = event.data?.checkpointId;
          break;

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

        case 'delegate_progress': {
          const { event: innerEvent, data: innerData, agentIndex, parentToolIndex: pti } = event.data || {};
          const label = `subagent ${agentIndex || 1}`;
          let delegateTool: ToolCall | undefined;
          if (typeof pti === 'number') {
            delegateTool = state.currentIterationTools[pti];
          }
          if (!delegateTool || classifyShellCommand(delegateTool.parameters?.cmd) !== 'delegate') {
            delegateTool = state.currentIterationTools.find(
              t => t.status === 'executing' && classifyShellCommand(t.parameters?.cmd) === 'delegate'
            );
          }
          if (!delegateTool) break;
          if (innerEvent === 'agent_start') {
            delegateTool.result = `[${label}] starting...`;
          } else if (innerEvent === 'agent_done') {
            delegateTool.result = `[${label}] done (${innerData?.elapsed || '?'}s)`;
          } else if (innerEvent === 'tool_status' && innerData?.status === 'executing') {
            let cmd = '';
            try { cmd = JSON.parse(innerData.args || '{}')?.cmd || ''; } catch { cmd = innerData.args || ''; }
            delegateTool.result = `[${label}] ${cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd}`;
          }
          break;
        }

        case 'stopped':
          state.currentTurn.items = state.currentTurn.items.filter(item => item.type !== 'waiting');
          break;
      }
    }

    if (newEventsCount > 0) {
      this.lastProcessedEventId = events[events.length - 1].id;
    }

    return [...state.result, ...(state.currentTurn.items.length > 0 ? [state.currentTurn] : [])];
  }
}
