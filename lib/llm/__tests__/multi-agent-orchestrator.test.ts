import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentLoopResult, Message } from '../core/types';

// --- Hoisted state shared with module mocks ---

const h = vi.hoisted(() => {
  const okResult = {
    success: true,
    summary: 'Completed successfully (status --complete)',
    exitReason: 'status_complete',
    totalCost: 0,
    totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    toolCount: 1,
    turnCount: 1,
  };
  const orchestratorAgent = {
    type: 'orchestrator', maxIterations: 40, isReadOnly: false, tools: ['bash'], hasTool: () => true,
  };
  return {
    okResult,
    orchestratorAgent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: orchestratorAgent as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loopBehavior: { run: async (_deps: any, _prompt: unknown): Promise<any> => ({ ...okResult }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loops: [] as any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executorConfigs: [] as any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    coordinatorConfigs: [] as any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapterConfigs: [] as any[],
    localContextLength: undefined as number | undefined,
  };
});

vi.mock('../core/agent-loop', () => ({
  AgentLoop: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(deps: any) { this.deps = deps; h.loops.push(this); }
    stop = vi.fn();
    run(prompt: unknown) { return h.loopBehavior.run(this.deps, prompt); }
  },
}));

vi.mock('../tool-executor', () => ({
  OswsToolExecutor: class {
    onAfterExecute?: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(cfg: any) { h.executorConfigs.push(cfg); }
  },
}));

vi.mock('../provider-adapter', () => ({
  OswsProviderAdapter: class {
    constructor(cfg: unknown) { h.adapterConfigs.push(cfg); }
  },
  ProviderApiError: class extends Error {
    constructor(
      message: string,
      public readonly status = 0,
      public readonly errorType = 'unknown',
      public readonly errorCategory = 'unknown',
      public readonly provider = 'p',
      public readonly model = 'm',
    ) { super(message); }
  },
}));

vi.mock('../coordinator', () => ({
  MultiAgentCoordinator: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(cfg: any) { h.coordinatorConfigs.push(cfg); }
    createWrappedExecutor() {
      return { execute: async () => ({ tool_call_id: 'x', content: '', success: true }), getDefinitions: () => [] };
    }
    stop = vi.fn();
  },
}));

vi.mock('../agent', () => ({
  agentRegistry: { get: () => h.agent },
}));

vi.mock('@/lib/vfs', () => ({
  vfs: {
    listDirectory: vi.fn(async () => []),
    getServerContextMetadata: () => null,
    updateProjectCost: vi.fn(async () => undefined),
    readFile: vi.fn(async () => ({ content: '# profile' })),
  },
}));

vi.mock('@/lib/testing/judge', () => ({ runStructuredJudge: vi.fn(async () => []) }));
vi.mock('@/lib/testing/assertion-runner', () => ({ runAssertions: vi.fn(async () => []) }));

vi.mock('@/lib/vfs/checkpoint', () => ({
  checkpointManager: { createCheckpoint: vi.fn(async () => ({ id: 'cp1', timestamp: 1 })) },
}));

vi.mock('@/lib/vfs/save-manager', () => ({
  saveManager: { getSavedCheckpointId: () => null },
}));

vi.mock('@/lib/config/storage', () => ({
  configManager: {
    getSelectedProvider: () => 'openrouter',
    getProviderApiKey: () => 'key',
    getProviderModel: () => 'model-x',
    updateSessionCost: vi.fn(),
    getReasoningEnabled: () => false,
    getDebugStreamEnabled: () => false,
    getModelPricing: () => null,
    getCachedModels: () => null,
    getCompactionLimit: () => null,
    getLocalContextLength: () => h.localContextLength,
    getModelContextLengthFromCache: () => null,
    getCurrentSession: () => null,
    isWebSearchConfigured: () => false,
  },
}));

const registryMock = vi.hoisted(() => ({ usesOAuth: false, isLocal: false }));
vi.mock('@/lib/llm/providers/registry', () => ({
  getProvider: () => ({ apiKeyRequired: false, usesOAuth: registryMock.usesOAuth, isLocal: registryMock.isLocal }),
  getModelContextLength: () => 128000,
}));

vi.mock('../cost-calculator', () => ({
  CostCalculator: { calculateCost: () => 0.25 },
}));

vi.mock('../streaming-parser', () => ({
  buildFileTree: () => 'tree',
}));

vi.mock('@/lib/preview/runtime-errors', () => ({
  drainRuntimeErrors: () => [],
  formatRuntimeErrors: () => '',
  resetRuntimeErrors: vi.fn(),
}));

vi.mock('../system-prompt', () => ({
  buildSystemPrompt: vi.fn(async () => 'SYS PROMPT'),
  buildProjectContext: vi.fn(async () => 'PROJECT CTX'),
  buildCompactionPrompt: () => 'COMPACT',
}));

vi.mock('../skill-evaluator', () => ({
  evaluateRelevantSkills: vi.fn(async () => ({ skillIds: [] })),
}));

vi.mock('@/lib/vfs/skills', () => ({
  skillsService: {
    isEvaluationEnabled: async () => false,
    getEnabledSkillsMetadata: async () => [],
  },
}));

vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('@/lib/telemetry/tool-analytics', () => ({
  extractToolAnalytics: () => ({}),
  bucketInterviewTemplateId: (id: string) => id,
}));

const suggest = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rankProviderModels: vi.fn(async (..._args: any[]): Promise<any[]> => []),
  nextModelAfter: vi.fn(async () => undefined),
  alternativesTo: vi.fn(async () => []),
}));
vi.mock('../suggestions/suggest', () => suggest);
vi.mock('../suggestions/observed', async (orig) => ({ ...(await orig<object>()), recordModelOutcome: vi.fn() }));

import { MultiAgentOrchestrator, AgentMessage } from '../multi-agent-orchestrator';
import { runStructuredJudge } from '@/lib/testing/judge';
import { getInterviewTemplate } from '@/lib/interview/templates';

beforeEach(() => {
  h.loops.length = 0;
  h.executorConfigs.length = 0;
  h.coordinatorConfigs.length = 0;
  h.agent = h.orchestratorAgent;
  h.loopBehavior.run = async () => ({ ...h.okResult });
  suggest.rankProviderModels.mockClear();
  suggest.nextModelAfter.mockClear();
  suggest.alternativesTo.mockClear();
});

describe('MultiAgentOrchestrator result propagation and lifecycle', () => {
  it('propagates loop failure (success, summary, exitReason) instead of hardcoding success', async () => {
    h.loopBehavior.run = async (): Promise<AgentLoopResult> => ({
      success: false,
      summary: 'Reached maximum iterations (40)',
      exitReason: 'max_iterations',
      totalCost: 0,
      totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      toolCount: 3,
      turnCount: 5,
    });
    const orchestrator = new MultiAgentOrchestrator('test-p1');
    const result = await orchestrator.execute('build a site');

    expect(result.success).toBe(false);
    expect(result.summary).toBe('Reached maximum iterations (40)');
    expect(result.exitReason).toBe('max_iterations');
    expect(result.conversation[0].metadata.status).toBe('failed');
  });

  it('marks the conversation completed and records accumulated cost on success', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      deps.cost.record({ promptTokens: 100, completionTokens: 50, totalTokens: 150 }, 'openrouter', 'model-x');
      return { ...h.okResult };
    };
    const orchestrator = new MultiAgentOrchestrator('test-p1');
    const result = await orchestrator.execute('build a site');
    expect(result.success).toBe(true);
    expect(result.conversation[0].metadata.status).toBe('completed');
    // CostCalculator mock returns 0.25 per record() call
    expect(result.totalCost).toBe(0.25);
    expect(result.conversation[0].metadata.cost).toBe(0.25);
  });

  it('stops on a provider error and offers no plain Continue when a resend cannot help', async () => {
    // The adapter has just dropped the expired OAuth credential, so resending can only fail again.
    registryMock.usesOAuth = true;
    const { ProviderApiError } = await import('../provider-adapter');
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    let action: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      action = await deps.config.onProviderError(new ProviderApiError('expired', 401, 'auth', 'auth_expired', 'huggingface', 'm'));
      return { success: false, summary: 's', exitReason: 'error_stop', totalCost: 0, totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, toolCount: 0, turnCount: 0 };
    };
    try {
      await new MultiAgentOrchestrator('test-p1', 'orchestrator', (event, data) => events.push({ event, data: data as Record<string, unknown> })).execute('build');
    } finally {
      registryMock.usesOAuth = false;
    }
    expect(action).toBe('stop');
    expect(events.find((e) => e.event === 'api_stopped')?.data).toMatchObject({ errorCategory: 'auth_expired', canRetrySame: false });
  });

  it('stops rather than waiting on a rate limit, offering to continue', async () => {
    // A waiting task would hold a server-side run open; the thread offers Continue instead.
    const { ProviderApiError } = await import('../provider-adapter');
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    let action: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      action = await deps.config.onProviderError(new ProviderApiError('slow down', 429, 'rate_limit', 'rate_limited', 'openai', 'm'));
      return { success: false, summary: 's', exitReason: 'error_stop', totalCost: 0, totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, toolCount: 0, turnCount: 0 };
    };
    await new MultiAgentOrchestrator('test-p1', 'orchestrator', (event, data) => events.push({ event, data: data as Record<string, unknown> })).execute('build');
    expect(action).toBe('stop');
    expect(events.find((e) => e.event === 'api_stopped')?.data).toMatchObject({ errorCategory: 'rate_limited', canRetrySame: true });
  });

  it('never moves a model the user picked, even when it is busy', async () => {
    // A browser run with another free model on offer, so only the "Free models" check keeps the pick.
    vi.stubGlobal('window', {});
    suggest.rankProviderModels.mockResolvedValue([{ provider: 'openrouter', model: { id: 'a/other:free' }, coolingDown: false }]);
    const { ProviderApiError } = await import('../provider-adapter');
    const events: string[] = [];
    let action: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      action = await deps.config.onProviderError(new ProviderApiError('busy', 429, 'rate_limit', 'model_busy', 'openrouter', 'x/picked:free'));
      return { success: false, summary: 's', exitReason: 'error_stop', totalCost: 0, totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, toolCount: 0, turnCount: 0 };
    };
    const assignment = { agent: { provider: 'openrouter', model: 'x/picked:free' }, imageGen: null, voiceInput: null, autoCompact: true, compactLimit: null };
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', (event) => events.push(event), { assignment });
    try {
      await o.execute('build');
    } finally {
      vi.unstubAllGlobals();
      suggest.rankProviderModels.mockResolvedValue([]);
    }
    expect(action).toBe('stop');
    expect(events).not.toContain('model_switched');
    // @ts-expect-error private
    expect(o.getProviderConfig()).toMatchObject({ model: 'x/picked:free' });
  });

  it('emits conversation_replaced when compaction rewrites the history', async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const replacement: Message[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'compacted context' },
      { role: 'assistant', content: 'summary text', metadata: { isCompactSummary: true } },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      deps.context.onMessagesReplaced?.(replacement);
      return { ...h.okResult };
    };
    const orchestrator = new MultiAgentOrchestrator(
      'test-p1', 'orchestrator',
      (event, data) => events.push({ event, data: data as Record<string, unknown> }),
    );
    await orchestrator.execute('build');

    const replaced = events.find(e => e.event === 'conversation_replaced');
    expect(replaced).toBeDefined();
    const messages = replaced!.data?.messages as AgentMessage[];
    expect(messages).toHaveLength(3);
    expect(messages[2].ui_metadata?.isCompactSummary).toBe(true);
  });

  it('preserves the compact-summary marker when importing conversation into the context manager', async () => {
    let captured: Message[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      captured = deps.context.getMessages();
      return { ...h.okResult };
    };
    const orchestrator = new MultiAgentOrchestrator('test-p1');
    const imported: AgentMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'earlier prompt' },
      { role: 'assistant', content: 'Here is a summary of the conversation so far:\n\nstuff', ui_metadata: { isCompactSummary: true } },
    ];
    orchestrator.importConversation(imported);
    await orchestrator.execute('next step');

    expect(captured.some(m => m.metadata?.isCompactSummary)).toBe(true);
  });

  it('leaves an unanswered request out of the model\'s history when a new message replaces it', async () => {
    // A request refused before any reply stays as an instruction nobody answered; the next message
    // is the task now, and the model should not read both.
    let captured: Message[] = [];
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      captured = deps.context.getMessages();
      return { ...h.okResult };
    };
    const orchestrator = new MultiAgentOrchestrator('test-p1', 'orchestrator', (event, data) => events.push({ event, data: data as Record<string, unknown> }));
    orchestrator.importConversation([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'refused request' },
    ]);
    await orchestrator.execute('new request');

    const texts = captured.map((m) => (typeof m.content === 'string' ? m.content : ''));
    expect(texts).not.toContain('refused request');
    expect(texts).toContain('first task');
    // Saved without it, so a later run rebuilds the same history.
    const replaced = events.find((e) => e.event === 'conversation_replaced')?.data?.messages as AgentMessage[];
    expect(replaced.map((m) => m.content)).toEqual(['sys', 'first task', 'done']);
  });

  it('gives the project context again when the dropped request was the first, which carried it', async () => {
    const sent: AgentMessage[] = [];
    const orchestrator = new MultiAgentOrchestrator('test-p1', 'orchestrator', (event, data) => {
      if (event === 'conversation_message') sent.push((data as { message: AgentMessage }).message);
    });
    orchestrator.importConversation([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'PROJECT CTX\n\nrefused first request' },
    ]);
    await orchestrator.execute('new request');
    const prompt = sent.find((m) => m.role === 'user');
    expect(String(prompt?.content)).toContain('PROJECT CTX');
    expect(String(prompt?.content)).toContain('new request');
  });

  it('keeps an unanswered request when Continue picks it up', async () => {
    let captured: Message[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      captured = deps.context.getMessages();
      return { ...h.okResult };
    };
    const orchestrator = new MultiAgentOrchestrator('test-p1');
    orchestrator.importConversation([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'refused request' },
    ]);
    await orchestrator.execute('Continue the task from where you stopped.');
    expect(captured.map((m) => m.content)).toContain('refused request');
  });

  it('appends the template agenda to the interview agent system prompt', async () => {
    h.agent = { type: 'interview', maxIterations: 30, isReadOnly: false, tools: ['bash'], hasTool: () => true };
    let captured: Message[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      captured = deps.context.getMessages();
      return { ...h.okResult };
    };
    const orchestrator = new MultiAgentOrchestrator(
      'test-p1', 'interview', undefined,
      { interviewTemplateId: 'understand-company' },
    );
    await orchestrator.execute('Understand a company');

    const system = captured.find(m => m.role === 'system');
    expect(system).toBeDefined();
    const content = system!.content as string;
    expect(content).toContain('SYS PROMPT');
    expect(content).toContain('Understand a company');
    expect(content).toContain('/.interviews/company-profile.md');
  });

  it('interview completion gate passes (null) when all required items are judged complete', async () => {
    h.agent = { type: 'interview', maxIterations: 30, isReadOnly: false, tools: ['bash'], hasTool: () => true };
    const template = getInterviewTemplate('understand-company')!;
    const requiredCount = template.items.filter(i => i.required !== false).length;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runStructuredJudge as any).mockResolvedValue({
      verdicts: Array.from({ length: requiredCount }, () => ({ passed: true, reasoning: '' })),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, provider: 'openrouter', model: 'm' },
    });
    const progress = vi.fn();
    const orch = new MultiAgentOrchestrator('p', 'interview', progress, { interviewTemplateId: 'understand-company' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (orch as any).runInterviewCompletionGate(template);
    expect(result).toBeNull();
    expect(progress).toHaveBeenCalledWith('interview_gate', expect.objectContaining({
      complete: true,
      handoff: expect.objectContaining({ label: expect.any(String), prompt: expect.any(String), mode: 'code' }),
    }));
    // The judge's token usage is recorded and surfaced via a usage event.
    expect(progress).toHaveBeenCalledWith('usage', expect.objectContaining({ taskCost: expect.any(Number) }));
  });

  it('interview completion gate returns feedback naming an unmet required item', async () => {
    h.agent = { type: 'interview', maxIterations: 30, isReadOnly: false, tools: ['bash'], hasTool: () => true };
    const template = getInterviewTemplate('understand-company')!;
    const required = template.items.filter(i => i.required !== false);
    // First required item fails its judge verdict, the rest pass.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runStructuredJudge as any).mockResolvedValue({
      verdicts: required.map((_, i) => ({ passed: i !== 0, reasoning: i === 0 ? 'name missing' : '' })),
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, provider: 'openrouter', model: 'm' },
    });
    const progress = vi.fn();
    const orch = new MultiAgentOrchestrator('p', 'interview', progress, { interviewTemplateId: 'understand-company' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (orch as any).runInterviewCompletionGate(template);
    expect(result).not.toBeNull();
    expect(result).toContain(required[0].elicit);
    expect(result).toContain('name missing');
    expect(progress).toHaveBeenCalledWith('interview_gate', expect.objectContaining({ complete: false }));
  });

  it('buildCompletionGate uses an injected custom interview template (not just built-ins)', async () => {
    h.agent = { type: 'interview', maxIterations: 30, isReadOnly: false, tools: ['bash'], hasTool: () => true };
    const custom = {
      id: 'custom-x', title: 'Custom X', description: 'd',
      artifacts: [{ path: '/.interviews/custom-x.md' }],
      items: [{ id: 'q', elicit: 'Q?', completion: [{ type: 'judge', criteria: 'CUSTOM CRITERIA', description: 'q' }], required: true }],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (runStructuredJudge as any).mockResolvedValue({
      verdicts: [{ passed: true, reasoning: '' }],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, provider: 'openrouter', model: 'm' },
    });
    const progress = vi.fn();
    // With injection: gate resolves and uses the custom criteria.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const orch = new MultiAgentOrchestrator('p', 'interview', progress, { interviewTemplateId: 'custom-x', interviewTemplate: custom as any });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gate = (orch as any).buildCompletionGate();
    expect(typeof gate).toBe('function');
    await gate();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((runStructuredJudge as any)).toHaveBeenCalledWith(
      ['CUSTOM CRITERIA'],
      expect.anything(),
      expect.anything(),
    );

    // Without injection: a non-built-in id resolves to no gate.
    const orch2 = new MultiAgentOrchestrator('p', 'interview', vi.fn(), { interviewTemplateId: 'custom-x' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((orch2 as any).buildCompletionGate()).toBeUndefined();
  });

  it('does not append an agenda for the orchestrator agent', async () => {
    let captured: Message[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      captured = deps.context.getMessages();
      return { ...h.okResult };
    };
    const orchestrator = new MultiAgentOrchestrator('test-p1');
    await orchestrator.execute('build a site');

    const system = captured.find(m => m.role === 'system');
    expect(system!.content as string).toBe('SYS PROMPT');
  });

  it('wires getFreshContext and child factories into the compaction/coordinator config', async () => {
    const orchestrator = new MultiAgentOrchestrator('test-p1');
    await orchestrator.execute('build');

    expect(h.coordinatorConfigs.length).toBe(1);
    const cfg = h.coordinatorConfigs[0];
    expect(typeof cfg.createChildProvider).toBe('function');
    expect(typeof cfg.createChildExecutor).toBe('function');
    expect(typeof cfg.compactionConfig.getFreshContext).toBe('function');
    const fresh = await cfg.compactionConfig.getFreshContext();
    expect(fresh.systemPrompt).toBe('SYS PROMPT');
    expect(fresh.projectContext).toBe('PROJECT CTX');
  });

  it('moves "Free models" off OpenRouter\'s free router to a free model, even for a paid account', async () => {
    vi.stubGlobal('window', {});
    const { ProviderApiError } = await import('../provider-adapter');
    const ranked = [{ provider: 'openrouter', model: { id: 'a/model:free' }, coolingDown: false }];
    // No pick when the run starts, so requests went to the free router.
    suggest.rankProviderModels.mockResolvedValueOnce([]).mockResolvedValueOnce(ranked);
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    let action: string | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      action = await deps.config.onProviderError(new ProviderApiError('busy', 429, 'rate_limit', 'model_busy', 'openrouter', 'openrouter/free'));
      return { ...h.okResult };
    };
    const assignment = { agent: { provider: 'openrouter', model: 'osw/free-models' }, imageGen: null, voiceInput: null, autoCompact: true, compactLimit: null };
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', (event, data) => events.push({ event, data: data as Record<string, unknown> }), { assignment });
    try {
      await o.execute('build');
    } finally {
      vi.unstubAllGlobals();
    }
    expect(suggest.rankProviderModels).toHaveBeenLastCalledWith('openrouter', { freeOnly: true });
    expect(suggest.nextModelAfter).not.toHaveBeenCalled();
    expect(action).toBe('retry');
    expect(events.find((e) => e.event === 'model_switched')?.data).toMatchObject({ fromModel: 'openrouter/free', toModel: 'a/model:free' });
    // @ts-expect-error private
    expect(o.getProviderConfig()).toMatchObject({ model: 'a/model:free' });
  });

  it('adds no stopped card when the user stops while a provider error is being handled', async () => {
    const { ProviderApiError } = await import('../provider-adapter');
    const events: string[] = [];
    let action: string | undefined;
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', (event) => events.push(event));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any): Promise<AgentLoopResult> => {
      const handling = deps.config.onProviderError(new ProviderApiError('slow down', 429, 'rate_limit', 'rate_limited', 'openai', 'm'));
      o.stop();
      action = await handling;
      return { success: false, summary: 's', exitReason: 'error_stop', totalCost: 0, totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, toolCount: 0, turnCount: 0 };
    };
    await o.execute('build');
    expect(action).toBe('stop');
    expect(events).not.toContain('api_stopped');
  });

  it('resolves the agent call from the assignment, not the global provider', () => {
    const o = new MultiAgentOrchestrator('p1', 'orchestrator', () => {}, {
      assignment: { agent: { provider: 'openai', model: 'gpt-x' }, imageGen: null, voiceInput: null, autoCompact: false, compactLimit: null },
    } as any);
    // @ts-expect-error private — exercised via the seam other tests in this file use
    expect(o.getProviderConfig()).toMatchObject({ provider: 'openai', model: 'gpt-x' });
  });

  it('never sends "Free models" as a model id: it resolves to a free model, or OpenRouter\'s free router', () => {
    const o = new MultiAgentOrchestrator('p1', 'orchestrator', () => {}, {
      assignment: { agent: { provider: 'openrouter', model: 'osw/free-models' }, imageGen: null, voiceInput: null, autoCompact: false, compactLimit: null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // @ts-expect-error private
    expect(o.getProviderConfig()).toMatchObject({ provider: 'openrouter', model: 'openrouter/free' });
    // @ts-expect-error private
    o.freeModelPick = 'qwen/qwen3.8-27b:free';
    // @ts-expect-error private
    expect(o.getProviderConfig()).toMatchObject({ model: 'qwen/qwen3.8-27b:free' });
  });

  it('setAssignment updates the resolved agent on an already-constructed instance', () => {
    const o = new MultiAgentOrchestrator('p1', 'orchestrator', () => {}, {
      assignment: { agent: { provider: 'openai', model: 'gpt-x' }, imageGen: null, voiceInput: null, autoCompact: false, compactLimit: null },
    } as any);
    // @ts-expect-error private — exercised via the seam other tests in this file use
    expect(o.getProviderConfig()).toMatchObject({ provider: 'openai', model: 'gpt-x' });
    // Switching the working selection mid-session (describe-mode) must change the model used.
    o.setAssignment({ agent: { provider: 'anthropic', model: 'claude-y' }, imageGen: null, voiceInput: null, autoCompact: false, compactLimit: null });
    // @ts-expect-error private
    expect(o.getProviderConfig()).toMatchObject({ provider: 'anthropic', model: 'claude-y' });
  });

  it('resolveCompactionLimit prefers assignment.compactLimit over per-provider config', () => {
    const o = new MultiAgentOrchestrator('p1', 'orchestrator', () => {}, {
      assignment: { agent: { provider: 'openai', model: 'gpt-x' }, imageGen: null, voiceInput: null, autoCompact: true, compactLimit: 1234 },
    } as any);
    // @ts-expect-error private
    expect(o.resolveCompactionLimit()).toBe(1234);
  });

  it('sets compactionConfig.threshold to Infinity when autoCompact is false', async () => {
    const o = new MultiAgentOrchestrator('p1', 'orchestrator', () => {}, {
      assignment: { agent: { provider: 'openai', model: 'gpt-x' }, imageGen: null, voiceInput: null, autoCompact: false, compactLimit: null },
    } as any);
    await o.execute('build');

    expect(h.coordinatorConfigs.length).toBe(1);
    const cfg = h.coordinatorConfigs[0];
    expect(cfg.compactionConfig.threshold).toBe(Infinity);
  });
});

describe('local context length', () => {
  beforeEach(() => {
    h.adapterConfigs.length = 0;
    h.localContextLength = undefined;
    registryMock.isLocal = false;
  });

  it('bounds compaction and the request window to the local provider setting', async () => {
    // The registry says the model takes 128k; the local server was told to load 65,536.
    registryMock.isLocal = true;
    h.localContextLength = 65536;

    await new MultiAgentOrchestrator('test-p1').execute('build');

    expect(h.coordinatorConfigs[0].compactionConfig.contextLength).toBe(65536);
    expect(h.adapterConfigs[0].getLocalContextLength()).toBe(65536);
  });

  it('uses the default window for a local provider with nothing set', async () => {
    registryMock.isLocal = true;

    await new MultiAgentOrchestrator('test-p1').execute('build');

    expect(h.coordinatorConfigs[0].compactionConfig.contextLength).toBe(32768);
    expect(h.adapterConfigs[0].getLocalContextLength()).toBe(32768);
  });

  it('leaves a cloud provider on its model limit and sends no window', async () => {
    h.localContextLength = 65536;

    await new MultiAgentOrchestrator('test-p1').execute('build');

    expect(h.coordinatorConfigs[0].compactionConfig.contextLength).toBe(128000);
    expect(h.adapterConfigs[0].getLocalContextLength()).toBeUndefined();
  });
});
