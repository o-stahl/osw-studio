import { describe, it, expect, beforeEach } from 'vitest';
import { EventProcessor, classifyShellCommand } from '../event-processor';
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
          toolCalls: [{ id: 'tc-1', function: { name: 'shell', arguments: '{"cmd":"cat /index.html"}' } }],
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

  describe('assistant text and tool calls', () => {
    it('processes assistant_delta into text items', () => {
      const events = [
        userMsg('hi'),
        evt('assistant_delta', { text: 'Hello!' }),
      ];
      const turns = proc.process(events);
      expect(turns[0].items.some(i => i.type === 'text' && i.data === 'Hello!')).toBe(true);
    });

    it('processes toolCalls and tool_status', () => {
      const events = [
        userMsg('list files'),
        evt('toolCalls', {
          toolCalls: [{ id: 'tc-1', function: { name: 'shell', arguments: '{"cmd":"ls /"}' } }],
        }),
        evt('tool_status', { toolIndex: 0, status: 'executing' }),
        evt('tool_status', { toolIndex: 0, status: 'completed', result: 'index.html\nstyles.css' }),
      ];
      const turns = proc.process(events);
      const toolItems = turns[0].items.filter(i => i.type === 'tool');
      expect(toolItems).toHaveLength(1);
      expect(toolItems[0].data.status).toBe('completed');
      expect(toolItems[0].data.parameters.cmd).toBe('ls /');
    });
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

describe('classifyShellCommand', () => {
  it('returns shell for undefined', () => {
    expect(classifyShellCommand(undefined)).toBe('shell');
  });

  it('returns delegate for delegate commands', () => {
    expect(classifyShellCommand('delegate explore "find auth"')).toBe('delegate');
  });

  it('returns status for status command', () => {
    expect(classifyShellCommand('status')).toBe('status');
  });

  it('returns status for build command', () => {
    expect(classifyShellCommand('build')).toBe('status');
  });

  it('returns write for cat with redirect', () => {
    expect(classifyShellCommand('cat > /file.txt')).toBe('write');
    expect(classifyShellCommand('cat >/file.txt')).toBe('write');
    expect(classifyShellCommand('cat file.txt > /out.txt')).toBe('write');
  });

  it('returns write for heredoc', () => {
    expect(classifyShellCommand('cat <<EOF')).toBe('write');
    expect(classifyShellCommand("tee /file.txt <<-'HEREDOC'")).toBe('write');
  });

  it('returns write for sed -i', () => {
    expect(classifyShellCommand('sed -i "s/old/new/g" file.txt')).toBe('write');
  });

  it('returns write for ss', () => {
    expect(classifyShellCommand("ss /file.txt << 'EOF'")).toBe('write');
  });

  it('returns write for file-mutating commands', () => {
    expect(classifyShellCommand('mkdir -p /src')).toBe('write');
    expect(classifyShellCommand('touch /file.txt')).toBe('write');
    expect(classifyShellCommand('rm /file.txt')).toBe('write');
    expect(classifyShellCommand('mv /a.txt /b.txt')).toBe('write');
    expect(classifyShellCommand('cp /a.txt /b.txt')).toBe('write');
  });

  it('returns write for echo with redirect', () => {
    expect(classifyShellCommand('echo "hello" >> /file.txt')).toBe('write');
    expect(classifyShellCommand('echo "hello" > /file.txt')).toBe('write');
  });

  it('returns shell for read-only commands', () => {
    expect(classifyShellCommand('ls -la')).toBe('shell');
    expect(classifyShellCommand('cat /file.txt')).toBe('shell');
    expect(classifyShellCommand('grep -r "pattern" /src')).toBe('shell');
  });

  it('handles array input', () => {
    expect(classifyShellCommand(['delegate', 'task', '"prompt"'])).toBe('delegate');
    expect(classifyShellCommand(['ls', '-la'])).toBe('shell');
  });
});
