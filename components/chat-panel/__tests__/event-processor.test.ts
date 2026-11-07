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

    it('makes a turn of the person\'s message, with no item: nothing draws the message from here', () => {
      const turns = proc.process([userMsg('hello')]);
      expect(turns).toHaveLength(1);
      expect(turns[0].items).toEqual([]);
    });

    it('makes no turn of a system message', () => {
      const turns = proc.process([systemMsg('You are an AI assistant'), userMsg('hello')]);
      expect(turns).toHaveLength(1);
    });
  });

  describe('the person\'s messages', () => {
    it('counts the messages the person sent, not the harness\'s or an error sent back to the model', () => {
      proc.process([
        userMsg('make it blue'),
        evt('iteration', {}),
        userMsg('<automated_reminder>\nnudge\n</automated_reminder>'),
        userMsg('Error: no such file', { isSyntheticError: true }),
        evt('task_complete', {}),
        userMsg('and green'),
      ]);
      expect(proc.requests).toBe(2);
    });

    it('counts from the start again for another conversation', () => {
      proc.process([userMsg('make it blue')]);
      proc.process([userMsg('a new chat', undefined, { id: 'other-1' })]);
      expect(proc.requests).toBe(1);
    });
  });

  // ChatPanel counts turns: none is an empty chat.
  describe('what makes a turn', () => {
    it('counts a response that answered, noted or failed, though none of that is an item', () => {
      for (const said of [
        evt('assistant_delta', { text: 'Hi' }),
        evt('model_switched', { provider: 'openrouter', fromModel: 'a', toModel: 'b' }),
        evt('error', { message: 'boom' }),
      ]) {
        const turns = new EventProcessor().process([userMsg('hello'), evt('iteration', {}), said]);
        expect(turns, said.event).toHaveLength(2);
        expect(turns[1].items).toEqual([]);
      }
    });

    it('counts a response while it waits, and not once the wait ends with nothing to show', () => {
      const waited = [userMsg('hello'), evt('iteration', {}), evt('waiting')];
      expect(proc.process(waited)).toHaveLength(2);
      expect(proc.process([...waited, evt('usage', {})])).toHaveLength(1);
    });

    it('keeps an error sent back to the model in the response it interrupted', () => {
      const turns = proc.process([
        userMsg('hello'),
        evt('iteration', {}),
        evt('toolCalls', { toolCalls: [{ id: 'tc-1', function: { name: 'bash', arguments: '{"command":"cat /nope.html"}' } }] }),
        userMsg('Error: no such file', { isSyntheticError: true }),
      ]);
      expect(turns).toHaveLength(2);
      expect(turns[1].items.map((i) => i.type)).toEqual(['tool']);
    });

    it('counts a retry only while it waits', () => {
      const retrying = [userMsg('hello'), evt('iteration', {}), evt('retry', { provider: 'groq', status: 429 })];
      expect(proc.process(retrying)).toHaveLength(2);
      expect(proc.process([...retrying, evt('usage', {})])).toHaveLength(1);
    });
  });

  describe('incremental processing', () => {
    it('processes new events without reprocessing old ones', () => {
      const events1 = [userMsg('hello')];
      expect(proc.process(events1)).toHaveLength(1);

      const events2 = [...events1, evt('reasoning_delta', { text: 'think' })];
      const turns2 = proc.process(events2);
      expect(turns2).toHaveLength(1);
      expect(turns2[0].items.map((i) => i.type)).toEqual(['reasoning']);
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

  // The store merges the server's copy of a request into the one the tab added and bumps its
  // version. Nothing read from here depends on the message's details, so processing carries on.
  describe('a message already read, updated in place', () => {
    const merged = (e: DebugEvent): DebugEvent => ({
      ...e,
      version: 2,
      data: { message: { ...e.data.message, ui_metadata: { ...e.data.message.ui_metadata, projectContext: 'files: index.html' } } },
    });

    it('keeps the conversation through the update', () => {
      // A version bump with no new events once reset the state and returned it empty.
      const userEvt = userMsg('add a button', { displayContent: 'add a button' });
      const rest = [
        evt('waiting'),
        evt('reasoning_delta', { text: 'I will add a button' }),
        evt('toolCalls', { toolCalls: [{ id: 'tc-1', function: { name: 'bash', arguments: '{"command":"cat /index.html"}' } }] }),
        evt('tool_status', { toolIndex: 0, status: 'completed', result: '<html>...</html>' }),
      ];
      proc.process([userEvt, ...rest]);

      const turns = proc.process([merged(userEvt), ...rest]);
      expect(turns).toHaveLength(1);
      expect(turns[0].items.map((i) => i.type)).toEqual(['reasoning', 'tool']);
      expect(turns[0].items[1].data).toMatchObject({ id: 'tc-1', status: 'completed' });
    });

    it('carries on with what arrives after the update', () => {
      const userEvt = userMsg('change welcome to hi');
      const rest = [evt('waiting'), evt('reasoning_delta', { text: 'analyzing...' })];
      proc.process([userEvt, ...rest]);

      const call = evt('toolCalls', { toolCalls: [{ id: 'tc-2', function: { name: 'bash', arguments: '{"command":"ls /"}' } }] });
      const turns = proc.process([merged(userEvt), ...rest, call]);
      expect(turns).toHaveLength(1);
      expect(turns[0].items.map((i) => i.type)).toEqual(['reasoning', 'tool']);
    });
  });

  describe('multi-turn conversations', () => {
    it('second user message starts a new turn', () => {
      const events = [
        userMsg('first'),
        evt('iteration', { iteration: 1 }),
        evt('assistant_delta', { text: 'reply' }),
        evt('usage', { totalCost: 0.01 }),
        evt('task_complete', {}),
        userMsg('second'),
      ];
      // The first request, its answer, and the second request: no response starts between the
      // answer and the next request, so the request itself has to.
      expect(proc.process(events)).toHaveLength(3);
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
      // Read again from the start: msg1's turn, gone with its events, is not kept beside msg2's.
      expect(proc.process(events2)).toHaveLength(1);
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
    it('makes no turn of the harness\'s status nudge, which is no message of the person\'s', () => {
      const events = [
        userMsg('hello'),
        userMsg('Before finishing, run the status command to verify all changes.'),
      ];
      expect(proc.process(events)).toHaveLength(1);
    });

    it('makes no turn of a harness <automated_reminder>, the interview gate\'s feedback among them', () => {
      const events = [
        userMsg('hello'),
        userMsg('<automated_reminder>\nYour previous response contained only reasoning — invoke a tool or reply with text.\n</automated_reminder>'),
      ];
      expect(proc.process(events)).toHaveLength(1);
    });

    it('handles empty events after non-empty (conversation cleared)', () => {
      const events1 = [userMsg('hello'), evt('waiting')];
      proc.process(events1);

      // Clear
      const turns = proc.process([]);
      expect(turns).toEqual([]);

      // New conversation
      const events2 = [userMsg('new start', undefined, { id: 'fresh-1' })];
      expect(proc.process(events2)).toHaveLength(1);
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

  it('skips reasoning item when text is only whitespace', () => {
    const events = [
      userMsg('hello'),
      evt('waiting'),
      evt('reasoning_delta', { text: '   \n  ' }),
    ];
    const turns = proc.process(events);
    expect(turns[0].items.some(i => i.type === 'reasoning')).toBe(false);
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

describe('conversation_message role=assistant reconstruction', () => {
  let proc: EventProcessor;

  beforeEach(() => {
    proc = new EventProcessor();
    idCounter = 0;
  });

  it('rebuilds a replayed message\'s tool calls, with parsed parameters', () => {
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
