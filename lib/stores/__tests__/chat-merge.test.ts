import { describe, it, expect } from 'vitest';
import { mergeChatEvents } from '../chat-merge';
import type { DebugEvent } from '../types';

const ev = (id: string, event: string, data: Record<string, unknown> = {}, version = 1): DebugEvent =>
  ({ id, timestamp: 1, event, data, count: 1, version });

describe('mergeChatEvents', () => {
  it('takes the newer copy of an event it already has, where it stands', () => {
    const merged = mergeChatEvents(
      [ev('a', 'iteration'), ev('b', 'conversation_message', { message: { role: 'assistant', content: 'part' } })],
      [ev('b', 'conversation_message', { message: { role: 'assistant', content: 'part and the rest' } }, 2)],
      100,
    );
    expect(merged.map(e => [e.id, e.version, e.data.message?.content ?? null])).toEqual([
      ['a', 1, null],
      ['b', 2, 'part and the rest'],
    ]);
  });

  it('drops a waiting event the server sent again, and keeps a second one it did not', () => {
    const merged = mergeChatEvents([ev('w1', 'waiting')], [ev('w2', 'waiting'), ev('w3', 'waiting')], 100);
    expect(merged.map(e => e.id)).toEqual(['w1', 'w3']);
  });

  it('keeps the newest events up to the cap', () => {
    const merged = mergeChatEvents([ev('a', 'iteration'), ev('b', 'iteration')], [ev('c', 'iteration'), ev('d', 'iteration')], 3);
    expect(merged.map(e => e.id)).toEqual(['b', 'c', 'd']);
  });

  /**
   * A page load replays every recent run's buffered events. Each carries the id the server gave it,
   * and the stored copy carries the same one, even after this tab filled it in or folded the
   * server's copy of a prompt into its own message.
   */
  describe('events the server replays after a reload', () => {
    const sse = (task: string, id: number, extra: Record<string, unknown> = {}) => ({ sourceTaskId: task, sourceEventId: id, ...extra });

    it('match their stored copy though this tab has filled it in since', () => {
      const stored = [ev('local-1', 'toolCalls', sse('t1', 5, { toolCalls: [{ id: 'c1', arguments: '{"command":"echo hi"}' }] }))];
      const replayed = [ev('new-1', 'toolCalls', sse('t1', 5, { toolCalls: [{ id: 'c1', arguments: '' }] }))];
      expect(mergeChatEvents(stored, replayed, 100).map(e => e.id)).toEqual(['local-1']);
    });

    it('match the prompt the server\'s copy was folded into, though its text differs', () => {
      const stored = [ev('local-u', 'conversation_message', sse('t1', 3, { message: { role: 'user', content: 'Run 1' } }))];
      const replayed = [ev('new-u', 'conversation_message', sse('t1', 3, { message: { role: 'user', content: [{ type: 'text', text: 'Run 1' }] } }))];
      expect(mergeChatEvents(stored, replayed, 100).map(e => e.id)).toEqual(['local-u']);
    });

    it('keep an event of another run that happens to have the same id, as after a server restart', () => {
      const stored = [ev('old', 'toolCalls', sse('t1', 5))];
      const replayed = [ev('new', 'toolCalls', sse('t2', 5))];
      expect(mergeChatEvents(stored, replayed, 100).map(e => e.id)).toEqual(['old', 'new']);
    });
  });
});
