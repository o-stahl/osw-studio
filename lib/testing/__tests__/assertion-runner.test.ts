import { describe, it, expect, vi } from 'vitest';
import type { ConversationNode } from '@/lib/llm/multi-agent-orchestrator';

const mockVfs = {
  init: vi.fn(),
  readFile: vi.fn(),
  fileExists: vi.fn(),
};

vi.mock('@/lib/vfs', () => ({
  vfs: mockVfs,
  getActiveVFS: () => mockVfs,
}));

function makeConversation(messages: Array<{
  role: string;
  content?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}>): ConversationNode[] {
  return [{
    id: 'test-node',
    agent_type: 'orchestrator',
    messages: messages as any,
    metadata: { started_at: Date.now(), cost: 0, status: 'completed' },
  }];
}

describe('any_of assertion', () => {
  it('passes when first sub-assertion matches', async () => {
    const { runAssertions } = await import('../assertion-runner');
    const conversation = makeConversation([
      {
        role: 'assistant',
        tool_calls: [{
          id: 'tc1',
          function: { name: 'bash', arguments: '{"command": "propose-create"}' },
        }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'tc1' },
    ]);

    const results = await runAssertions('test', conversation, [{
      type: 'any_of',
      description: 'propose or ask',
      assertions: [
        { type: 'tool_args_match', toolName: 'bash', pattern: 'propose-create', description: 'propose' },
        { type: 'output_matches', pattern: '\\?', description: 'question' },
      ],
    }]);

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].actual).toContain('propose-create');
  });

  it('passes when second sub-assertion matches', async () => {
    const { runAssertions } = await import('../assertion-runner');
    const conversation = makeConversation([
      { role: 'assistant', content: 'What kind of site do you want?' },
    ]);

    const results = await runAssertions('test', conversation, [{
      type: 'any_of',
      description: 'propose or ask',
      assertions: [
        { type: 'tool_args_match', toolName: 'bash', pattern: 'propose-create', description: 'propose' },
        { type: 'output_matches', pattern: '\\?', description: 'question' },
      ],
    }]);

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
  });

  it('fails and joins all sub-assertion failures', async () => {
    const { runAssertions } = await import('../assertion-runner');
    const conversation = makeConversation([
      { role: 'assistant', content: 'I will build the site now.' },
    ]);

    const results = await runAssertions('test', conversation, [{
      type: 'any_of',
      description: 'propose or ask',
      assertions: [
        { type: 'tool_args_match', toolName: 'bash', pattern: 'propose-create', description: 'propose' },
        { type: 'output_matches', pattern: '\\?', description: 'question' },
      ],
    }]);

    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].actual).toContain('|');
    expect(results[0].actual).toContain('propose');
    expect(results[0].actual).toContain('question');
  });

});
