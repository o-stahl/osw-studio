import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskManager } from '../task-manager';
import { SSEEventBus } from '../sse-event-bus';
import { ServerConfigManager } from '../server-config-manager';

describe('Server-side generation integration', () => {
  let tm: TaskManager;
  let bus: SSEEventBus;

  beforeEach(() => {
    tm = new TaskManager({ maxConcurrentPerScope: 3, keyTTLMs: 30 * 60 * 1000 });
    bus = new SSEEventBus({ maxBufferSize: 500 });
  });

  afterEach(() => {
    tm.dispose();
  });

  it('full lifecycle: create task → emit events → complete → cleanup', () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-key');
    expect(tm.getTask(taskId)?.status).toBe('running');
    expect(tm.getApiKey(taskId)).toBe('sk-key');

    const received: any[] = [];
    bus.addListener('sess-1', (e) => received.push(e));

    bus.emit(taskId, 'proj-1', 'assistant_delta', { text: 'Hello' }, 'sess-1');
    bus.emit(taskId, 'proj-1', 'tool_status', { status: 'running' }, 'sess-1');
    bus.emit(taskId, 'proj-1', 'task_complete', { result: 'success' }, 'sess-1');

    expect(received).toHaveLength(3);
    expect(bus.getBuffer(taskId)).toHaveLength(2); // delta not buffered

    tm.completeTask(taskId, 'completed');
    expect(tm.getTask(taskId)?.status).toBe('completed');
    expect(tm.getApiKey(taskId)).toBeUndefined();
  });

  it('SSE reconnect replays non-delta events', () => {
    const taskId = tm.createTask('proj-1', 'sess-1', 'sk-key');
    bus.emit(taskId, 'proj-1', 'assistant_delta', { text: 'a' }, 'sess-1');
    bus.emit(taskId, 'proj-1', 'tool_status', { status: 'started' }, 'sess-1');
    bus.emit(taskId, 'proj-1', 'conversation_message', { msg: 'hi' }, 'sess-1');

    const replayed = bus.replayFrom(taskId, 0);
    expect(replayed).toHaveLength(2);
    expect(replayed![0].event).toBe('tool_status');
    expect(replayed![1].event).toBe('conversation_message');
  });

  it('task limit enforcement across create and complete', () => {
    const t1 = tm.createTask('p1', 's1', 'k1', 'ws-1');
    tm.createTask('p2', 's1', 'k2', 'ws-1');
    tm.createTask('p3', 's1', 'k3', 'ws-1');

    expect(() => tm.createTask('p4', 's1', 'k4', 'ws-1')).toThrow();

    tm.completeTask(t1, 'completed');
    const t4 = tm.createTask('p4', 's1', 'k4', 'ws-1');
    expect(t4).toBeDefined();
  });

  it('ServerConfigManager tracks cost across multiple updates', () => {
    const config = new ServerConfigManager({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      modelPricing: { 'gpt-4o': { prompt: 2.5, completion: 10 } },
    });

    config.updateSessionCost({ promptTokens: 1000, completionTokens: 500 }, 0.075);
    config.updateSessionCost({ promptTokens: 2000, completionTokens: 1000 }, 0.15);

    const session = config.getSessionCost();
    expect(session.totalCost).toBeCloseTo(0.225);
    expect(session.requestCount).toBe(2);
    expect(session.totalPromptTokens).toBe(3000);
    expect(session.totalCompletionTokens).toBe(1500);
  });
});
