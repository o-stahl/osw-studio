import { describe, it, expect, vi } from 'vitest';
import { MultiAgentCoordinator, CoordinatorConfig } from '../coordinator';
import type {
  ProviderAdapter,
  ToolExecutor,
  ToolCall,
  ParsedResponse,
  ProgressReporter,
  CostTracker,
  CompactionConfig,
} from '../core/types';

// --- Mock factories ---

function freshProvider(responses: ParsedResponse[]): ProviderAdapter {
  let callIndex = 0;
  return {
    call: vi.fn(async () => {
      if (callIndex >= responses.length) return { content: '' };
      return responses[callIndex++];
    }),
    getModel: () => 'test-model',
    getProvider: () => 'test-provider',
    supportsTools: () => true,
  };
}

function mockExecutor(): ToolExecutor {
  return {
    execute: vi.fn(async (toolCall: ToolCall) => ({
      tool_call_id: toolCall.id,
      content: 'OK',
      success: true,
    })),
    getDefinitions: () => [{ name: 'bash', description: 'Run shell', parameters: {} }],
  };
}

const compactionConfig: CompactionConfig = {
  contextLength: 100000,
  threshold: 60000,
  recentKeepRatio: 0.2,
  summaryTokenRatio: 0.1,
  buildCompactionPrompt: () => 'summarize',
};

function mockCost(): CostTracker {
  return {
    record: vi.fn(),
    getTurnCost: () => 0,
    getTotalCost: () => 0,
    getTotalUsage: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    resetTurn: vi.fn(),
  };
}

function agentToolCall(id: string, command: string): ToolCall {
  return {
    id,
    type: 'function',
    function: { name: 'bash', arguments: JSON.stringify({ command }) },
  };
}

function buildCoordinator(overrides?: Partial<CoordinatorConfig>) {
  const rootEvents: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const rootProgress: ProgressReporter = {
    onEvent: (event, data) => rootEvents.push({ event, data }),
  };
  const config: CoordinatorConfig = {
    innerExecutor: mockExecutor(),
    provider: freshProvider([{ content: 'shared provider result' }]),
    progress: rootProgress,
    cost: mockCost(),
    projectId: 'test-project',
    chatMode: false,
    compactionConfig,
    buildSystemPrompt: async () => 'CHILD SYS',
    ...overrides,
  };
  return { coordinator: new MultiAgentCoordinator(config), rootEvents, config };
}

// --- Tests ---

describe('MultiAgentCoordinator agent dedup and child event scoping', () => {
  it('dedups identical agent calls only within the same turn', async () => {
    const { coordinator } = buildCoordinator({
      createChildProvider: () => freshProvider([{ content: 'child result' }]),
    });
    const wrapped = coordinator.createWrappedExecutor();
    const cmd = 'agent explore "find pages"';

    const first = await wrapped.execute(agentToolCall('a1', cmd), { agentType: 'orchestrator', isReadOnly: false, turnId: 1 });
    expect(first.content).toContain('child result');

    // Same turn — model emitted the call twice in one batch: dedup
    const second = await wrapped.execute(agentToolCall('a2', cmd), { agentType: 'orchestrator', isReadOnly: false, turnId: 1 });
    expect(second.content).toContain('Duplicate agent call');

    // Later turn — legitimate re-delegation must execute again
    const third = await wrapped.execute(agentToolCall('a3', cmd), { agentType: 'orchestrator', isReadOnly: false, turnId: 2 });
    expect(third.content).toContain('child result');
  });

  it('does not dedup a retry after the parallel-agent cap error', async () => {
    const { coordinator } = buildCoordinator({
      createChildProvider: () => freshProvider([{ content: 'child result' }]),
    });
    const wrapped = coordinator.createWrappedExecutor();
    const prompts = Array.from({ length: 9 }, (_, i) => `"prompt ${i}"`).join(' ');
    const cmd = `agent task ${prompts}`;

    const first = await wrapped.execute(agentToolCall('a1', cmd), { agentType: 'orchestrator', isReadOnly: false, turnId: 1 });
    expect(first.content).toContain('Too many parallel agents');

    const retry = await wrapped.execute(agentToolCall('a2', cmd), { agentType: 'orchestrator', isReadOnly: false, turnId: 1 });
    expect(retry.content).toContain('Too many parallel agents');
    expect(retry.content).not.toContain('Duplicate agent call');
  });

  it('runs at most four sub-agents at once on the free allowance, which limits requests in flight', async () => {
    const onAllowance = { ...freshProvider([]), getProvider: () => 'osws' };
    const { coordinator } = buildCoordinator({
      provider: onAllowance,
      createChildProvider: () => freshProvider([{ content: 'child result' }]),
    });
    const wrapped = coordinator.createWrappedExecutor();
    const batch = (n: number) => `agent task ${Array.from({ length: n }, (_, i) => `"prompt ${i}"`).join(' ')}`;

    const five = await wrapped.execute(agentToolCall('b1', batch(5)), { agentType: 'orchestrator', isReadOnly: false, turnId: 1 });
    expect(five.content).toContain('Too many parallel agents (5). Maximum is 4.');
    const four = await wrapped.execute(agentToolCall('b2', batch(4)), { agentType: 'orchestrator', isReadOnly: false, turnId: 2 });
    expect(four.content).not.toContain('Too many parallel agents');
  });

  it('routes child provider/executor events through the agent_progress wrapper', async () => {
    const childToolCall = agentToolCall('ct1', 'ls');
    const { coordinator, rootEvents } = buildCoordinator({
      createChildProvider: () => freshProvider([
        { content: '', toolCalls: [childToolCall] },
        { content: 'child findings' },
      ]),
      createChildExecutor: (progress: ProgressReporter) => ({
        execute: vi.fn(async (toolCall: ToolCall) => {
          progress.onEvent('tool_status', { toolCallId: toolCall.id, status: 'executing', args: toolCall.function.arguments });
          return { tool_call_id: toolCall.id, content: 'OK', success: true };
        }),
        getDefinitions: () => [{ name: 'bash', description: 'Run shell', parameters: {} }],
      }),
    });
    const wrapped = coordinator.createWrappedExecutor();

    await wrapped.execute(
      agentToolCall('a1', 'agent explore "what pages exist"'),
      { agentType: 'orchestrator', isReadOnly: false, turnId: 1 },
    );

    // The child executor's executing status must arrive wrapped in agent_progress…
    const wrappedStatuses = rootEvents.filter(
      e => e.event === 'agent_progress'
        && e.data?.event === 'tool_status'
        && (e.data?.data as Record<string, unknown>)?.status === 'executing',
    );
    expect(wrappedStatuses.length).toBe(1);
    // …and never as a bare top-level tool_status
    expect(rootEvents.some(e => e.event === 'tool_status')).toBe(false);
  });

  it('reports elapsed seconds in agent_done', async () => {
    const { coordinator, rootEvents } = buildCoordinator({
      createChildProvider: () => freshProvider([{ content: 'child result' }]),
    });
    const wrapped = coordinator.createWrappedExecutor();

    await wrapped.execute(
      agentToolCall('a1', 'agent explore "find pages"'),
      { agentType: 'orchestrator', isReadOnly: false, turnId: 1 },
    );

    const done = rootEvents.find(e => e.event === 'agent_progress' && e.data?.event === 'agent_done');
    expect(done).toBeDefined();
    expect(typeof (done!.data?.data as Record<string, unknown>)?.elapsed).toBe('number');
  });
});
