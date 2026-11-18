import { describe, it, expect } from 'vitest';
import { agentWrites, pagesWritten, HOLD_MS } from '../agent-writing';
import type { DebugEvent } from '@/lib/stores/types';

/**
 * The agent outline is derived from the run's own events: a command streaming in, a command
 * running, and one that finished a moment ago count; anything older does not.
 */

let seq = 0;
const ev = (event: string, data: Record<string, unknown>, timestamp: number): DebugEvent =>
  ({ id: `e${++seq}`, timestamp, event, data, count: 1, version: 1 });
const args = (command: string) => JSON.stringify({ command });

const NOW = 100_000;

describe('agentWrites', () => {
  it('counts a write while it runs and for a moment after, not later', () => {
    const events = [
      ev('tool_status', { toolCallId: 'a', status: 'executing', args: args('cat > /old.css << EOF') }, NOW - 9000),
      ev('tool_status', { toolCallId: 'a', status: 'completed' }, NOW - 9000),
      ev('tool_status', { toolCallId: 'b', status: 'executing', args: args("ss /styles/main.css << 'EOF'") }, NOW - 500),
      ev('tool_status', { toolCallId: 'b', status: 'completed' }, NOW - 400),
      ev('tool_status', { toolCallId: 'c', status: 'executing', args: args('rm /about.html') }, NOW - 10),
    ];
    expect(agentWrites(events, NOW).map((w) => w.paths)).toEqual([['/about.html'], ['/styles/main.css']]);
    expect(agentWrites(events, NOW + HOLD_MS)).toHaveLength(1);
  });

  it('counts a write whose command is still streaming in', () => {
    const events = [ev('tool_param_delta', { all: [
      { toolId: 't1', fragment: '{"command":"cat > /blog.html << \'EOF\'\\n<h1>' },
      { toolId: 't1', fragment: 'Blog' },
    ] }, NOW)];
    expect(agentWrites(events, NOW)).toEqual([{ paths: ['/blog.html'], style: false }]);
  });

  it('ignores reads, and reads a style command as one element\'s change', () => {
    const events = [
      ev('tool_status', { toolCallId: 'r', status: 'executing', args: args('cat /index.html') }, NOW),
      ev('tool_status', { toolCallId: 's', status: 'executing', args: args('style @h7x2m4qp color=red') }, NOW),
    ];
    expect(agentWrites(events, NOW)).toEqual([{ paths: ['/overrides.css'], style: true, marker: 'h7x2m4qp' }]);
  });
});

describe('pagesWritten', () => {
  const pages = new Map([
    ['/index.html', { html: '<h1 data-osw-id="h7x2m4qp">Hi</h1>' }],
    ['/about.html', { html: '<p>About</p>' }],
  ]);
  const deps = new Map([
    ['/index.html', new Set(['/index.html', '/styles/main.css', '/overrides.css', '/templates/nav.hbs'])],
    ['/about.html', new Set(['/about.html', '/styles/about.css', '/overrides.css', '/templates/nav.hbs'])],
  ]);

  it('outlines the pages that use a written file', () => {
    expect(pagesWritten([{ paths: ['/styles/main.css'], style: false }], pages, deps)).toEqual(new Set(['/index.html']));
    expect(pagesWritten([{ paths: ['/templates/nav.hbs'], style: false }], pages, deps)).toEqual(new Set(['/index.html', '/about.html']));
  });

  it('outlines only the page a style command changes, by its file or its marker', () => {
    expect(pagesWritten([{ paths: ['/overrides.css', '/about.html'], style: true }], pages, deps)).toEqual(new Set(['/about.html']));
    expect(pagesWritten([{ paths: ['/overrides.css'], style: true, marker: 'h7x2m4qp' }], pages, deps)).toEqual(new Set(['/index.html']));
  });

  it('outlines every page that links /overrides.css when something else writes it', () => {
    expect(pagesWritten([{ paths: ['/overrides.css'], style: false }], pages, deps)).toEqual(new Set(['/index.html', '/about.html']));
  });
});
