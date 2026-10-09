import { describe, it, expect, beforeEach } from 'vitest';
import { EventProcessor } from '../event-processor';
import type { DebugEvent } from '@/lib/stores/types';

let idCounter = 0;

function evt(event: string, data: any = {}, overrides?: Partial<DebugEvent>): DebugEvent {
  return {
    id: `evt-${++idCounter}`,
    timestamp: Date.now(),
    event,
    data,
    count: 1,
    version: 1,
    ...overrides,
  };
}

function userMsg(content: string, uiMeta?: Record<string, any>, overrides?: Partial<DebugEvent>): DebugEvent {
  return evt('conversation_message', {
    message: { role: 'user', content, ui_metadata: uiMeta },
  }, overrides);
}

function systemMsg(content: string): DebugEvent {
  return evt('conversation_message', {
    message: { role: 'system', content },
  });
}

describe('EventProcessor', () => {
  let proc: EventProcessor;

  beforeEach(() => {
    proc = new EventProcessor();
    idCounter = 0;
  });

  describe('basic event processing', () => {
    it('returns empty for empty events', () => {
      expect(proc.process([])).toEqual([]);
    });

    it('processes a single user message into a turn with one item', () => {
      const events = [userMsg('hello')];
      const turns = proc.process(events);
      expect(turns).toHaveLength(1);
      expect(turns[0].items).toHaveLength(1);
      expect(turns[0].items[0].type).toBe('user');
      expect(turns[0].items[0].data).toBe('hello');
    });

    it('uses displayContent from ui_metadata when available', () => {
      const events = [userMsg('ctx\n\nhello', { displayContent: 'hello' })];
      const turns = proc.process(events);
      expect(turns[0].items[0].data).toBe('hello');
    });

    it('shows project_context item when projectContext is in ui_metadata', () => {
      const events = [userMsg('hello', { displayContent: 'hello', projectContext: 'files: index.html' })];
      const turns = proc.process(events);
      expect(turns[0].items).toHaveLength(2);
      expect(turns[0].items[0].type).toBe('project_context');
      expect(turns[0].items[0].data).toBe('files: index.html');
      expect(turns[0].items[1].type).toBe('user');
    });

    it('skips system messages (no items rendered)', () => {
      const events = [systemMsg('You are an AI assistant'), userMsg('hello')];
      const turns = proc.process(events);
      expect(turns).toHaveLength(1);
      expect(turns[0].items).toHaveLength(1);
      expect(turns[0].items[0].type).toBe('user');
    });

    it('processes waiting event as a spinner item', () => {
      const events = [userMsg('hello'), evt('waiting')];
      const turns = proc.process(events);
      expect(turns[0].items.some(i => i.type === 'waiting')).toBe(true);
    });

    it('removes waiting indicator when reasoning arrives', () => {
      const events = [
        userMsg('hello'),
        evt('waiting'),
        evt('reasoning_delta', { text: 'thinking...' }),
      ];
      const turns = proc.process(events);
      expect(turns[0].items.some(i => i.type === 'waiting')).toBe(false);
      expect(turns[0].items.some(i => i.type === 'reasoning')).toBe(true);
    });

    it('processes error events', () => {
      const events = [userMsg('hello'), evt('error', { message: 'API failed' })];
      const turns = proc.process(events);
      expect(turns[0].items.some(i => i.type === 'error')).toBe(true);
    });

    it('passes focusContext and semanticBlocks to user item', () => {
      const fc = { domPath: 'body > h1', snippet: '<h1>Hi</h1>' };
      const sb = [{ name: 'Header', domPath: 'body > h1', position: 'top', description: 'The header' }];
      const events = [userMsg('hello', { focusContext: fc, semanticBlocks: sb })];
      const turns = proc.process(events);
      expect(turns[0].items[0].focusContext).toEqual(fc);
      expect(turns[0].items[0].semanticBlocks).toEqual(sb);
    });
  });

  describe('incremental processing', () => {
    it('processes new events without reprocessing old ones', () => {
      const events1 = [userMsg('hello'), evt('waiting')];
      const turns1 = proc.process(events1);
      expect(turns1[0].items).toHaveLength(2);

      const events2 = [...events1, evt('reasoning_delta', { text: 'think' })];
      const turns2 = proc.process(events2);
      // waiting removed, reasoning added → user + reasoning
      expect(turns2[0].items.filter(i => i.type === 'waiting')).toHaveLength(0);
      expect(turns2[0].items.filter(i => i.type === 'reasoning')).toHaveLength(1);
    });

    it('returns cached result when no new events', () => {
      const events = [userMsg('hello')];
      const turns1 = proc.process(events);
      const turns2 = proc.process(events);
      // Same content (shallow structure check)
      expect(turns2).toHaveLength(turns1.length);
      expect(turns2[0].items).toHaveLength(turns1[0].items.length);
    });
  });

  describe('version-based reparse (projectContext merge)', () => {
    it('reparsing after version bump preserves user message', () => {
      // Step 1: initial events — user message without projectContext
      const userEvt = userMsg('change welcome to hi', { displayContent: 'change welcome to hi' });
      const waitEvt = evt('waiting');
      const events1 = [userEvt, waitEvt];
      const turns1 = proc.process(events1);
      expect(turns1[0].items.some(i => i.type === 'user')).toBe(true);
      expect(turns1[0].items.some(i => i.type === 'project_context')).toBe(false);

      // Step 2: more events arrive from server (reasoning, tool calls)
      const reasonEvt = evt('reasoning_delta', { text: 'analyzing...' });
      const events2 = [...events1, reasonEvt];
      proc.process(events2);

      // Step 3: server's user message arrives — client merges projectContext + bumps version
      const mergedUser: DebugEvent = {
        ...userEvt,
        version: 2,
        data: {
          message: {
            role: 'user',
            content: 'change welcome to hi',
            ui_metadata: {
              displayContent: 'change welcome to hi',
              projectContext: 'files:\n  index.html\n  styles.css',
            },
          },
        },
      };
      const events3 = [mergedUser, waitEvt, reasonEvt];
      const turns3 = proc.process(events3);

      // User message must still be present after reparse
      const userItems = turns3[0].items.filter(i => i.type === 'user');
      expect(userItems).toHaveLength(1);
      expect(userItems[0].data).toBe('change welcome to hi');

      // Project context should now appear
      const ctxItems = turns3[0].items.filter(i => i.type === 'project_context');
      expect(ctxItems).toHaveLength(1);
      expect(ctxItems[0].data).toContain('index.html');
    });

    it('does not reparse when version has not changed', () => {
      const userEvt = userMsg('hello');
      const events = [userEvt, evt('waiting')];
      const turns1 = proc.process(events);

      // Process same events again (no version change)
      const turns2 = proc.process(events);
      expect(turns2).toHaveLength(turns1.length);
    });

    it('reparse handles multiple events correctly', () => {
      // Full server-gen scenario: user msg, waiting, reasoning, tool, more reasoning
      const userEvt = userMsg('add a button', { displayContent: 'add a button' });
      const events = [
        userEvt,
        evt('waiting'),
        evt('reasoning_delta', { text: 'I will add a button' }),
        evt('toolCalls', {
          toolCalls: [{ id: 'tc-1', function: { name: 'bash', arguments: '{"command":"cat /index.html"}' } }],
        }),
        evt('tool_status', { toolIndex: 0, status: 'completed', result: '<html>...</html>' }),
      ];
      const turns1 = proc.process(events);

      // Verify initial state is correct
      expect(turns1[0].items.some(i => i.type === 'user')).toBe(true);
      expect(turns1[0].items.some(i => i.type === 'tool')).toBe(true);

      // Now merge projectContext via version bump
      const mergedUser: DebugEvent = {
        ...userEvt,
        version: 2,
        data: {
          message: {
            role: 'user',
            content: 'add a button',
            ui_metadata: {
              displayContent: 'add a button',
              projectContext: 'project files here',
            },
          },
        },
      };
      const events2 = [mergedUser, ...events.slice(1)];
      const turns2 = proc.process(events2);

      // Everything must survive the reparse
      expect(turns2[0].items.some(i => i.type === 'user')).toBe(true);
      expect(turns2[0].items.some(i => i.type === 'project_context')).toBe(true);
      expect(turns2[0].items.some(i => i.type === 'tool')).toBe(true);
      expect(turns2[0].items.some(i => i.type === 'reasoning')).toBe(true);
    });

    it('reparse with no new events still processes all events', () => {
      // This is the exact scenario that caused the bug: version bump triggers
      // reparse but newEventsCount was 0 (computed before startIndex reset),
      // causing the early-return to fire with empty state.
      const userEvt = userMsg('hello', { displayContent: 'hello' });
      const waitEvt = evt('waiting');
      const reasonEvt = evt('reasoning_delta', { text: 'thinking' });

      // Process initial events
      const events1 = [userEvt, waitEvt, reasonEvt];
      const turns1 = proc.process(events1);
      expect(turns1[0].items.some(i => i.type === 'user')).toBe(true);

      // Version bump on user event — same event count, no new events
      const mergedUser: DebugEvent = {
        ...userEvt,
        version: 2,
        data: {
          message: {
            role: 'user',
            content: 'hello',
            ui_metadata: {
              displayContent: 'hello',
              projectContext: 'file tree',
            },
          },
        },
      };
      const events2 = [mergedUser, waitEvt, reasonEvt]; // same length!
      const turns2 = proc.process(events2);

      // CRITICAL: user message must NOT disappear
      expect(turns2.length).toBeGreaterThan(0);
      const allItems = turns2.flatMap(t => t.items);
      expect(allItems.some(i => i.type === 'user')).toBe(true);
      expect(allItems.find(i => i.type === 'user')!.data).toBe('hello');
      expect(allItems.some(i => i.type === 'project_context')).toBe(true);
    });

    it('stabilizes after reparse — no infinite reparse loop', () => {
      const userEvt = userMsg('test', { displayContent: 'test' });
      const events = [userEvt, evt('waiting')];
      proc.process(events);

      // Trigger reparse via version bump
      const merged: DebugEvent = { ...userEvt, version: 2 };
      const events2 = [merged, events[1]];
      const turns2 = proc.process(events2);

      // Process again with same events — should NOT reparse again
      const turns3 = proc.process(events2);
      expect(turns3).toHaveLength(turns2.length);
    });
  });

  describe('assistant text deduplication', () => {
    it('does not duplicate assistant text streamed via delta then finalized via conversation_message', () => {
      const events = [
        userMsg('hello'),
        evt('assistant_delta', { all: [{ text: 'Hi there!' }] }, { id: 'a1' }),
        evt('conversation_message', { message: { role: 'assistant', content: 'Hi there!' } }),
      ];
      const turns = proc.process(events);
      const textItems = turns.flatMap(t => t.items).filter(i => i.type === 'text');
      expect(textItems).toHaveLength(1);
      expect(textItems[0].data).toBe('Hi there!');
    });

    it('still shows assistant text on replay when only conversation_message is present (no delta)', () => {
      const events = [
        userMsg('hello'),
        evt('conversation_message', { message: { role: 'assistant', content: 'Replayed answer' } }),
      ];
      const turns = proc.process(events);
      const textItems = turns.flatMap(t => t.items).filter(i => i.type === 'text');
      expect(textItems).toHaveLength(1);
      expect(textItems[0].data).toBe('Replayed answer');
    });
  });

  describe('interview gate surfacing', () => {
    it('renders an interview_gate event as an interview_gate item', () => {
      const events = [
        userMsg('hello'),
        evt('interview_gate', { complete: true, items: [{ id: 'a', elicit: 'Name', passed: true }] }),
      ];
      const item = proc.process(events).flatMap(t => t.items).find(i => i.type === 'interview_gate');
      expect(item).toBeDefined();
      expect(item!.data.complete).toBe(true);
    });

    it('does not render the gate feedback harness message as a user item', () => {
      const events = [
        userMsg('hello'),
        evt('conversation_message', {
          message: { role: 'user', content: "<automated_reminder>\nNot done yet — these items aren't captured.\n</automated_reminder>" },
        }),
      ];
      const userItems = proc.process(events).flatMap(t => t.items).filter(i => i.type === 'user');
      expect(userItems).toHaveLength(1);
      expect(userItems[0].data).toBe('hello');
    });
  });

  describe('multi-turn conversations', () => {
    it('second user message starts a new turn', () => {
      const events = [
        userMsg('first'),
        evt('assistant_delta', { text: 'reply' }),
        evt('usage', { totalCost: 0.01 }),
        evt('iteration', { iteration: 1 }),
        userMsg('second'),
      ];
      const turns = proc.process(events);
      // First turn has user + assistant text, second turn starts with second user msg
      expect(turns.length).toBeGreaterThanOrEqual(2);
      const lastTurn = turns[turns.length - 1];
      expect(lastTurn.items.some(i => i.type === 'user' && i.data === 'second')).toBe(true);
    });
  });

  describe('front-pruning recovery', () => {
    it('recovers when lastProcessedEventId is pruned from events', () => {
      // Process initial events
      const events1 = [userMsg('msg1'), evt('waiting')];
      proc.process(events1);

      // Simulate front-pruning: completely different event IDs
      const events2 = [
        userMsg('msg2', undefined, { id: 'new-1' }),
        evt('waiting', {}, { id: 'new-2' }),
      ];
      const turns = proc.process(events2);
      expect(turns).toHaveLength(1);
      expect(turns[0].items.some(i => i.type === 'user' && i.data === 'msg2')).toBe(true);
    });
  });

  it('processes toolCalls and tool_status', () => {
    const events = [
      userMsg('list files'),
      evt('toolCalls', {
        toolCalls: [{ id: 'tc-1', function: { name: 'bash', arguments: '{"command":"ls /"}' } }],
      }),
      evt('tool_status', { toolIndex: 0, status: 'executing' }),
      evt('tool_status', { toolIndex: 0, status: 'completed', result: 'index.html\nstyles.css' }),
    ];
    const turns = proc.process(events);
    const toolItems = turns[0].items.filter(i => i.type === 'tool');
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0].data.status).toBe('completed');
    expect(toolItems[0].data.parameters.command).toBe('ls /');
  });

  it('matches tool_status by toolCallId', () => {
    const events = [
      userMsg('edit file'),
      evt('toolCalls', {
        toolCalls: [{ id: 'tc-abc', function: { name: 'bash', arguments: '{"command":"ss /file"}' } }],
      }),
      evt('tool_status', { toolCallId: 'tc-abc', status: 'executing' }),
      evt('tool_status', { toolCallId: 'tc-abc', status: 'failed', error: 'Error: search text not found' }),
    ];
    const turns = proc.process(events);
    const toolItems = turns[0].items.filter(i => i.type === 'tool');
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0].data.status).toBe('failed');
    expect(toolItems[0].data.error).toBe('Error: search text not found');
  });

  it('conversation_message does not overwrite failed tool status', () => {
    const events = [
      userMsg('edit file'),
      evt('toolCalls', {
        toolCalls: [{ id: 'tc-fail', function: { name: 'bash', arguments: '{"command":"ss /file"}' } }],
      }),
      evt('tool_status', { toolCallId: 'tc-fail', status: 'executing' }),
      evt('tool_status', { toolCallId: 'tc-fail', status: 'failed', error: 'Error: ss: search text not found' }),
      evt('tool_result', { toolCallId: 'tc-fail', result: 'Error: ss: search text not found' }),
      evt('conversation_message', {
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'tc-fail', function: { name: 'bash', arguments: '{"command":"ss /file"}' } }] },
      }),
      evt('conversation_message', {
        message: { role: 'tool', content: 'Error: ss: search text not found', tool_call_id: 'tc-fail' },
      }),
    ];
    const turns = proc.process(events);
    const toolItems = turns.flatMap(t => t.items).filter(i => i.type === 'tool');
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0].data.status).toBe('failed');
  });

  it('conversation_message infers failed from Error: prefix on replay', () => {
    const events = [
      userMsg('edit file'),
      evt('conversation_message', {
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'tc-replay', function: { name: 'bash', arguments: '{"command":"ss /file"}' } }] },
      }),
      evt('conversation_message', {
        message: { role: 'tool', content: 'Error: ss: search text not found', tool_call_id: 'tc-replay' },
      }),
    ];
    const turns = proc.process(events);
    const toolItems = turns.flatMap(t => t.items).filter(i => i.type === 'tool');
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0].data.status).toBe('failed');
    expect(toolItems[0].data.error).toBe('Error: ss: search text not found');
  });

  describe('edge cases', () => {
    it('skips internal status nudge prompts', () => {
      const events = [
        userMsg('Before finishing, run the status command to verify all changes.'),
      ];
      const turns = proc.process(events);
      // No user item should be added for nudge prompts
      const allItems = turns.flatMap(t => t.items);
      expect(allItems.filter(i => i.type === 'user')).toHaveLength(0);
    });

    it('skips harness-injected <automated_reminder> nudges (not user input)', () => {
      const events = [
        userMsg('<automated_reminder>\nYour previous response contained only reasoning — invoke a tool or reply with text.\n</automated_reminder>'),
      ];
      const turns = proc.process(events);
      const allItems = turns.flatMap(t => t.items);
      expect(allItems.filter(i => i.type === 'user')).toHaveLength(0);
    });

    it('handles empty events after non-empty (conversation cleared)', () => {
      const events1 = [userMsg('hello'), evt('waiting')];
      proc.process(events1);

      // Clear
      const turns = proc.process([]);
      expect(turns).toEqual([]);

      // New conversation
      const events2 = [userMsg('new start', undefined, { id: 'fresh-1' })];
      const turns2 = proc.process(events2);
      expect(turns2).toHaveLength(1);
      expect(turns2[0].items[0].data).toBe('new start');
    });
  });
});

describe('reasoning accumulation', () => {
  let proc: EventProcessor;

  beforeEach(() => {
    proc = new EventProcessor();
    idCounter = 0;
  });

  it('accumulates multiple reasoning deltas into one item', () => {
    const id = 'r1';
    const events = [
      userMsg('hello'),
      evt('reasoning_delta', { text: 'First ' }, { id }),
      evt('reasoning_delta', { all: [{ text: 'First ' }, { text: 'second ' }] }, { id }),
      evt('reasoning_delta', { all: [{ text: 'First ' }, { text: 'second ' }, { text: 'third' }] }, { id }),
    ];
    const turns = proc.process(events);
    const reasoning = turns[0].items.find(i => i.type === 'reasoning');
    expect(reasoning).toBeDefined();
    expect(reasoning!.data).toBe('First second third');
  });

  it('marks reasoning complete on reasoning_complete event', () => {
    const id = 'r2';
    const events = [
      userMsg('hello'),
      evt('reasoning_delta', { text: 'thinking' }, { id }),
      evt('reasoning_complete', { reasoning: 'thinking' }),
    ];
    const turns = proc.process(events);
    const reasoning = turns[0].items.find(i => i.type === 'reasoning');
    expect(reasoning).toBeDefined();
    expect(reasoning!.complete).toBe(true);
  });

  it('marks reasoning complete when toolCalls arrive', () => {
    const id = 'r3';
    const events = [
      userMsg('hello'),
      evt('reasoning_delta', { text: 'analyzing' }, { id }),
      evt('toolCalls', { toolCalls: [{ id: 'tc1', function: { name: 'bash', arguments: '{"command":"ls"}' } }] }),
    ];
    const turns = proc.process(events);
    const reasoning = turns[0].items.find(i => i.type === 'reasoning');
    expect(reasoning).toBeDefined();
    expect(reasoning!.complete).toBe(true);
  });

  it('skips reasoning item when text is only whitespace', () => {
    const events = [
      userMsg('hello'),
      evt('waiting'),
      evt('reasoning_delta', { text: '   \n  ' }),
    ];
    const turns = proc.process(events);
    expect(turns[0].items.some(i => i.type === 'reasoning')).toBe(false);
    expect(turns[0].items.some(i => i.type === 'waiting')).toBe(false);
  });
});

describe('tool_param_delta accumulation', () => {
  let proc: EventProcessor;

  beforeEach(() => {
    proc = new EventProcessor();
    idCounter = 0;
  });

  it('accumulates fragments into tool parameters with raw text', () => {
    const id = 'pd1';
    const events = [
      userMsg('list files'),
      evt('toolCalls', {
        toolCalls: [{ id: 'tc-1', function: { name: 'bash', arguments: '' } }],
      }),
      evt('tool_param_delta', { toolId: 'tc-1', fragment: '{"command":"ls /' }, { id }),
      evt('tool_param_delta', { all: [
        { toolId: 'tc-1', fragment: '{"command":"ls /' },
        { toolId: 'tc-1', fragment: '"}' },
      ] }, { id }),
    ];
    const turns = proc.process(events);
    const toolItem = turns[0].items.find(i => i.type === 'tool');
    expect(toolItem).toBeDefined();
    expect(toolItem!.data.parameters.command).toBe('ls /');
    expect(toolItem!.data.parameters._raw).toBe('{"command":"ls /"}');
  });

  it('handles multiple tools interleaved in one event stream', () => {
    const id = 'pd2';
    const events = [
      userMsg('do stuff'),
      evt('toolCalls', {
        toolCalls: [
          { id: 'tc-a', function: { name: 'bash', arguments: '' } },
          { id: 'tc-b', function: { name: 'bash', arguments: '' } },
        ],
      }),
      evt('tool_param_delta', { toolId: 'tc-a', fragment: '{"command":"ls"}' }, { id }),
      evt('tool_param_delta', { all: [
        { toolId: 'tc-a', fragment: '{"command":"ls"}' },
        { toolId: 'tc-b', fragment: '{"command":"pwd"}' },
      ] }, { id }),
    ];
    const turns = proc.process(events);
    const tools = turns[0].items.filter(i => i.type === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0].data.parameters.command).toBe('ls');
    expect(tools[1].data.parameters.command).toBe('pwd');
  });

  it('caches cmd extraction from first fragment', () => {
    const id = 'pd3';
    const events = [
      userMsg('write file'),
      evt('toolCalls', {
        toolCalls: [{ id: 'tc-1', function: { name: 'bash', arguments: '' } }],
      }),
      evt('tool_param_delta', { toolId: 'tc-1', fragment: '{"command":"cat > /f' }, { id }),
      evt('tool_param_delta', { all: [
        { toolId: 'tc-1', fragment: '{"command":"cat > /f' },
        { toolId: 'tc-1', fragment: 'ile.txt"}' },
      ] }, { id }),
    ];
    const turns = proc.process(events);
    const toolItem = turns[0].items.find(i => i.type === 'tool');
    // command is cached from first fragment (partial match "cat > /f"), not re-parsed
    expect(toolItem!.data.parameters.command).toBe('cat > /f');
    // _raw has full accumulated text
    expect(toolItem!.data.parameters._raw).toBe('{"command":"cat > /file.txt"}');
  });
});

describe('assistant_delta accumulation', () => {
  let proc: EventProcessor;

  beforeEach(() => {
    proc = new EventProcessor();
    idCounter = 0;
  });

  it('accumulates multiple assistant deltas into one text item', () => {
    const id = 'ad1';
    const events = [
      userMsg('hi'),
      evt('assistant_delta', { text: 'Hello' }, { id }),
      evt('assistant_delta', { all: [{ text: 'Hello' }, { text: ' world' }] }, { id }),
      evt('assistant_delta', { all: [{ text: 'Hello' }, { text: ' world' }, { text: '!' }] }, { id }),
    ];
    const turns = proc.process(events);
    const textItems = turns[0].items.filter(i => i.type === 'text');
    expect(textItems).toHaveLength(1);
    expect(textItems[0].data).toBe('Hello world!');
  });

  it('marks reasoning complete when assistant_delta arrives', () => {
    const rid = 'r-ad';
    const aid = 'a-ad';
    const events = [
      userMsg('hi'),
      evt('reasoning_delta', { text: 'thinking...' }, { id: rid }),
      evt('assistant_delta', { text: 'Here is my answer' }, { id: aid }),
    ];
    const turns = proc.process(events);
    const reasoning = turns[0].items.find(i => i.type === 'reasoning');
    expect(reasoning!.complete).toBe(true);
  });
});

describe('conversation_message role=assistant reconstruction', () => {
  let proc: EventProcessor;

  beforeEach(() => {
    proc = new EventProcessor();
    idCounter = 0;
  });

  it('creates reasoning items (marked complete) and tool items with parsed parameters', () => {
    const events = [
      userMsg('make a page'),
      evt('conversation_message', {
        message: {
          role: 'assistant',
          reasoning_details: [{ text: 'I need to create an HTML file' }],
          tool_calls: [
            {
              id: 'tc-r1',
              function: {
                name: 'bash',
                arguments: '{"command":"cat > /index.html << \'EOF\'\\n<h1>Hello</h1>\\nEOF"}',
              },
            },
          ],
        },
      }),
    ];
    const turns = proc.process(events);
    const reasoning = turns[0].items.find(i => i.type === 'reasoning');
    expect(reasoning).toBeDefined();
    expect(reasoning!.data).toBe('I need to create an HTML file');
    expect(reasoning!.complete).toBe(true);

    const toolItems = turns[0].items.filter(i => i.type === 'tool');
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0].data.id).toBe('tc-r1');
    expect(toolItems[0].data.name).toBe('bash');
    expect(toolItems[0].data.parameters.command).toContain('cat > /index.html');
  });

  it('deduplicates: updates existing tool parameters when toolCalls event already created a tool with empty params', () => {
    const events = [
      userMsg('list files'),
      evt('toolCalls', {
        toolCalls: [{ id: 'tc-dup', function: { name: 'bash', arguments: '' } }],
      }),
      evt('conversation_message', {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'tc-dup',
              function: { name: 'bash', arguments: '{"command":"ls -la /"}' },
            },
          ],
        },
      }),
    ];
    const turns = proc.process(events);
    const toolItems = turns[0].items.filter(i => i.type === 'tool');
    // Should NOT create a duplicate tool — only one tool with id tc-dup
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0].data.id).toBe('tc-dup');
    expect(toolItems[0].data.parameters.command).toBe('ls -la /');
  });

  it('adds assistant text content as a text item', () => {
    const events = [
      userMsg('hi'),
      evt('conversation_message', {
        message: {
          role: 'assistant',
          content: 'Here is my reply.',
        },
      }),
    ];
    const turns = proc.process(events);
    const textItems = turns[0].items.filter(i => i.type === 'text');
    expect(textItems).toHaveLength(1);
    expect(textItems[0].data).toBe('Here is my reply.');
  });
});

describe('tool_status fallback matching', () => {
  let proc: EventProcessor;

  beforeEach(() => {
    proc = new EventProcessor();
    idCounter = 0;
  });

  it('finds and updates the last pending tool when toolIndex is omitted', () => {
    const events = [
      userMsg('do something'),
      evt('toolCalls', {
        toolCalls: [{ id: 'tc-fb', function: { name: 'bash', arguments: '{"command":"echo hi"}' } }],
      }),
      // tool_status WITHOUT toolIndex — should fallback to last pending/executing tool
      evt('tool_status', { status: 'completed', result: 'hi' }),
    ];
    const turns = proc.process(events);
    const toolItem = turns[0].items.find(i => i.type === 'tool');
    expect(toolItem).toBeDefined();
    expect(toolItem!.data.status).toBe('completed');
    expect(toolItem!.data.result).toBe('hi');
  });

  it('selects the last pending tool when multiple tools exist', () => {
    const events = [
      userMsg('do two things'),
      evt('toolCalls', {
        toolCalls: [
          { id: 'tc-m1', function: { name: 'bash', arguments: '{"command":"ls"}' } },
          { id: 'tc-m2', function: { name: 'bash', arguments: '{"command":"pwd"}' } },
        ],
      }),
      // Mark the first tool completed explicitly by index
      evt('tool_status', { toolIndex: 0, status: 'completed', result: 'files' }),
      // Now send a status without toolIndex — should match tc-m2 (last pending)
      evt('tool_status', { status: 'completed', result: '/home' }),
    ];
    const turns = proc.process(events);
    const tools = turns[0].items.filter(i => i.type === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools[0].data.status).toBe('completed');
    expect(tools[0].data.result).toBe('files');
    expect(tools[1].data.status).toBe('completed');
    expect(tools[1].data.result).toBe('/home');
  });
});

describe('tool_status args population', () => {
  let proc: EventProcessor;

  beforeEach(() => {
    proc = new EventProcessor();
    idCounter = 0;
  });

  it('populates tool parameters from args when status is executing and no _raw exists', () => {
    const events = [
      userMsg('run something'),
      evt('toolCalls', {
        toolCalls: [{ id: 'tc-args', function: { name: 'bash', arguments: '' } }],
      }),
      evt('tool_status', {
        toolIndex: 0,
        status: 'executing',
        args: '{"command":"grep -r pattern /src"}',
      }),
    ];
    const turns = proc.process(events);
    const toolItem = turns[0].items.find(i => i.type === 'tool');
    expect(toolItem).toBeDefined();
    expect(toolItem!.data.status).toBe('executing');
    expect(toolItem!.data.parameters.command).toBe('grep -r pattern /src');
  });

  it('prefers _raw over args when _raw exists on parameters', () => {
    const id = 'pd-raw';
    const events = [
      userMsg('run something'),
      evt('toolCalls', {
        toolCalls: [{ id: 'tc-raw', function: { name: 'bash', arguments: '' } }],
      }),
      // Accumulate _raw via tool_param_delta
      evt('tool_param_delta', { toolId: 'tc-raw', fragment: '{"command":"ls /home"}' }, { id }),
      // Now executing status arrives with args — should parse _raw, not args
      evt('tool_status', {
        toolIndex: 0,
        status: 'executing',
        args: '{"command":"different command"}',
      }),
    ];
    const turns = proc.process(events);
    const toolItem = turns[0].items.find(i => i.type === 'tool');
    expect(toolItem).toBeDefined();
    // _raw was '{"command":"ls /home"}' and should be parsed on executing
    expect(toolItem!.data.parameters.command).toBe('ls /home');
  });
});

describe('conversation_message role=tool status transition', () => {
  let proc: EventProcessor;

  beforeEach(() => {
    proc = new EventProcessor();
    idCounter = 0;
  });

  it('matches tool by tool_call_id, sets result, and transitions to completed', () => {
    const events = [
      userMsg('read file'),
      evt('toolCalls', {
        toolCalls: [{ id: 'tc-tr', function: { name: 'bash', arguments: '{"command":"cat /file.txt"}' } }],
      }),
      evt('tool_status', { toolIndex: 0, status: 'executing' }),
      evt('conversation_message', {
        message: {
          role: 'tool',
          tool_call_id: 'tc-tr',
          content: 'file contents here',
        },
      }),
    ];
    const turns = proc.process(events);
    const toolItem = turns[0].items.find(i => i.type === 'tool');
    expect(toolItem).toBeDefined();
    expect(toolItem!.data.status).toBe('completed');
    expect(toolItem!.data.result).toBe('file contents here');
  });

  it('transitions from executing to completed (not only from pending)', () => {
    const events = [
      userMsg('run command'),
      evt('toolCalls', {
        toolCalls: [{ id: 'tc-exec', function: { name: 'bash', arguments: '{"command":"echo test"}' } }],
      }),
      // Explicitly set to executing first
      evt('tool_status', { toolIndex: 0, status: 'executing' }),
      // Verify it is executing at this point
    ];
    let turns = proc.process(events);
    let toolItem = turns[0].items.find(i => i.type === 'tool');
    expect(toolItem!.data.status).toBe('executing');

    // Now conversation_message with role=tool arrives
    const moreEvents = [
      ...events,
      evt('conversation_message', {
        message: {
          role: 'tool',
          tool_call_id: 'tc-exec',
          content: 'test',
        },
      }),
    ];
    turns = proc.process(moreEvents);
    toolItem = turns[0].items.find(i => i.type === 'tool');
    expect(toolItem!.data.status).toBe('completed');
    expect(toolItem!.data.result).toBe('test');
  });

  it('keeps status completed when conversation_message arrives for an already-completed tool', () => {
    const events = [
      userMsg('list'),
      evt('toolCalls', {
        toolCalls: [{ id: 'tc-done', function: { name: 'bash', arguments: '{"command":"ls"}' } }],
      }),
      evt('tool_status', { toolIndex: 0, status: 'completed', result: 'original result' }),
      evt('conversation_message', {
        message: {
          role: 'tool',
          tool_call_id: 'tc-done',
          content: 'new result from conversation',
        },
      }),
    ];
    const turns = proc.process(events);
    const toolItem = turns[0].items.find(i => i.type === 'tool');
    expect(toolItem!.data.status).toBe('completed');
    expect(toolItem!.data.result).toBe('new result from conversation');
  });
});

describe('task_complete clears waiting', () => {
  let proc: EventProcessor;

  beforeEach(() => {
    proc = new EventProcessor();
    idCounter = 0;
  });

  it('removes waiting indicator when task_complete arrives', () => {
    const events = [
      userMsg('hello'),
      evt('waiting'),
      evt('task_complete', {}),
    ];
    const turns = proc.process(events);
    expect(turns[0].items.some(i => i.type === 'waiting')).toBe(false);
  });
});

describe('limit notices', () => {
  const items = (events: DebugEvent[]) => new EventProcessor().process(events).flatMap((t) => t.items);

  it('shows one "trying again" note through repeated retries, gone once the reply starts', () => {
    const during = items([evt('waiting'), evt('retry', { provider: 'groq', attempt: 1, status: 429 }), evt('retry', { provider: 'groq', attempt: 2, status: 429 })]);
    expect(during.filter((i) => i.type === 'notice')).toEqual([expect.objectContaining({ data: { kind: 'retrying', provider: 'groq', status: 429 } })]);

    const after = items([evt('waiting'), evt('retry', { provider: 'groq' }), evt('assistant_delta', { text: 'Hi' })]);
    expect(after.some((i) => i.type === 'notice')).toBe(false);
  });

  it('keeps a model switch in the thread', () => {
    const list = items([
      evt('waiting'),
      // Not 'busy', the default, so the event's own reason has to come through.
      evt('model_switched', { provider: 'openrouter', fromModel: 'a:free', toModel: 'b:free', reason: 'unavailable' }),
      evt('assistant_delta', { text: 'Hi' }),
    ]);
    expect(list.find((i) => i.type === 'notice')?.data).toEqual({ kind: 'switched', provider: 'openrouter', fromModel: 'a:free', toModel: 'b:free', reason: 'unavailable' });
  });
});

describe('EventProcessor — where a turn\'s Restore and Retry go', () => {
  const turnsOf = (events: DebugEvent[]) => new EventProcessor().process(events);

  it('leaves the snapshot a server run takes before it starts off the user\'s message', () => {
    const turns = turnsOf([
      userMsg('build it'),
      evt('checkpoint_created', { checkpointId: 'before' }),
      evt('iteration', { iteration: 1 }),
      evt('assistant_delta', { text: 'Done' }),
      evt('checkpoint_created', { checkpointId: 'after' }),
    ]);
    expect(turns.map((t) => t.checkpointId)).toEqual([undefined, 'after']);
  });

  it('puts the checkpoint taken at the end on the response, not on the next message', () => {
    // The order saved from a real run: the last step opens a turn and ends empty, the run
    // completes, then the end checkpoint arrives, then the next prompt.
    const turns = turnsOf([
      userMsg('build it'),
      evt('waiting'),
      evt('checkpoint_created', { checkpointId: 'before' }),
      evt('iteration', { iteration: 1 }),
      evt('assistant_delta', { text: 'Done' }),
      evt('iteration', { iteration: 2 }),
      evt('waiting'),
      evt('task_complete', {}),
      evt('checkpoint_created', { checkpointId: 'after' }),
      userMsg('next thing'),
    ]);
    const withButtons = turns.filter((t) => t.checkpointId);
    expect(withButtons).toHaveLength(1);
    expect(withButtons[0].checkpointId).toBe('after');
    expect(withButtons[0].items.some((i) => i.type === 'user')).toBe(false);
    expect(turns.at(-1)?.items.some((i) => i.type === 'user')).toBe(true);
    expect(turns.at(-1)?.checkpointId).toBeUndefined();
  });

  it('shows no checkpoint for a response older than the events kept, rather than on the next prompt', () => {
    // The kept events can begin after a run's end, with its checkpoint as the first thing in view.
    const turns = turnsOf([
      evt('task_complete', {}),
      evt('checkpoint_created', { checkpointId: 'older' }),
      userMsg('next thing'),
      evt('iteration', { iteration: 1 }),
      evt('assistant_delta', { text: 'ok' }),
    ]);
    expect(turns.some((t) => t.checkpointId)).toBe(false);
  });

  it('puts the checkpoint on the stopped card when a run stops before any reply', () => {
    const turns = turnsOf([
      userMsg('build it'),
      evt('checkpoint_created', { checkpointId: 'before' }),
      evt('iteration', { iteration: 1 }),
      evt('api_stopped', { errorCategory: 'blocked', provider: 'openrouter' }),
      evt('checkpoint_created', { checkpointId: 'after' }),
    ]);
    expect(turns.at(-1)?.checkpointId).toBe('after');
    expect(turns[0].checkpointId).toBeUndefined();
  });
});

describe('EventProcessor — the model "Free models" picked', () => {
  it('puts the pick in the thread as a notice', () => {
    const list = new EventProcessor().process([evt('model_picked', { provider: 'openrouter', model: 'a:free' })]).flatMap((t) => t.items);
    expect(list.find((i) => i.type === 'notice')?.data).toEqual({ kind: 'picked', provider: 'openrouter', toModel: 'a:free' });
  });

  it('notes the free router\'s model where it changed, and not again while it stays the same', () => {
    const list = new EventProcessor().process([
      userMsg('go'),
      evt('iteration', { iteration: 1 }),
      evt('model_resolved', { provider: 'openrouter', model: 'a:free' }),
      evt('assistant_delta', { text: 'step one' }),
      evt('iteration', { iteration: 2 }),
      evt('model_resolved', { provider: 'openrouter', model: 'a:free' }),
      evt('assistant_delta', { text: 'step two' }),
      evt('iteration', { iteration: 3 }),
      evt('model_resolved', { provider: 'openrouter', model: 'b:free' }),
    ]).flatMap((t) => t.items);
    expect(list.filter((i) => i.type === 'notice').map((i) => i.data.toModel)).toEqual(['a:free', 'b:free']);
  });

  it('notes it again at the start of the next response', () => {
    const list = new EventProcessor().process([
      userMsg('go'),
      evt('model_resolved', { provider: 'openrouter', model: 'a:free' }),
      evt('assistant_delta', { text: 'done' }),
      userMsg('again'),
      evt('model_resolved', { provider: 'openrouter', model: 'a:free' }),
    ]).flatMap((t) => t.items);
    expect(list.filter((i) => i.type === 'notice')).toHaveLength(2);
  });
});

describe('EventProcessor — a run that stops with a tool in flight', () => {
  const tools = (turns: ReturnType<EventProcessor['process']>) =>
    turns.flatMap((t) => t.items).filter((i) => i.type === 'tool').map((i) => i.data.status);

  it.each(['stopped', 'task_complete'])('marks the unfinished tool stopped on %s, leaving finished ones alone', (end) => {
    const proc = new EventProcessor();
    const turns = proc.process([
      userMsg('build it'),
      evt('toolCalls', { toolCalls: [
        { id: 'tc-1', function: { name: 'bash', arguments: '{"command":"ls"}' } },
        { id: 'tc-2', function: { name: 'bash', arguments: '{"command":"npm test"}' } },
      ] }),
      evt('tool_status', { toolCallId: 'tc-1', status: 'completed', result: 'ok' }),
      evt('tool_status', { toolCallId: 'tc-2', status: 'executing' }),
      evt(end, {}),
    ]);
    expect(tools(turns)).toEqual(['completed', 'stopped']);
  });
});


describe('limit notices and stops — waiting indicator', () => {
  const items = (events: DebugEvent[]) => new EventProcessor().process(events).flatMap((t) => t.items);

  it('keeps the "trying again" note when a waiting indicator follows it', () => {
    const list = items([evt('retry', { provider: 'groq', status: 429 }), evt('waiting')]);
    expect(list.filter((i) => i.type === 'notice')).toHaveLength(1);
  });

  it('drops the waiting indicator when the model is switched', () => {
    const list = items([evt('waiting'), evt('model_switched', { provider: 'openrouter', fromModel: 'a', toModel: 'b' })]);
    expect(list.map((i) => i.type)).toEqual(['notice']);
  });

  it('shows a stop on a provider error as its own item, with the event\'s data, and drops waiting', () => {
    const data = { message: 'Daily limit reached', errorCategory: 'daily_limit', provider: 'openrouter' };
    const list = items([evt('waiting'), evt('api_stopped', data)]);
    expect(list.map((i) => i.type)).toEqual(['api_stopped']);
    expect(list[0].data).toEqual(data);
  });
});

describe('EventProcessor — tools left in flight when a run ends', () => {
  const statuses = (turns: ReturnType<EventProcessor['process']>) =>
    turns.flatMap((t) => t.items).filter((i) => i.type === 'tool').map((i) => i.data.status);
  const call = (id: string) => ({ id, function: { name: 'bash', arguments: '{"command":"ls"}' } });

  it('marks a tool that never started as stopped', () => {
    const turns = new EventProcessor().process([
      userMsg('build it'),
      evt('toolCalls', { toolCalls: [call('tc-1')] }),
      evt('task_complete', {}),
    ]);
    expect(statuses(turns)).toEqual(['stopped']);
  });

  it('marks a tool still running in an earlier turn as stopped', () => {
    const turns = new EventProcessor().process([
      userMsg('build it'),
      evt('toolCalls', { toolCalls: [call('tc-1')] }),
      evt('tool_status', { toolCallId: 'tc-1', status: 'executing' }),
      userMsg('and now this'),
      evt('task_complete', {}),
    ]);
    expect(turns.length).toBeGreaterThan(1);
    expect(statuses(turns)).toEqual(['stopped']);
  });
});
