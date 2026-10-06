import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/stores/workspace', () => ({ useWorkspaceStore: { getState: () => ({}) } }));

import { parseBashAction, deriveActivity, deriveUsage } from '..';
import type { DebugEvent } from '@/lib/stores/types';
import type { ActionKind } from '@/lib/agent-activity/parse-command';
import en from '@/messages/en.json';

/** What the background-generation shelf reads out of a task's debug events. */
let n = 0;
const ev = (event: string, data: unknown, timestamp = 1000): DebugEvent =>
  ({ id: String(n++), timestamp, event, data, count: 1, version: 1 });
const tool = (command: string, status: string, timestamp = 1000) =>
  ev('tool_status', { status, args: JSON.stringify({ command }) }, timestamp);

describe('parseBashAction', () => {
  it('reads the command out of the tool arguments', () => {
    expect(parseBashAction(JSON.stringify({ command: 'cat /index.html' }))).toEqual({ kind: 'read', target: '/index.html' });
  });

  it('gives nothing for arguments it cannot read', () => {
    expect(parseBashAction('not json')).toBeNull();
    expect(parseBashAction('{}')).toBeNull();
  });
});

describe('deriveActivity', () => {
  it('keeps the last five actions in order and counts them all', () => {
    const events = Array.from({ length: 7 }, (_, i) => tool(`cat /f${i}.html`, 'completed'));
    const { items, total } = deriveActivity(events, null);
    expect(total).toBe(7);
    expect(items.map((i) => i.target)).toEqual(['/f2.html', '/f3.html', '/f4.html', '/f5.html', '/f6.html']);
  });

  it('carries each action\'s status, and skips other statuses and other events', () => {
    const events = [
      tool('cat /a.html', 'executing'),
      tool('cat /b.html', 'failed'),
      tool('cat /c.html', 'queued'),
      ev('usage', { totalUsage: { totalTokens: 5 } }),
      ev('tool_status', { status: 'completed', args: 'garbage' }),
    ];
    const { items, total } = deriveActivity(events, null);
    expect(total).toBe(2);
    expect(items).toEqual([
      { kind: 'read', target: '/a.html', status: 'executing' },
      { kind: 'read', target: '/b.html', status: 'failed' },
    ]);
  });

  it('counts only this task\'s actions, not an earlier run\'s', () => {
    const events = [tool('cat /old.html', 'completed', 100), tool('cat /new.html', 'completed', 500)];
    const { items, total } = deriveActivity(events, 300);
    expect(total).toBe(1);
    expect(items[0].target).toBe('/new.html');
  });
});

describe('deriveUsage', () => {
  it('reads the latest usage that counted tokens', () => {
    const events = [
      ev('usage', { totalUsage: { totalTokens: 100 }, totalCost: 0.01 }),
      ev('usage', { totalUsage: { totalTokens: 250 }, totalCost: 0.02 }),
      ev('usage', { totalUsage: { totalTokens: 0 }, totalCost: 0 }),
    ];
    expect(deriveUsage(events)).toEqual({ tokens: 250, cost: 0.02 });
  });

  it('gives nothing before any usage arrives', () => {
    expect(deriveUsage([tool('cat /a.html', 'completed')])).toBeNull();
  });
});

describe('the shelf\'s verbs', () => {
  // Every kind the parser can produce, checked by the type: a kind added there without a verb here
  // fails tsc, and a verb missing from en.json fails below instead of rendering a key path.
  const KINDS = {
    write: true, read: true, edit: true, list: true, search: true, create: true, delete: true,
    move: true, copy: true, evaluate: true, delegate: true, lookup: true, image: true,
    database: true, build: true, plan: true, preview: true, run: true, other: true,
  } satisfies Record<ActionKind, true>;

  it.each(Object.keys(KINDS))('words %s both while running and done', (kind) => {
    const verbs = en.generationShelf.verbs as Record<string, { running?: string; done?: string }>;
    expect(verbs[kind]?.running).toBeTruthy();
    expect(verbs[kind]?.done).toBeTruthy();
  });
});
