import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentLoopResult } from '../core/types';

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
      public readonly timing: { retryAfterMs?: number; resetAt?: number } = {},
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nextModelAfter: vi.fn(async (..._args: any[]): Promise<any> => undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  alternativesTo: vi.fn(async (..._args: any[]): Promise<any[]> => []),
}));
vi.mock('../suggestions/suggest', () => suggest);
const observed = vi.hoisted(() => ({ recordModelOutcome: vi.fn() }));
vi.mock('../suggestions/observed', async (orig) => ({ ...(await orig<object>()), ...observed }));

const status = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchProviderStatus: vi.fn(async (..._args: any[]): Promise<any> => ({ quota: { kind: 'none' } })),
}));
vi.mock('../provider-status', () => status);

import { MultiAgentOrchestrator } from '../multi-agent-orchestrator';
import { ProviderApiError } from '../provider-adapter';
import { configManager } from '@/lib/config/storage';
import { vfs } from '@/lib/vfs';
import { checkpointManager } from '@/lib/vfs/checkpoint';

/**
 * The provider-error paths of the orchestrator that the main suite reaches only through
 * `onProviderError`: what the stopped card carries, how "Free models" moves on, what this browser
 * records about a model, the server-side run's own resolutions, and the failure result.
 */

const FREE = 'osw/free-models';
const assign = (model: string, provider = 'openrouter') =>
  ({ agent: { provider, model }, imageGen: null, voiceInput: null, autoCompact: true, compactLimit: null });

function apiError(category: string, opts: { status?: number; provider?: string; model?: string; timing?: Record<string, number> } = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = ProviderApiError as any;
  return new Ctor('provider said no', opts.status ?? 429, 'rate_limit', category, opts.provider ?? 'openrouter', opts.model ?? 'paid/model', opts.timing ?? {}) as ProviderApiError;
}

const failed: AgentLoopResult = { success: false, summary: 's', exitReason: 'error_stop', totalCost: 0, totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, toolCount: 0, turnCount: 0 };

/** Runs one provider error through the real handler and returns the action and the events. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handle(error: ProviderApiError, assignment: ReturnType<typeof assign> | undefined, serverCtx?: any) {
  const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
  let action: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h.loopBehavior.run = async (deps: any) => {
    action = await deps.config.onProviderError(error);
    return failed;
  };
  const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', (event, data) => events.push({ event, data: data as Record<string, unknown> }), { assignment, ...(serverCtx ? { serverContext: serverCtx } : {}) });
  await o.execute('build');
  return { action, events, o, stopped: events.find((e) => e.event === 'api_stopped')?.data };
}

/** A server run's own config, as the generate route builds it from the browser's request. */
async function serverConfig(model: string, freeModelCandidates: unknown[]) {
  const { ServerConfigManager } = await import('@/lib/server-generate/server-config-manager');
  return new ServerConfigManager({ provider: 'openrouter', model, apiKey: 'k', freeModelCandidates } as never);
}

function serverContext(extra: Record<string, unknown> = {}) {
  return {
    apiBaseUrl: 'http://srv',
    vfs,
    // The browser's settings, with the one method only the server's config has.
    config: Object.assign(Object.create(configManager), { getFreeModelCandidates: () => undefined }),
    onEvent: vi.fn(),
    dirtyPaths: new Set<string>(),
    ...extra,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  h.loops.length = 0;
  h.executorConfigs.length = 0;
  h.coordinatorConfigs.length = 0;
  h.agent = h.orchestratorAgent;
  h.loopBehavior.run = async () => ({ ...h.okResult });
  vi.stubGlobal('window', {});
  suggest.rankProviderModels.mockReset().mockResolvedValue([]);
  suggest.nextModelAfter.mockReset().mockResolvedValue(undefined);
  suggest.alternativesTo.mockReset().mockResolvedValue([]);
  status.fetchProviderStatus.mockReset().mockResolvedValue({ quota: { kind: 'none' } });
  observed.recordModelOutcome.mockReset();
  vi.mocked(checkpointManager.createCheckpoint).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the stopped card', () => {
  it('offers "Free models", the other providers and the allowance when OpenRouter credit runs out', async () => {
    const quota = { kind: 'daily', used: 50, limit: 50, remaining: 0, resetAt: 9 };
    status.fetchProviderStatus.mockResolvedValue({ quota });
    suggest.alternativesTo.mockResolvedValue([{ provider: 'vercel', model: 'v/m' }]);
    suggest.nextModelAfter.mockResolvedValue({ provider: 'openrouter', model: 'cheaper/model' });

    const { stopped } = await handle(apiError('credit_exhausted', { status: 402, timing: { retryAfterMs: 1000, resetAt: 5000 } }), assign('paid/model'));

    expect(stopped).toMatchObject({
      suggestion: { provider: 'openrouter', model: FREE },
      alternatives: [{ provider: 'vercel', model: 'v/m' }],
      quota,
      retryAfterMs: 1000,
      resetAt: 5000,
    });
    expect(status.fetchProviderStatus).toHaveBeenCalledWith('openrouter', 'key');
  });

  it('suggests no other model on a provider out of credit with no "Free models": the credit is the account\'s', async () => {
    suggest.nextModelAfter.mockResolvedValue({ provider: 'huggingface', model: 'cheaper/model' });
    suggest.alternativesTo.mockResolvedValue([{ provider: 'gemini', model: 'g/m' }]);

    const { stopped } = await handle(apiError('credit_exhausted', { status: 429, provider: 'huggingface' }), assign('paid/model', 'huggingface'));

    expect(stopped).not.toHaveProperty('suggestion');
    expect(stopped).toMatchObject({ alternatives: [{ provider: 'gemini', model: 'g/m' }] });
    expect(suggest.nextModelAfter).not.toHaveBeenCalled();
  });

  it('suggests the next model on the same provider for a stop about the model', async () => {
    suggest.nextModelAfter.mockResolvedValue({ provider: 'openai', model: 'cheaper/model' });
    const { stopped } = await handle(apiError('model_unavailable', { provider: 'openai' }), assign('paid/model', 'openai'));
    expect(stopped?.suggestion).toEqual({ provider: 'openai', model: 'cheaper/model' });
  });

  it('does not suggest "Free models" to a task already on it', async () => {
    const { stopped } = await handle(apiError('credit_exhausted', { status: 402, model: 'a/m:free' }), assign(FREE));
    expect(stopped).not.toHaveProperty('suggestion');
  });

  it('reads a spent daily count as spent, but suggests no other free model: they share the count', async () => {
    const quota = { kind: 'daily', used: 50, limit: 50, remaining: 0, resetAt: 9 };
    status.fetchProviderStatus.mockResolvedValue({ quota });
    suggest.alternativesTo.mockResolvedValue([{ provider: 'vercel', model: 'v/m' }]);
    suggest.nextModelAfter.mockResolvedValue({ provider: 'openrouter', model: 'other:free' });

    const { stopped } = await handle(apiError('daily_limit', { model: 'x/m:free' }), assign('x/m:free'));

    expect(stopped).toMatchObject({ quota, alternatives: [{ provider: 'vercel', model: 'v/m' }] });
    expect(stopped).not.toHaveProperty('suggestion');
    expect(suggest.nextModelAfter).not.toHaveBeenCalled();
  });

  it('asks for no allowance or other providers when nothing is spent', async () => {
    const { stopped } = await handle(apiError('rate_limited'), assign('paid/model'));
    expect(stopped).toMatchObject({ alternatives: [] });
    expect(status.fetchProviderStatus).not.toHaveBeenCalled();
    expect(suggest.alternativesTo).not.toHaveBeenCalled();
  });

  it('suggests nothing on the same provider for a task on "Free models": the rotation already tried', async () => {
    await handle(apiError('rate_limited', { model: 'a/m:free' }), assign(FREE));
    expect(suggest.nextModelAfter).not.toHaveBeenCalled();
  });

  it('keeps the timing when the extras cannot be worked out', async () => {
    status.fetchProviderStatus.mockRejectedValue(new Error('offline'));
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { assignment: assign('paid/model') });
    // @ts-expect-error private
    const details = await o.describeStop(apiError('credit_exhausted', { status: 402, timing: { resetAt: 5000 } }));
    expect(details).toEqual({ resetAt: 5000 });
  });

  it('gives a server-side run only the timing, asking nothing of the browser-side services', async () => {
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { assignment: assign('paid/model'), serverContext: serverContext() });
    // @ts-expect-error private
    const details = await o.describeStop(apiError('credit_exhausted', { status: 402, timing: { retryAfterMs: 1000 } }));
    expect(details).toEqual({ retryAfterMs: 1000 });
    expect(status.fetchProviderStatus).not.toHaveBeenCalled();
    expect(suggest.alternativesTo).not.toHaveBeenCalled();
  });
});

describe('"Free models" moving on', () => {
  it('passes over a free model that is gone, as well as one that is busy, and records it', async () => {
    suggest.rankProviderModels.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { provider: 'openrouter', model: { id: 'next/model:free' }, coolingDown: false },
    ]);
    const { action, events } = await handle(apiError('model_not_found', { status: 404, model: 'gone/model:free' }), assign(FREE));
    expect(action).toBe('retry');
    expect(events.find((e) => e.event === 'model_switched')?.data).toMatchObject({ toModel: 'next/model:free', reason: 'unavailable' });
    expect(observed.recordModelOutcome).toHaveBeenCalledWith('openrouter', 'gone/model:free', 'unavailable');
  });

  it('records a busy free model as busy and says so', async () => {
    suggest.rankProviderModels.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { provider: 'openrouter', model: { id: 'next/model:free' }, coolingDown: false },
    ]);
    const { events } = await handle(apiError('model_busy', { model: 'busy/model:free' }), assign(FREE));
    expect(events.find((e) => e.event === 'model_switched')?.data).toMatchObject({ reason: 'busy' });
    expect(observed.recordModelOutcome).toHaveBeenCalledWith('openrouter', 'busy/model:free', 'busy');
  });

  it('does not move on when the user pressed Stop while it was looking', async () => {
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { assignment: assign(FREE) });
    suggest.rankProviderModels.mockImplementation(async () => {
      o.stop();
      return [{ provider: 'openrouter', model: { id: 'next/model:free' }, coolingDown: false }];
    });
    // @ts-expect-error private
    expect(await o.rotateFreeModel(apiError('model_busy', { model: 'busy/model:free' }))).toBe(false);
    // @ts-expect-error private
    expect(o.freeModelPick).toBeNull();
  });

  it('does not rotate a server run that has no candidates, and never ranks models on the server', async () => {
    suggest.rankProviderModels.mockResolvedValue([{ provider: 'openrouter', model: { id: 'next/model:free' }, coolingDown: false }]);
    const config = await serverConfig(FREE, []);
    const { action, events, stopped } = await handle(apiError('model_busy', { model: 'busy/model:free' }), undefined, serverContext({ config }));
    expect(action).toBe('stop');
    expect(stopped).toMatchObject({ errorCategory: 'model_busy', model: 'busy/model:free' });
    expect(events.some((e) => e.event === 'model_switched')).toBe(false);
    expect(suggest.rankProviderModels).not.toHaveBeenCalled();
  });

  it('moves a server run on "Free models" to the next candidate the browser ranked', async () => {
    const config = await serverConfig(FREE, ['best:free', 'next:free']);
    const { action, events } = await handle(apiError('model_busy', { model: 'best:free' }), undefined, serverContext({ config }));
    expect(action).toBe('retry');
    expect(events.find((e) => e.event === 'model_switched')?.data).toMatchObject({
      provider: 'openrouter', fromModel: 'best:free', toModel: 'next:free', reason: 'busy', outcome: 'busy',
    });
    expect(suggest.rankProviderModels).not.toHaveBeenCalled();
  });

  it('records a stop on a model the user picked, so the next suggestion passes it over', async () => {
    // A stopped card that offered B after A failed, then A again after B failed, walked in a circle.
    observed.recordModelOutcome.mockClear();
    await handle(apiError('model_busy', { model: 'picked/a' }), assign('picked/a'));
    expect(observed.recordModelOutcome).toHaveBeenCalledWith('openrouter', 'picked/a', 'busy');
    observed.recordModelOutcome.mockClear();
    await handle(apiError('model_refused', { status: 403, model: 'picked/b' }), assign('picked/b'));
    expect(observed.recordModelOutcome).toHaveBeenCalledWith('openrouter', 'picked/b', 'refused');
    observed.recordModelOutcome.mockClear();
    await handle(apiError('blocked', { status: 403, model: 'picked/c' }), assign('picked/c'));
    expect(observed.recordModelOutcome).toHaveBeenCalledWith('openrouter', 'picked/c', 'flagged');
  });

  it('records nothing for a stop that is not about the model', async () => {
    observed.recordModelOutcome.mockClear();
    await handle(apiError('auth_expired', { status: 401, model: 'picked/a' }), assign('picked/a'));
    expect(observed.recordModelOutcome).not.toHaveBeenCalled();
  });

  it('passes over a free model that refused the request, and says it refused', async () => {
    suggest.rankProviderModels.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { provider: 'openrouter', model: { id: 'next/model:free' }, coolingDown: false },
    ]);
    observed.recordModelOutcome.mockClear();
    const { action, events } = await handle(apiError('model_refused', { status: 403, model: 'gated/model:free' }), assign(FREE));
    expect(action).toBe('retry');
    expect(events.find((e) => e.event === 'model_switched')?.data).toMatchObject({ toModel: 'next/model:free', reason: 'refused', outcome: 'refused' });
    expect(observed.recordModelOutcome).toHaveBeenCalledWith('openrouter', 'gated/model:free', 'refused');
  });

  it('says in the thread which free model "Free models" landed on, or that the router chooses', async () => {
    const events: Array<{ event: string; data?: unknown }> = [];
    suggest.rankProviderModels.mockResolvedValue([{ provider: 'openrouter', model: { id: 'ready/model:free' }, coolingDown: false }]);
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', (event, data) => events.push({ event, data }), { assignment: assign(FREE) });
    // @ts-expect-error private
    await o.pickFreeModel();
    expect(events.find((e) => e.event === 'model_picked')?.data).toEqual({ provider: 'openrouter', model: 'ready/model:free' });

    events.length = 0;
    suggest.rankProviderModels.mockResolvedValue([]);
    const o2 = new MultiAgentOrchestrator('test-p1', 'orchestrator', (event, data) => events.push({ event, data }), { assignment: assign(FREE) });
    // @ts-expect-error private
    await o2.pickFreeModel();
    expect(events.find((e) => e.event === 'model_picked')?.data).toEqual({ provider: 'openrouter', model: 'openrouter/free' });
  });

  it('names no pick for a model the user chose', async () => {
    const events: Array<{ event: string }> = [];
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', (event) => events.push({ event }), { assignment: assign('picked/a') });
    // @ts-expect-error private
    await o.pickFreeModel();
    expect(events.some((e) => e.event === 'model_picked')).toBe(false);
  });

  it('starts on the best free model that is not cooling down', async () => {
    suggest.rankProviderModels.mockResolvedValue([
      { provider: 'openrouter', model: { id: 'cooling/model:free' }, coolingDown: true },
      { provider: 'openrouter', model: { id: 'ready/model:free' }, coolingDown: false },
    ]);
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { assignment: assign(FREE) });
    // @ts-expect-error private
    await o.pickFreeModel();
    // @ts-expect-error private
    expect(o.freeModelPick).toBe('ready/model:free');
  });

  it('runs a server-side "Free models" task on the browser\'s best candidate and keeps it until one fails', async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    // The real server config, so the candidates are read the way a server run reads them.
    const { ServerConfigManager } = await import('@/lib/server-generate/server-config-manager');
    const config = new ServerConfigManager({
      provider: 'openrouter', model: FREE, apiKey: 'k', freeModelCandidates: ['best:free', 'next:free', 'third:free'],
    } as never);
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', (event, data) => events.push({ event, data: data as Record<string, unknown> }), { serverContext: serverContext({ config }) });
    // @ts-expect-error private
    await o.pickFreeModel();
    // @ts-expect-error private
    expect(o.getProviderConfig().model).toBe('best:free');
    expect(events.find((e) => e.event === 'model_picked')?.data).toEqual({ provider: 'openrouter', model: 'best:free' });

    // @ts-expect-error private
    expect(await o.rotateFreeModel(apiError('model_busy', { model: 'best:free' }))).toBe(true);
    // @ts-expect-error private
    expect(o.getProviderConfig().model).toBe('next:free');
    expect(events.find((e) => e.event === 'model_switched')?.data).toMatchObject({ fromModel: 'best:free', toModel: 'next:free', reason: 'busy', outcome: 'busy' });
    // Never back to one this run already tried.
    events.length = 0;
    // @ts-expect-error private
    expect(await o.rotateFreeModel(apiError('blocked', { status: 403, model: 'next:free' }))).toBe(true);
    // @ts-expect-error private
    expect(o.getProviderConfig().model).toBe('third:free');
    // A blocked request reads as a refusal in the thread, but is recorded as flagged.
    expect(events.find((e) => e.event === 'model_switched')?.data).toMatchObject({ toModel: 'third:free', reason: 'refused', outcome: 'flagged' });
    // @ts-expect-error private
    expect(await o.rotateFreeModel(apiError('model_busy', { model: 'third:free' }))).toBe(false);
  });

  it('ignores candidates that are not plain model ids', async () => {
    const { ServerConfigManager } = await import('@/lib/server-generate/server-config-manager');
    const config = new ServerConfigManager({
      provider: 'openrouter', model: FREE, apiKey: 'k', freeModelCandidates: ['bad id; rm', 42, 'osw/free-models', 'ok/model:free'],
    } as never);
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { serverContext: serverContext({ config }) });
    // @ts-expect-error private
    await o.pickFreeModel();
    // @ts-expect-error private
    expect(o.getProviderConfig().model).toBe('ok/model:free');
  });

  it('picks nothing in a server-side run with no candidates, and says OpenRouter\'s free router answers', async () => {
    suggest.rankProviderModels.mockResolvedValue([{ provider: 'openrouter', model: { id: 'ready/model:free' }, coolingDown: false }]);
    const events: Array<{ event: string; data?: unknown }> = [];
    const config = await serverConfig(FREE, []);
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', (event, data) => events.push({ event, data }), { serverContext: serverContext({ config }) });
    // @ts-expect-error private
    await o.pickFreeModel();
    // @ts-expect-error private
    expect(o.freeModelPick).toBeNull();
    expect(events.find((e) => e.event === 'model_picked')?.data).toEqual({ provider: 'openrouter', model: 'openrouter/free' });
    expect(suggest.rankProviderModels).not.toHaveBeenCalled();
  });

  it('offers a server run at most twenty of the browser\'s candidates', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `m${i}:free`);
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { serverContext: serverContext({ config: await serverConfig(FREE, ids) }) });
    // @ts-expect-error private
    await o.pickFreeModel();
    let moves = 0;
    // @ts-expect-error private
    while (moves < 30 && await o.rotateFreeModel(apiError('model_busy', { model: o.getProviderConfig().model }))) moves++;
    expect(moves).toBe(19);
  });
});

describe('what this browser records about the agent model', () => {
  it('counts a run that used tools as working', async () => {
    h.loopBehavior.run = async () => ({ ...h.okResult, toolCount: 2 });
    await new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { assignment: assign('a/model', 'openai') }).execute('build');
    await flush();
    expect(observed.recordModelOutcome).toHaveBeenCalledWith('openai', 'a/model', 'ok');
  });

  it('counts nothing for a run that used no tools', async () => {
    h.loopBehavior.run = async () => ({ ...h.okResult, toolCount: 0 });
    await new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { assignment: assign('a/model', 'openai') }).execute('build');
    await flush();
    expect(observed.recordModelOutcome).not.toHaveBeenCalled();
  });

  it('counts a malformed tool call against the model', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    h.loopBehavior.run = async (deps: any) => {
      deps.progress.onEvent('malformed_tool_call', {});
      return { ...h.okResult, toolCount: 0 };
    };
    await new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { assignment: assign('a/model', 'openai') }).execute('build');
    await flush();
    expect(observed.recordModelOutcome).toHaveBeenCalledWith('openai', 'a/model', 'tool_failure');
  });

  it("records nothing for OpenRouter's free router, which answers with a different model each time", async () => {
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { assignment: assign(FREE) });
    // @ts-expect-error private
    o.freeModelPick = null;
    // @ts-expect-error private
    o.recordAgentOutcome('ok');
    await flush();
    expect(observed.recordModelOutcome).not.toHaveBeenCalled();
  });

  it('records the free model "Free models" picked', async () => {
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { assignment: assign(FREE) });
    // @ts-expect-error private
    o.freeModelPick = 'ready/model:free';
    // @ts-expect-error private
    o.recordAgentOutcome('ok');
    await flush();
    expect(observed.recordModelOutcome).toHaveBeenCalledWith('openrouter', 'ready/model:free', 'ok');
  });

  it('records nothing from a server-side run', async () => {
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { assignment: assign('a/model', 'openai'), serverContext: serverContext() });
    // @ts-expect-error private
    o.recordAgentOutcome('ok');
    await flush();
    expect(observed.recordModelOutcome).not.toHaveBeenCalled();
  });
});

describe('a server-side run', () => {
  it('sends "Free models" to OpenRouter\'s free router, never as a model id', async () => {
    const o = new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { serverContext: serverContext({ config: await serverConfig(FREE, []) }) });
    // @ts-expect-error private
    expect(o.getProviderConfig()).toMatchObject({ provider: 'openrouter', model: 'openrouter/free' });
  });

  it('takes image generation from what the browser reported, not the assignment', () => {
    const on = new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { assignment: assign('a/model'), serverContext: serverContext({ imageGenAvailable: true }) });
    const off = new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { assignment: { ...assign('a/model'), imageGen: 'agent' } as never, serverContext: serverContext({ imageGenAvailable: false }) });
    // @ts-expect-error private
    expect(on.isImageGenAvailable()).toBe(true);
    // @ts-expect-error private
    expect(off.isImageGenAvailable()).toBe(false);
  });

  it('hands image generation to the browser, and fails the command with the browser\'s reason', async () => {
    const onImageRequested = vi.fn()
      .mockResolvedValueOnce({ base64: 'AAAA', mimeType: 'image/png' })
      .mockResolvedValueOnce({ error: 'No image model connected' });
    await new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { serverContext: serverContext({ imageGenAvailable: true, onImageRequested }) }).execute('build');

    const generate = h.executorConfigs[0].generateImage;
    await expect(generate('a cat', { aspectRatio: '1:1' })).resolves.toEqual({ base64: 'AAAA', mimeType: 'image/png' });
    expect(onImageRequested).toHaveBeenCalledWith('a cat', { aspectRatio: '1:1' });
    await expect(generate('a dog', {})).rejects.toThrow('No image model connected');
  });

  it('offers no image command when the browser has no image model', async () => {
    const onImageRequested = vi.fn();
    await new MultiAgentOrchestrator('test-p1', 'orchestrator', () => {}, { serverContext: serverContext({ imageGenAvailable: false, onImageRequested }) }).execute('build');
    expect(h.executorConfigs[0].generateImage).toBeUndefined();
  });
});

describe('the run result and its checkpoint', () => {
  it('summarises a failure as the error\'s own message, with no prefix', async () => {
    h.loopBehavior.run = async () => { throw new Error('the model went away'); };
    const result = await new MultiAgentOrchestrator('test-p1').execute('build');
    expect(result).toMatchObject({ success: false, exitReason: 'execution_error', summary: 'the model went away' });
  });

  it('invents no English for something thrown that is not an Error', async () => {
    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    h.loopBehavior.run = async () => { throw 'boom'; };
    const result = await new MultiAgentOrchestrator('test-p1', 'orchestrator', (event, data) => events.push({ event, data: data as Record<string, unknown> })).execute('build');
    expect(result.summary).toBe('');
    expect(events.find((e) => e.event === 'error')?.data).not.toHaveProperty('message');
  });

  it('labels the checkpoint after a run so it can be shown in any language', async () => {
    await new MultiAgentOrchestrator('test-p1').execute('build a site');
    expect(checkpointManager.createCheckpoint).toHaveBeenCalledWith('test-p1', 'After: build a site', expect.objectContaining({
      label: { key: 'afterPrompt', values: { prompt: 'build a site' } },
    }));
  });

  it('labels the checkpoint after a failed run as a failure', async () => {
    h.loopBehavior.run = async () => { throw new Error('x'); };
    await new MultiAgentOrchestrator('test-p1').execute('build a site');
    expect(checkpointManager.createCheckpoint).toHaveBeenCalledWith('test-p1', 'After failure: build a site', expect.objectContaining({
      label: { key: 'afterFailure', values: { prompt: 'build a site' } },
    }));
  });
});
