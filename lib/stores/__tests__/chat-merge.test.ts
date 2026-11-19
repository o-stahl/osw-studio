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
});
