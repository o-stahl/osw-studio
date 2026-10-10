import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestStore, setupOrchestratorMocks } from './test-helpers';
import { getProjectAssignment } from '@/lib/llm/models/project-assignment';
import { getProvider } from '@/lib/llm/providers/registry';
import { configManager } from '@/lib/config/storage';
import { toast } from 'sonner';
import { checkpointManager } from '@/lib/vfs/checkpoint';

// Side-effects reached only on the success path — stubbed so the test stays
// deterministic in the node environment (no window / EventSource / VFS).
vi.mock('@/lib/vfs/sync-manager', () => ({
  getSyncManager: () => ({ pushSingleProject: vi.fn().mockResolvedValue({ success: true }) }),
}));
vi.mock('@/lib/vfs/checkpoint', () => ({
  checkpointManager: { createCheckpoint: vi.fn().mockResolvedValue({ id: 'cp1', description: '', timestamp: 0 }) },
}));
const rankProviderModels = vi.hoisted(() => vi.fn());
vi.mock('@/lib/llm/suggestions/suggest', () => ({ rankProviderModels }));

setupOrchestratorMocks();

// Regression for the server-mode generation path: startServerGeneration must
// resolve the agent model from the per-project assignment, not the legacy global
// provider/model. Previously it used configManager.getProviderModel(), so a
// project configured purely per-project (e.g. opencode-go, which has no default
// model) sent an empty model and /api/server-generate rejected it with
// "Missing required fields: ... model".
describe('orchestrator slice — startServerGeneration model resolution', () => {
  let store: ReturnType<typeof createTestStore>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createTestStore();
    vi.clearAllMocks();
    // connectSSE touches EventSource/window — not available in node. No-op it.
    store.setState({ connectSSE: vi.fn() });
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ taskId: 't1' }) });
    vi.stubGlobal('fetch', fetchMock);
    // The shared mock's getProjectAssignment defaults to openai/gpt-4; override per-test.
    vi.mocked(getProjectAssignment).mockResolvedValue({
      agent: { provider: 'opencode-go', model: 'minimax-m2.7' },
      imageGen: null,
      voiceInput: null,
      autoCompact: false,
      compactLimit: null,
    } as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the per-project assignment model, not the global model', async () => {
    await store.getState().startServerGeneration('proj1', 'build a landing page', false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/server-generate');
    const body = JSON.parse((init as RequestInit).body as string);
    // The model must come from the assignment (minimax-m2.7), not the global
    // configManager.getProviderModel() which the shared mock returns as 'gpt-4'.
    expect(body.model).toBe('minimax-m2.7');
    expect(body.providerConfig.provider).toBe('opencode-go');
  });

  // An unnamed project sends no name, so the server applies its own default rather than storing
  // whichever language's "Untitled" this tab happened to be in.
  it('sends no project name for a project that has none', async () => {
    store.setState({ projectName: '' });
    await store.getState().startServerGeneration('proj1', 'build a landing page', false);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect('projectName' in body).toBe(false);
  });

  // The server runs the loop but the browser holds the image model's key, so the server only
  // advertises `generate-image` when the tab says there is a model to delegate to.
  it('tells the server whether the project has an image model', async () => {
    await store.getState().startServerGeneration('proj1', 'a hero image', false);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).imageGenAvailable).toBe(false);

    vi.mocked(getProjectAssignment).mockResolvedValue({
      agent: { provider: 'opencode-go', model: 'minimax-m2.7' },
      imageGen: { provider: 'openrouter', model: 'img' },
      voiceInput: null,
      autoCompact: false,
      compactLimit: null,
    } as any);
    store = createTestStore();
    store.setState({ connectSSE: vi.fn() });
    await store.getState().startServerGeneration('proj2', 'a hero image', false);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).imageGenAvailable).toBe(true);
  });

  it('sends "Free models" the free models to run on, best first, leaving out those cooling down', async () => {
    // The ranking needs this browser's records; without the list the server sent OpenRouter's free
    // router, which answered each request with a different model.
    rankProviderModels.mockResolvedValue([
      { provider: 'openrouter', model: { id: 'best:free' }, coolingDown: false },
      { provider: 'openrouter', model: { id: 'busy:free' }, coolingDown: true },
      { provider: 'openrouter', model: { id: 'next:free' }, coolingDown: false },
    ]);
    vi.mocked(getProjectAssignment).mockResolvedValue({
      agent: { provider: 'openrouter', model: 'osw/free-models' },
      imageGen: null, voiceInput: null, autoCompact: false, compactLimit: null,
    } as any);
    await store.getState().startServerGeneration('proj1', 'build it', false);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(rankProviderModels).toHaveBeenCalledWith('openrouter', { freeOnly: true });
    expect(body.generationParams.freeModelCandidates).toEqual(['best:free', 'next:free']);
  });

  it('sends at most twenty candidates, the best ones', async () => {
    rankProviderModels.mockResolvedValue(Array.from({ length: 25 }, (_, i) => (
      { provider: 'openrouter', model: { id: `m${i}:free` }, coolingDown: false })));
    vi.mocked(getProjectAssignment).mockResolvedValue({
      agent: { provider: 'openrouter', model: 'osw/free-models' },
      imageGen: null, voiceInput: null, autoCompact: false, compactLimit: null,
    } as any);
    await store.getState().startServerGeneration('proj1', 'build it', false);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.generationParams.freeModelCandidates).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}:free`));
  });

  it('sends the history from the last replaced conversation, without the new prompt', async () => {
    // The server's execute adds the prompt itself, and a dropped or compacted history is replaced
    // by `conversation_replaced`, as a browser run rebuilds it.
    store.setState({ projectId: 'proj1' });
    const add = store.getState().addDebugEvent;
    add('conversation_message', { message: { role: 'user', content: 'refused ask' } }, 'proj1');
    add('conversation_replaced', { messages: [{ role: 'system', content: 'sys' }] }, 'proj1');
    add('conversation_message', { message: { role: 'user', content: 'earlier' } }, 'proj1');
    add('conversation_message', { message: { role: 'assistant', content: 'done' } }, 'proj1');
    await store.getState().startServerGeneration('proj1', 'next ask', false);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.conversationHistory.map((m: { content: string }) => m.content)).toEqual(['sys', 'earlier', 'done']);
  });

  it('drops an unanswered message before the new one, so later runs keep the new one', async () => {
    store.setState({ projectId: 'proj1' });
    const add = store.getState().addDebugEvent;
    add('conversation_message', { message: { role: 'system', content: 'sys' } }, 'proj1');
    add('conversation_message', { message: { role: 'user', content: 'refused ask' } }, 'proj1');
    await store.getState().startServerGeneration('proj1', 'new ask', false);
    const first = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(first.conversationHistory.map((m: { content: string }) => m.content)).toEqual(['sys']);

    // The server's echo settles the local message, and the run answers it.
    store.setState({
      debugEvents: store.getState().debugEvents.map((e) =>
        e.data?.message?.content === 'new ask' ? { ...e, data: { message: { role: 'user', content: 'new ask' } } } : e),
    });
    add('conversation_message', { message: { role: 'assistant', content: 'answer' } }, 'proj1');
    await store.getState().startServerGeneration('proj1', 'third ask', false);
    const second = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(second.conversationHistory.map((m: { content: string }) => m.content)).toEqual(['sys', 'new ask', 'answer']);
  });

  it('keeps an unanswered message for Continue, which takes it up', async () => {
    store.setState({ projectId: 'proj1' });
    store.getState().addDebugEvent('conversation_message', { message: { role: 'user', content: 'refused ask' } }, 'proj1');
    const { CONTINUE_AFTER_STOP_PROMPT } = await import('@/lib/llm/continue-prompt');
    await store.getState().startServerGeneration('proj1', CONTINUE_AFTER_STOP_PROMPT, false);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.conversationHistory.map((m: { content: string }) => m.content)).toEqual(['refused ask']);
  });

  it('sends no candidates for a model the user picked', async () => {
    await store.getState().startServerGeneration('proj1', 'build it', false);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.generationParams).not.toHaveProperty('freeModelCandidates');
    expect(rankProviderModels).not.toHaveBeenCalled();
  });

  it('labels the snapshot it takes before the run, so the panel can word it', async () => {
    await store.getState().startServerGeneration('proj1', 'build a landing page', false);
    expect(checkpointManager.createCheckpoint).toHaveBeenCalledWith(
      'proj1', 'Pre-generation snapshot', { kind: 'auto', label: { key: 'preGeneration' } },
    );
  });

  it('aborts with a clear message when the project has no model selected', async () => {
    vi.mocked(getProjectAssignment).mockResolvedValueOnce({
      agent: { provider: 'opencode-go', model: '' },
      imageGen: null,
      voiceInput: null,
      autoCompact: false,
      compactLimit: null,
    } as any);

    await store.getState().startServerGeneration('proj1', 'build a landing page', false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('aborts when project model assignment cannot be resolved', async () => {
    vi.mocked(getProjectAssignment).mockRejectedValueOnce(new Error('no model template available'));

    await store.getState().startServerGeneration('proj1', 'build a landing page', false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  // A local provider has no key. Server mode used to refuse to start any task without one,
  // which locked self-hosted users out of Ollama entirely.
  it('starts a task on a keyless local provider', async () => {
    vi.mocked(getProvider).mockReturnValue({ name: 'Ollama', apiKeyRequired: false, isLocal: true, usesOAuth: false } as any);
    vi.mocked(configManager.getProviderApiKey).mockReturnValue('');
    vi.mocked(configManager.getLocalContextLength).mockReturnValue(65536);
    vi.mocked(getProjectAssignment).mockResolvedValue({
      agent: { provider: 'ollama', model: 'qwen3:4b' }, imageGen: null, voiceInput: null, autoCompact: false, compactLimit: null,
    } as any);

    await store.getState().startServerGeneration('proj1', 'change the heading', false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ model: 'qwen3:4b', apiKey: '' });
    // The server runs the loop, so the local window has to travel with the request.
    expect(body.generationParams.localContextLength).toBe(65536);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('still refuses a cloud provider with no key', async () => {
    vi.mocked(getProvider).mockReturnValue({ name: 'OpenAI', apiKeyRequired: true, isLocal: false, usesOAuth: false } as any);
    vi.mocked(configManager.getProviderApiKey).mockReturnValue('');

    await store.getState().startServerGeneration('proj1', 'change the heading', false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
