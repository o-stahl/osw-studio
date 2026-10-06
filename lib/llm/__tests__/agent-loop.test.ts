import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '../core/agent-loop';
import type {
  ProviderAdapter,
  ToolExecutor,
  ContextManager,
  ProgressReporter,
  CostTracker,
  AgentLoopConfig,
  ParsedResponse,
  ToolResult,
  ToolCall,
  ToolDef,
  Message,
  UsageInfo,
} from '../core/types';

// --- Mock factories ---

function createMockProvider(responses: ParsedResponse[]): ProviderAdapter {
  let callIndex = 0;
  return {
    call: vi.fn(async () => {
      if (callIndex >= responses.length) {
        return { content: '' };
      }
      return responses[callIndex++];
    }),
    getModel: () => 'test-model',
    getProvider: () => 'test-provider',
    supportsTools: () => true,
  };
}

function createMockExecutor(results?: Map<string, ToolResult>): ToolExecutor {
  return {
    execute: vi.fn(async (toolCall: ToolCall) => {
      if (results && results.has(toolCall.id)) {
        return results.get(toolCall.id)!;
      }
      return {
        tool_call_id: toolCall.id,
        content: 'OK',
        success: true,
      };
    }),
    getDefinitions: () => [{ name: 'bash', description: 'Run shell', parameters: {} }] as ToolDef[],
  };
}

function createMockContext(): ContextManager {
  const messages: Message[] = [];
  return {
    getMessages: () => messages,
    getSanitizedMessages: () => messages,
    setSystemPrompt: vi.fn((prompt: string) => {
      if (messages.length > 0 && messages[0].role === 'system') {
        messages[0] = { role: 'system', content: prompt };
      } else {
        messages.unshift({ role: 'system', content: prompt });
      }
    }),
    addUserMessage: vi.fn((content: string) => {
      messages.push({ role: 'user', content });
    }),
    addAssistantTurn: vi.fn((response: ParsedResponse) => {
      messages.push({
        role: 'assistant',
        content: response.content || '',
        ...(response.toolCalls?.length ? { tool_calls: response.toolCalls } : {}),
      });
    }),
    addToolResults: vi.fn((results: ToolResult[]) => {
      for (const r of results) {
        messages.push({ role: 'tool', content: r.content, tool_call_id: r.tool_call_id });
      }
    }),
    importMessages: vi.fn(),
    needsCompaction: () => false,
    compact: vi.fn(async () => undefined),
    getTokenEstimate: () => 1000,
    getCompactionCount: () => 0,
  };
}

function createMockProgress(): ProgressReporter {
  return { onEvent: vi.fn() };
}

function createMockCost(): CostTracker {
  return {
    record: vi.fn(),
    getTurnCost: () => 0,
    getTotalCost: () => 0,
    getTotalUsage: () => ({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    resetTurn: vi.fn(),
  };
}

function defaultConfig(overrides?: Partial<AgentLoopConfig>): AgentLoopConfig {
  return {
    maxIterations: 20,
    maxNudges: 2,
    maxDuplicateToolCalls: 3,
    agentType: 'orchestrator',
    isReadOnly: false,
    ...overrides,
  };
}

// --- Tests ---

describe('AgentLoop', () => {
  it('stops for the user when an incomplete status comes with a message and no work', async () => {
    // A turn with a message and no tool calls did no work and addressed the user: a question. The
    // loop used to carry on, which re-prompts the model with nothing new — one run asked which
    // company to build for, was continued, and invented a company to build a whole site for.
    const statusCall: ToolCall = {
      id: 'tc1',
      type: 'function',
      function: {
        name: 'bash',
        arguments:
          '{"command":"status --task \\"Understand a company\\" --done \\"asked which company\\" --remaining \\"awaiting the company name\\" --incomplete"}',
      },
    };

    const provider = createMockProvider([
      { content: '', toolCalls: [statusCall] },
      { content: 'Which company would you like me to build a site for?' },
      { content: 'No name came through, so I will invent one.' },
    ]);

    const results = new Map([
      [
        'tc1',
        {
          tool_call_id: 'tc1',
          content: 'Status recorded.',
          success: true,
          signals: {
            statusResult: {
              task: 'Understand a company',
              done: 'asked which company',
              remaining: 'awaiting the company name',
              complete: false,
              hasExplicitFlag: true,
            },
          },
        } as ToolResult,
      ],
    ]);

    const loop = new AgentLoop({
      config: defaultConfig(),
      provider,
      executor: createMockExecutor(results),
      context: createMockContext(),
      progress: createMockProgress(),
      cost: createMockCost(),
    });

    const result = await loop.run('Understand a company');

    expect(result.exitReason).toBe('awaiting_user');
    // The third response is the invention. Stopping means it is never requested.
    expect(provider.call).toHaveBeenCalledTimes(2);
  });

  it('keeps working when an incomplete status carries no message', async () => {
    // Reporting progress mid-task is not a hand-back: there is nothing addressed to the user, so
    // the run must not stall waiting for input it does not need.
    const statusCall: ToolCall = {
      id: 'tc1',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"status --remaining \\"more to do\\" --incomplete"}' },
    };
    const doneCall: ToolCall = {
      id: 'tc2',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"status --remaining \\"none\\" --complete"}' },
    };

    const provider = createMockProvider([
      { content: '', toolCalls: [statusCall] },
      { content: '' },
      { content: '', toolCalls: [doneCall] },
      { content: 'Finished.' },
    ]);

    const results = new Map([
      ['tc1', { tool_call_id: 'tc1', content: 'Status recorded.', success: true,
        signals: { statusResult: { task: 't', done: 'd', remaining: 'more to do', complete: false, hasExplicitFlag: true } } } as ToolResult],
      ['tc2', { tool_call_id: 'tc2', content: 'Status recorded.', success: true,
        signals: { statusComplete: true, statusResult: { task: 't', done: 'd', remaining: 'none', complete: true, hasExplicitFlag: true } } } as ToolResult],
    ]);

    const loop = new AgentLoop({
      config: defaultConfig(),
      provider,
      executor: createMockExecutor(results),
      context: createMockContext(),
      progress: createMockProgress(),
      cost: createMockCost(),
    });

    const result = await loop.run('Do the thing');

    // Ran to completion rather than stalling: the incomplete status carried the run forward.
    expect(result.exitReason).toBe('status_complete_post_tool');
  });

  it('completes when model returns statusComplete signal', async () => {
    // 1. Provider returns a tool call, 2. Provider returns text (after status signal)
    const toolCall: ToolCall = {
      id: 'tc1',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"status --task \\"build site\\" --done \\"all\\" --remaining \\"none\\" --complete"}' },
    };

    const provider = createMockProvider([
      { content: '', toolCalls: [toolCall] },
      { content: 'All done!' },
    ]);

    const toolResult: ToolResult = {
      tool_call_id: 'tc1',
      content: 'Status recorded.',
      success: true,
      signals: { statusComplete: true, statusResult: { task: 'build site', done: 'all', remaining: 'none', complete: true, hasExplicitFlag: true } },
    };
    const results = new Map([['tc1', toolResult]]);
    const executor = createMockExecutor(results);
    const context = createMockContext();
    const progress = createMockProgress();
    const cost = createMockCost();
    const config = defaultConfig();

    const loop = new AgentLoop({
      config,
      provider,
      executor,
      context,
      progress,
      cost,
    });

    const result = await loop.run('Build me a site');
    expect(result.success).toBe(true);
    expect(result.toolCount).toBe(1);
    expect(result.turnCount).toBeGreaterThanOrEqual(1);
  });

  it('stops after maxNudges when model returns text without tool calls', async () => {
    // Model always returns text, never tools — should nudge then stop
    const provider = createMockProvider([
      { content: 'Let me think about that...' },
      { content: 'Still thinking...' },
      { content: 'Almost there...' },
      { content: 'One more thought...' },
      { content: 'Final thought.' },
    ]);

    const context = createMockContext();
    const progress = createMockProgress();
    const cost = createMockCost();
    const config = defaultConfig({ maxNudges: 2 });

    const loop = new AgentLoop({
      config,
      provider,
      executor: createMockExecutor(),
      context,
      progress,
      cost,
    });

    const result = await loop.run('Do something');
    // First response = text, nudge 1, second response = text, nudge 2, third response = text, break
    expect(result.success).toBe(false);
    expect(result.summary).toContain('nudge');
  });

  it('nudges toward bash and retries when the model calls a non-bash tool (stream early-aborted)', async () => {
    const statusTool: ToolCall = {
      id: 'tc1',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"status --task \\"x\\" --done \\"y\\" --remaining \\"none\\" --complete"}' },
    };
    // 1) stream aborted on a 'cat' tool name, 2) retry uses bash correctly and completes
    const provider = createMockProvider([
      { invalidToolName: 'cat' },
      { content: '', toolCalls: [statusTool] },
      { content: 'done' },
    ]);
    const results = new Map([['tc1', {
      tool_call_id: 'tc1',
      content: 'Status recorded.',
      success: true,
      signals: { statusComplete: true, statusResult: { task: 'x', done: 'y', remaining: 'none', complete: true, hasExplicitFlag: true } },
    } as ToolResult]]);
    const context = createMockContext();
    const progress = createMockProgress();

    const loop = new AgentLoop({
      config: defaultConfig(),
      provider,
      executor: createMockExecutor(results),
      context,
      progress,
      cost: createMockCost(),
    });

    const result = await loop.run('do it');

    expect(progress.onEvent).toHaveBeenCalledWith('malformed_tool_call', expect.objectContaining({ invalidToolName: 'cat' }));
    const nudges = (context.addUserMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
    expect(nudges.some((m) => m.includes('cat') && m.includes('bash'))).toBe(true);
    expect(result.success).toBe(true);
  });

  it('stops (does not loop forever) when the model keeps calling a non-bash tool', async () => {
    const provider = createMockProvider(Array.from({ length: 8 }, () => ({ invalidToolName: 'cat' } as ParsedResponse)));
    const progress = createMockProgress();

    const loop = new AgentLoop({
      config: defaultConfig({ maxNudges: 2 }),
      provider,
      executor: createMockExecutor(),
      context: createMockContext(),
      progress,
      cost: createMockCost(),
    });

    const result = await loop.run('do it');
    expect(result.success).toBe(false);
    // The wrong-tool nudge fired (capped at MAX_MALFORMED_RETRIES) before falling through.
    const malformed = (progress.onEvent as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === 'malformed_tool_call');
    expect(malformed.length).toBeGreaterThanOrEqual(2);
  });

  it('interview agent pauses (awaiting_user) on a prose question instead of nudging', async () => {
    // A prose question is content with no tool call and no status — the
    // interview must hand control back to the user, not nudge toward completion.
    const provider = createMockProvider([
      { content: "What's your company's name?" },
    ]);
    const loop = new AgentLoop({
      config: defaultConfig({ agentType: 'interview' }),
      provider,
      executor: createMockExecutor(),
      context: createMockContext(),
      progress: createMockProgress(),
      cost: createMockCost(),
    });

    const result = await loop.run('Understand a company');
    expect(result.exitReason).toBe('awaiting_user');
    expect(result.success).toBe(true);
  });

  it('interview agent does not pause on a reasoning-only turn (no user-facing content)', async () => {
    // Reasoning without content is not a question — it should retry/nudge, not pause.
    const provider = createMockProvider([
      { reasoningDetails: [{ type: 'reasoning.text', text: 'thinking' }] as ParsedResponse['reasoningDetails'] },
    ]);
    const loop = new AgentLoop({
      config: defaultConfig({ agentType: 'interview', maxNudges: 1 }),
      provider,
      executor: createMockExecutor(),
      context: createMockContext(),
      progress: createMockProgress(),
      cost: createMockCost(),
    });

    const result = await loop.run('Understand a company');
    expect(result.exitReason).not.toBe('awaiting_user');
  });

  it('detects duplicate tool calls and stops after maxDuplicateToolCalls', async () => {
    const duplicateCall: ToolCall = {
      id: 'tc-dup',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"ls"}' },
    };

    // Same tool call repeated multiple times
    const provider = createMockProvider([
      { content: '', toolCalls: [{ ...duplicateCall, id: 'tc1' }] },
      { content: '', toolCalls: [{ ...duplicateCall, id: 'tc2' }] },
      { content: '', toolCalls: [{ ...duplicateCall, id: 'tc3' }] },
      { content: '', toolCalls: [{ ...duplicateCall, id: 'tc4' }] },
    ]);

    const context = createMockContext();
    const progress = createMockProgress();
    const cost = createMockCost();
    const config = defaultConfig({ maxDuplicateToolCalls: 3 });

    const loop = new AgentLoop({
      config,
      provider,
      executor: createMockExecutor(),
      context,
      progress,
      cost,
    });

    const result = await loop.run('Do the thing');
    expect(result.success).toBe(false);
    expect(result.summary).toContain('loop');
  });

  it('calls completionGate before accepting completion', async () => {
    let gateCallCount = 0;
    const completionGate = vi.fn(async () => {
      gateCallCount++;
      // First call returns error (blocks completion), second returns null (allows it)
      if (gateCallCount === 1) return 'Runtime error: undefined is not a function';
      return null;
    });

    // Use different command strings so they don't trigger duplicate detection
    const toolCall1: ToolCall = {
      id: 'tc1',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"status --task \\"build\\" --done \\"all\\" --remaining \\"none\\" --complete"}' },
    };
    const toolCall2: ToolCall = {
      id: 'tc2',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"status --task \\"build site\\" --done \\"everything\\" --remaining \\"none\\" --complete"}' },
    };

    const toolResult1: ToolResult = {
      tool_call_id: 'tc1',
      content: 'Status recorded.',
      success: true,
      signals: { statusComplete: true, statusResult: { task: 'build', done: 'all', remaining: 'none', complete: true, hasExplicitFlag: true } },
    };
    const toolResult2: ToolResult = {
      tool_call_id: 'tc2',
      content: 'Status recorded.',
      success: true,
      signals: { statusComplete: true, statusResult: { task: 'build site', done: 'everything', remaining: 'none', complete: true, hasExplicitFlag: true } },
    };

    // First iteration: tool call with statusComplete. Gate blocks.
    // Second iteration: different tool call with statusComplete. Gate allows.
    const provider = createMockProvider([
      { content: '', toolCalls: [toolCall1] },
      { content: '', toolCalls: [toolCall2] },
    ]);

    const results = new Map([
      ['tc1', toolResult1],
      ['tc2', toolResult2],
    ]);
    const executor = createMockExecutor(results);
    const context = createMockContext();
    const progress = createMockProgress();
    const cost = createMockCost();
    const config = defaultConfig({ completionGate });

    const loop = new AgentLoop({
      config,
      provider,
      executor,
      context,
      progress,
      cost,
    });

    const result = await loop.run('Build it');
    expect(completionGate).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  });

  it('resends without feedback when onProviderError answers retry', async () => {
    // A provider failure says nothing about the model's approach, so the model is not told to try
    // something different; the same request just goes out again.
    let callCount = 0;
    const provider: ProviderAdapter = {
      call: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('Model busy');
        return {
          content: '',
          toolCalls: [{
            id: 'tc1',
            type: 'function' as const,
            function: { name: 'bash', arguments: '{"command":"status --task \\"x\\" --done \\"x\\" --remaining \\"none\\" --complete"}' },
          }],
        };
      }),
      getModel: () => 'test-model',
      getProvider: () => 'test-provider',
      supportsTools: () => true,
    };
    const toolResult: ToolResult = {
      tool_call_id: 'tc1',
      content: 'Status recorded.',
      success: true,
      signals: { statusComplete: true, statusResult: { task: 'x', done: 'x', remaining: 'none', complete: true, hasExplicitFlag: true } },
    };
    const context = createMockContext();
    const loop = new AgentLoop({
      config: defaultConfig({ onProviderError: vi.fn(async () => 'retry' as const) }),
      provider,
      executor: createMockExecutor(new Map([['tc1', toolResult]])),
      context,
      progress: createMockProgress(),
      cost: createMockCost(),
    });

    const result = await loop.run('Do it');
    expect(result.success).toBe(true);
    expect(callCount).toBe(2);
    const added = (context.addUserMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(added.some((m) => m.includes('Model busy'))).toBe(false);
  });

  it('explore agent exits immediately without needing status', async () => {
    const provider = createMockProvider([
      { content: 'Here is the analysis of the codebase...' },
    ]);

    const context = createMockContext();
    const progress = createMockProgress();
    const cost = createMockCost();
    const config = defaultConfig({ agentType: 'explore' });

    const loop = new AgentLoop({
      config,
      provider,
      executor: createMockExecutor(),
      context,
      progress,
      cost,
    });

    const result = await loop.run('Analyze this');
    expect(result.success).toBe(true);
    expect(result.turnCount).toBe(1);
    // Should not have nudged — immediate exit
    const events = (progress.onEvent as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    expect(events).not.toContain('nudge');
  });

  it('handles onProviderError returning stop', async () => {
    const provider: ProviderAdapter = {
      call: vi.fn(async () => {
        throw new Error('Fatal error');
      }),
      getModel: () => 'test-model',
      getProvider: () => 'test-provider',
      supportsTools: () => true,
    };

    const onProviderError = vi.fn(async () => 'stop' as const);
    const context = createMockContext();
    const progress = createMockProgress();
    const cost = createMockCost();
    const config = defaultConfig({ onProviderError });

    const loop = new AgentLoop({
      config,
      provider,
      executor: createMockExecutor(),
      context,
      progress,
      cost,
    });

    const result = await loop.run('Do it');
    expect(onProviderError).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.summary).toContain('error');
  });

  it('extracts tool calls from text for models without native tool support', async () => {
    const provider: ProviderAdapter = {
      call: vi.fn(async () => ({
        content: '```bash\nls -la\n```',
        toolCalls: undefined,
      })),
      getModel: () => 'test-model',
      getProvider: () => 'test-provider',
      supportsTools: () => false, // no native tool support
    };

    // After extraction, the tool call signals complete
    const executor: ToolExecutor = {
      execute: vi.fn(async (toolCall: ToolCall) => ({
        tool_call_id: toolCall.id,
        content: 'files listed',
        success: true,
        signals: { statusComplete: true, statusResult: { task: 'x', done: 'x', remaining: 'none', complete: true, hasExplicitFlag: true } },
      })),
      getDefinitions: () => [{ name: 'bash', description: 'Run shell', parameters: {} }],
    };

    const context = createMockContext();
    const progress = createMockProgress();
    const cost = createMockCost();
    const config = defaultConfig();

    const loop = new AgentLoop({
      config,
      provider,
      executor,
      context,
      progress,
      cost,
    });

    const result = await loop.run('List files');
    expect(executor.execute).toHaveBeenCalled();
    expect(result.toolCount).toBe(1);
  });

  it('stops when stop() is called', async () => {
    let callCount = 0;
    const provider: ProviderAdapter = {
      call: vi.fn(async () => {
        callCount++;
        return {
          content: '',
          toolCalls: [{
            id: `tc${callCount}`,
            type: 'function' as const,
            function: { name: 'bash', arguments: `{"command":"echo ${callCount}"}` },
          }],
        };
      }),
      getModel: () => 'test-model',
      getProvider: () => 'test-provider',
      supportsTools: () => true,
    };

    const context = createMockContext();
    const progress = createMockProgress();
    const cost = createMockCost();
    const config = defaultConfig();

    const loop = new AgentLoop({
      config,
      provider,
      executor: createMockExecutor(),
      context,
      progress,
      cost,
    });

    // Stop after first iteration
    (provider.call as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (callCount > 0) loop.stop();
      callCount++;
      return {
        content: '',
        toolCalls: [{
          id: `tc${callCount}`,
          type: 'function' as const,
          function: { name: 'bash', arguments: `{"command":"echo ${callCount}"}` },
        }],
      };
    });

    const result = await loop.run('Do something');
    expect(result.success).toBe(false);
    expect(result.summary).toContain('Stopped');
  });

  it('triggers compaction using token estimate when provider reports no usage', async () => {
    const toolCall: ToolCall = {
      id: 'tc1',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"status --task \\"t\\" --done \\"d\\" --remaining \\"none\\" --complete"}' },
    };
    // Provider returns no usage (simulating providers that don't support stream_options)
    const provider = createMockProvider([
      { content: '', toolCalls: [toolCall] },
      { content: 'Done.' },
    ]);

    const context = createMockContext();
    // getTokenEstimate returns a value above threshold — should trigger compaction
    context.getTokenEstimate = () => 999999;
    context.needsCompaction = (tokenCount: number) => tokenCount >= 80000;

    const toolResult: ToolResult = {
      tool_call_id: 'tc1',
      content: 'Status recorded.',
      success: true,
      signals: { statusComplete: true, statusResult: { task: 't', done: 'd', remaining: 'none', complete: true, hasExplicitFlag: true } },
    };
    const executor = createMockExecutor(new Map([['tc1', toolResult]]));
    const progress = createMockProgress();
    // promptTokens=0 simulates missing usage
    const cost = createMockCost();

    const loop = new AgentLoop({
      config: defaultConfig(),
      provider,
      executor,
      context,
      progress,
      cost,
    });

    await loop.run('Build something');
    expect(context.compact).toHaveBeenCalled();
  });

  it('uses reported promptTokens for compaction check when available', async () => {
    const toolCall: ToolCall = {
      id: 'tc1',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"status --task \\"t\\" --done \\"d\\" --remaining \\"none\\" --complete"}' },
    };
    const provider = createMockProvider([
      { content: '', toolCalls: [toolCall], usage: { promptTokens: 90000, completionTokens: 500, totalTokens: 90500 } },
      { content: 'Done.' },
    ]);

    const context = createMockContext();
    context.getTokenEstimate = () => 5000; // Low estimate — should NOT be used
    context.needsCompaction = (tokenCount: number) => tokenCount >= 80000;

    const toolResult: ToolResult = {
      tool_call_id: 'tc1',
      content: 'ok',
      success: true,
      signals: { statusComplete: true, statusResult: { task: 't', done: 'd', remaining: 'none', complete: true, hasExplicitFlag: true } },
    };
    const executor = createMockExecutor(new Map([['tc1', toolResult]]));
    const progress = createMockProgress();
    const cost = createMockCost();
    cost.getTotalUsage = () => ({ promptTokens: 90000, completionTokens: 500, totalTokens: 90500 });

    const loop = new AgentLoop({
      config: defaultConfig(),
      provider,
      executor,
      context,
      progress,
      cost,
    });

    await loop.run('Build something');
    expect(context.compact).toHaveBeenCalled();
  });

  it('does not compact when both promptTokens and estimate are below threshold', async () => {
    const toolCall: ToolCall = {
      id: 'tc1',
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"status --task \\"t\\" --done \\"d\\" --remaining \\"none\\" --complete"}' },
    };
    const provider = createMockProvider([
      { content: '', toolCalls: [toolCall] },
      { content: 'Done.' },
    ]);

    const context = createMockContext();
    context.getTokenEstimate = () => 5000;
    context.needsCompaction = (tokenCount: number) => tokenCount >= 80000;

    const toolResult: ToolResult = {
      tool_call_id: 'tc1',
      content: 'ok',
      success: true,
      signals: { statusComplete: true, statusResult: { task: 't', done: 'd', remaining: 'none', complete: true, hasExplicitFlag: true } },
    };
    const executor = createMockExecutor(new Map([['tc1', toolResult]]));
    const progress = createMockProgress();
    const cost = createMockCost();

    const loop = new AgentLoop({
      config: defaultConfig(),
      provider,
      executor,
      context,
      progress,
      cost,
    });

    await loop.run('Build something');
    expect(context.compact).not.toHaveBeenCalled();
  });
});

describe('AgentLoop history integrity and retry safeguards', () => {
  const statusToolCall = (id: string): ToolCall => ({
    id,
    type: 'function',
    function: { name: 'bash', arguments: '{"command":"status --task \\"t\\" --done \\"d\\" --remaining \\"none\\" --complete"}' },
  });
  const statusResultFor = (id: string): ToolResult => ({
    tool_call_id: id,
    content: 'ok',
    success: true,
    signals: { statusComplete: true, statusResult: { task: 't', done: 'd', remaining: 'none', complete: true, hasExplicitFlag: true } },
  });

  it('sends sanitized messages (orphan repair) to the provider', async () => {
    const sanitized: Message[] = [{ role: 'user', content: 'SANITIZED' }];
    const context = createMockContext();
    context.getSanitizedMessages = () => sanitized;
    const provider = createMockProvider([{ content: 'findings' }]);

    const loop = new AgentLoop({
      config: defaultConfig({ agentType: 'explore' }),
      provider,
      executor: createMockExecutor(),
      context,
      progress: createMockProgress(),
      cost: createMockCost(),
    });
    await loop.run('hi');

    const sentMessages = (provider.call as ReturnType<typeof vi.fn>).mock.calls[0][0].messages;
    expect(sentMessages).toBe(sanitized);
  });

  it('uses its own last response promptTokens for compaction, not the shared cost tracker', async () => {
    // Shared tracker reports a small (child-contaminated) value; this loop's own
    // response reported 90000 prompt tokens — compaction must use 90000.
    const provider = createMockProvider([
      { content: '', toolCalls: [statusToolCall('tc1')], usage: { promptTokens: 90000, completionTokens: 500, totalTokens: 90500 } },
      { content: 'Done.' },
    ]);
    const context = createMockContext();
    context.getTokenEstimate = () => 5000;
    const needsCompaction = vi.fn((tokenCount: number) => tokenCount >= 80000);
    context.needsCompaction = needsCompaction;

    const cost = createMockCost();
    cost.getTotalUsage = () => ({ promptTokens: 50, completionTokens: 0, totalTokens: 50 });

    const loop = new AgentLoop({
      config: defaultConfig(),
      provider,
      executor: createMockExecutor(new Map([['tc1', statusResultFor('tc1')]])),
      context,
      progress: createMockProgress(),
      cost,
    });
    await loop.run('Build something');

    expect(needsCompaction).toHaveBeenCalledWith(90000);
    expect(context.compact).toHaveBeenCalled();
  });

  it('commits executed tool results to context before terminating on loop detection', async () => {
    const dup = (id: string): ToolCall => ({
      id,
      type: 'function',
      function: { name: 'bash', arguments: '{"command":"ls"}' },
    });
    // One batch: first call executes, the next 3 identical calls trip the
    // duplicate cap (maxDuplicateToolCalls: 3) mid-batch.
    const provider = createMockProvider([
      { content: '', toolCalls: [dup('a'), dup('b'), dup('c'), dup('d')] },
    ]);
    const context = createMockContext();

    const loop = new AgentLoop({
      config: defaultConfig({ maxDuplicateToolCalls: 3 }),
      provider,
      executor: createMockExecutor(),
      context,
      progress: createMockProgress(),
      cost: createMockCost(),
    });
    const result = await loop.run('Do something');

    expect(result.summary).toContain('loop');
    // The assistant turn and the executed result for 'a' must be in history
    expect(context.addAssistantTurn).toHaveBeenCalledTimes(1);
    expect(context.addToolResults).toHaveBeenCalled();
    const committed = (context.addToolResults as ReturnType<typeof vi.fn>).mock.calls[0][0] as ToolResult[];
    expect(committed.some(r => r.tool_call_id === 'a' && r.success)).toBe(true);
  });

  it('passes a per-turn turnId to the tool executor context', async () => {
    const call = (id: string, cmd: string): ToolCall => ({
      id,
      type: 'function',
      function: { name: 'bash', arguments: `{"command":"${cmd}"}` },
    });
    const provider = createMockProvider([
      { content: '', toolCalls: [call('t1', 'ls')] },
      { content: '', toolCalls: [call('t2', 'status --task \\"t\\" --done \\"d\\" --remaining \\"none\\" --complete')] },
      { content: 'Done.' },
    ]);
    const turnIds: Array<number | undefined> = [];
    const executor: ToolExecutor = {
      execute: vi.fn(async (toolCall: ToolCall, ctx) => {
        turnIds.push(ctx.turnId);
        if (toolCall.id === 't2') return statusResultFor('t2');
        return { tool_call_id: toolCall.id, content: 'OK', success: true };
      }),
      getDefinitions: () => [{ name: 'bash', description: 'Run shell', parameters: {} }],
    };

    const loop = new AgentLoop({
      config: defaultConfig(),
      provider,
      executor,
      context: createMockContext(),
      progress: createMockProgress(),
      cost: createMockCost(),
    });
    await loop.run('Do something');

    expect(turnIds).toEqual([1, 2]);
  });

  it('passes its abort signal to compact()', async () => {
    const provider = createMockProvider([
      { content: '', toolCalls: [statusToolCall('tc1')], usage: { promptTokens: 90000, completionTokens: 1, totalTokens: 90001 } },
      { content: 'Done.' },
    ]);
    const context = createMockContext();
    context.needsCompaction = (tokenCount: number) => tokenCount >= 80000;

    const loop = new AgentLoop({
      config: defaultConfig(),
      provider,
      executor: createMockExecutor(new Map([['tc1', statusResultFor('tc1')]])),
      context,
      progress: createMockProgress(),
      cost: createMockCost(),
    });
    await loop.run('Build something');

    const compactOpts = (context.compact as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(compactOpts?.signal).toBeInstanceOf(AbortSignal);
  });

  it('persists reasoning-only turns and injects a targeted retry instead of the status nudge', async () => {
    const reasoningOnly = {
      content: '',
      reasoningDetails: [{ type: 'thinking', text: 'I should check index.html first.' }],
    };
    const provider = createMockProvider([
      reasoningOnly,
      { content: '', toolCalls: [statusToolCall('tc1')] },
      { content: 'Done.' },
    ]);
    const context = createMockContext();
    const progress = createMockProgress();

    const loop = new AgentLoop({
      config: defaultConfig(),
      provider,
      executor: createMockExecutor(new Map([['tc1', statusResultFor('tc1')]])),
      context,
      progress,
      cost: createMockCost(),
    });
    const result = await loop.run('Build a landing page');

    // The reasoning-only assistant turn must be persisted with its reasoning details
    const assistantTurns = (context.addAssistantTurn as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    expect(assistantTurns.some(r => r.reasoningDetails?.length && !r.content)).toBe(true);

    // The injected user message must be the targeted retry, not the status nudge
    const userMessages = (context.addUserMessage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    const retryMsg = userMessages.find((m: string) => typeof m === 'string' && m.includes('only reasoning'));
    expect(retryMsg).toBeDefined();
    expect(userMessages.some((m: string) => typeof m === 'string' && m.includes('status command'))).toBe(false);

    expect((progress.onEvent as ReturnType<typeof vi.fn>).mock.calls.some(c => c[0] === 'reasoning_only_retry')).toBe(true);
    expect(result.success).toBe(true);
  });

  it('falls back to status nudges after reasoning-only retries are exhausted', async () => {
    const reasoningOnly = () => ({
      content: '',
      reasoningDetails: [{ type: 'thinking', text: 'Thinking again from scratch.' }],
    });
    const provider = createMockProvider([
      reasoningOnly(), reasoningOnly(), reasoningOnly(), reasoningOnly(), reasoningOnly(),
    ]);
    const progress = createMockProgress();

    const loop = new AgentLoop({
      config: defaultConfig({ maxNudges: 1 }),
      provider,
      executor: createMockExecutor(),
      context: createMockContext(),
      progress,
      cost: createMockCost(),
    });
    const result = await loop.run('Build a landing page');

    const retryEvents = (progress.onEvent as ReturnType<typeof vi.fn>).mock.calls.filter(c => c[0] === 'reasoning_only_retry');
    expect(retryEvents).toHaveLength(2);
    expect(result.success).toBe(false);
    expect(result.exitReason).toBe('nudge_exhaustion');
  });

  it('keeps reasoning details on assistant turns that have content', async () => {
    const provider = createMockProvider([
      { content: 'Here is my answer.', reasoningDetails: [{ type: 'thinking', text: 'Considered options.' }] },
      { content: '', toolCalls: [statusToolCall('tc1')] },
      { content: 'Done.' },
    ]);
    const context = createMockContext();

    const loop = new AgentLoop({
      config: defaultConfig(),
      provider,
      executor: createMockExecutor(new Map([['tc1', statusResultFor('tc1')]])),
      context,
      progress: createMockProgress(),
      cost: createMockCost(),
    });
    await loop.run('Question');

    const assistantTurns = (context.addAssistantTurn as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    const withContent = assistantTurns.find(r => r.content === 'Here is my answer.');
    expect(withContent?.reasoningDetails?.length).toBe(1);
  });

  it('wraps synthetic harness messages in automated_reminder tags, but never the real user prompt', async () => {
    // Run produces: reasoning-only retry, then text-only nudges
    const provider = createMockProvider([
      { content: '', reasoningDetails: [{ type: 'thinking', text: 'hmm' }] },
      { content: 'text without status' },
      { content: 'more text' },
    ]);
    const context = createMockContext();

    const loop = new AgentLoop({
      config: defaultConfig({ maxNudges: 1 }),
      provider,
      executor: createMockExecutor(),
      context,
      progress: createMockProgress(),
      cost: createMockCost(),
    });
    await loop.run('Build a landing page');

    const userMessages = (context.addUserMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0])
      .filter((m): m is string => typeof m === 'string');

    // The real user prompt is untouched
    expect(userMessages[0]).toBe('Build a landing page');
    // Every synthetic injection is wrapped
    const synthetic = userMessages.slice(1);
    expect(synthetic.length).toBeGreaterThan(0);
    for (const msg of synthetic) {
      expect(msg.startsWith('<automated_reminder>')).toBe(true);
      expect(msg.endsWith('</automated_reminder>')).toBe(true);
    }
  });

  it('replaces large repeated tool outputs with a dedup marker', async () => {
    const bigContent = 'SKILL FILE CONTENT '.repeat(50); // ~950 chars
    const call = (id: string, cmd: string): ToolCall => ({
      id,
      type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command: cmd }) },
    });
    const provider = createMockProvider([
      { content: '', toolCalls: [call('t1', 'cat /skill.md')] },
      { content: '', toolCalls: [call('t2', 'head -n 999 /skill.md')] },
      { content: '', toolCalls: [call('t3', 'status --task "t" --done "d" --remaining "none" --complete')] },
      { content: 'Done.' },
    ]);
    const executor: ToolExecutor = {
      execute: vi.fn(async (toolCall: ToolCall) => {
        if (toolCall.id === 't3') return statusResultFor('t3');
        return { tool_call_id: toolCall.id, content: bigContent, success: true };
      }),
      getDefinitions: () => [{ name: 'bash', description: 'Run shell', parameters: {} }],
    };
    const context = createMockContext();

    const loop = new AgentLoop({
      config: defaultConfig(),
      provider,
      executor,
      context,
      progress: createMockProgress(),
      cost: createMockCost(),
    });
    await loop.run('Do something');

    const toolBatches = (context.addToolResults as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as ToolResult[]);
    // First read keeps full content
    expect(toolBatches[0][0].content).toBe(bigContent);
    // Identical repeat is replaced with a marker
    expect(toolBatches[1][0].content).not.toBe(bigContent);
    expect(toolBatches[1][0].content).toContain('identical');
    expect(toolBatches[1][0].success).toBe(true);
  });

  it('does not dedup small repeated tool outputs', async () => {
    const call = (id: string, cmd: string): ToolCall => ({
      id,
      type: 'function',
      function: { name: 'bash', arguments: JSON.stringify({ command: cmd }) },
    });
    const provider = createMockProvider([
      { content: '', toolCalls: [call('t1', 'mkdir /a')] },
      { content: '', toolCalls: [call('t2', 'mkdir /b')] },
      { content: '', toolCalls: [call('t3', 'status --task "t" --done "d" --remaining "none" --complete')] },
      { content: 'Done.' },
    ]);
    const executor: ToolExecutor = {
      execute: vi.fn(async (toolCall: ToolCall) => {
        if (toolCall.id === 't3') return statusResultFor('t3');
        return { tool_call_id: toolCall.id, content: 'Command succeeded with no output', success: true };
      }),
      getDefinitions: () => [{ name: 'bash', description: 'Run shell', parameters: {} }],
    };
    const context = createMockContext();

    const loop = new AgentLoop({
      config: defaultConfig(),
      provider,
      executor,
      context,
      progress: createMockProgress(),
      cost: createMockCost(),
    });
    await loop.run('Do something');

    const toolBatches = (context.addToolResults as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0] as ToolResult[]);
    expect(toolBatches[1][0].content).toBe('Command succeeded with no output');
  });

  it('reports the exit reason in the loop result', async () => {
    const provider = createMockProvider([
      { content: 'text only' },
      { content: 'more text' },
      { content: 'final text' },
    ]);
    const loop = new AgentLoop({
      config: defaultConfig({ maxNudges: 2 }),
      provider,
      executor: createMockExecutor(),
      context: createMockContext(),
      progress: createMockProgress(),
      cost: createMockCost(),
    });
    const result = await loop.run('Do something');
    expect(result.exitReason).toBe('nudge_exhaustion');
  });
});
