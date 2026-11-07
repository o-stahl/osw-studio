// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatThread } from '../thread';
import type { Run, RunContext, RunSegment, RunUsage } from '@/lib/quick-edit/runs';
import type { DebugEvent } from '@/lib/stores/types';
import type { Tally } from '@/lib/quick-edit/tally';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';

// Prose renders through MarkdownRenderer, which routes its links with the app router.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
// The stop card re-checks OSW Studio inference when it shows; nothing here should reach the network.
vi.mock('@/lib/inference/allowance-status', async (original) => ({
  ...(await original<typeof import('@/lib/inference/allowance-status')>()),
  checkAllowance: vi.fn(async () => 'available'),
}));

/**
 * The chat thread, one card per request: the request with what came with it, the run's steps,
 * notices and prose in the order they happened, how it ended, and the actions and figures under it.
 *
 * `splitRuns` and `buildTally` are tested as functions; this is about what the card makes of what
 * they produce. A run that simply worked ends on its steps, while a failure and a run the person
 * stopped report themselves, because nothing else in the card would. The distinction is drawn on
 * `tally.status`, not on the wording, so it survives a rewrite of either message.
 *
 * The request is marked up the way the composer marks it before sending: an element picked on the
 * page or a file brought along appears under the words.
 */

let container: HTMLDivElement;
let root: Root;

function tally(over: Partial<Tally> = {}): Tally {
  return { status: 'done', steps: [], commandCount: 0, filesChanged: [], summary: null, ...over };
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: 'e1',
    request: 'make it blue',
    context: {} as RunContext,
    segments: [],
    activity: null,
    checkpointId: 'cp1',
    approval: null,
    stopped: null,
    usage: null,
    closing: null,
    forming: null,
    ask: null,
    error: null,
    tally: tally(),
    ...over,
  };
}

function mount(runs: Run[], props: Partial<React.ComponentProps<typeof ChatThread>> = {}) {
  act(() => {
    root.render(withMessages(
      <ChatThread
        runs={runs}
        generating={false}
        isDirty={false}
        onRestore={vi.fn()}
        onUndoLatest={null}
        onRedoLatest={null}
        onSave={vi.fn()}
        onAllow={vi.fn()}
        onDeny={vi.fn()}
        {...props}
      />,
    ));
  });
}

const text = () => container.textContent ?? '';

/** The toggle of the context card under a request, when it has one. */
const contextToggle = () => Array.from(container.querySelectorAll('button'))
  .find((b) => (b.textContent ?? '').startsWith('Context'));

/**
 * Open the context card under a request.
 *
 * It renders collapsed, summarising what came along ("1 file"), so what was actually carried is
 * only visible once opened. Asserting on the summary alone would pass for a card that was handed
 * the wrong element.
 */
function openContext() {
  const toggle = contextToggle();
  if (!toggle) throw new Error('no context card under the request');
  act(() => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('a run that finished', () => {
  it('says nothing at the end when it simply worked', () => {
    mount([run({ tally: tally({ status: 'done', filesChanged: ['/a.css'] }) })]);

    // The request and nothing after it: no line reports the outcome of a run that worked.
    expect(text()).toBe('Youmake it blue');
  });

  it('reports a failure, which nothing else in the card would', () => {
    mount([run({ tally: tally({ status: 'failed', summary: { kind: 'failed' } }) })]);

    expect(text()).toContain('Something went wrong');
  });

  it('reports a run the person stopped', () => {
    // A stop leaves the status idle with a summary, which is why the rule cannot be "failed only".
    mount([run({ tally: tally({ status: 'idle', summary: { kind: 'stopped' } }) })]);

    expect(text()).toContain('Stopped.');
  });

  it('offers the way back for an older run', () => {
    const older = run({ id: 'e1', checkpointId: 'cp1' });
    const latest = run({ id: 'e2', checkpointId: 'cp2' });
    mount([older, latest]);

    expect(text()).toContain('Restore');
  });

  it('shows both runs in full rather than folding the older one to a line', () => {
    mount([run({ id: 'e1', request: 'first request' }), run({ id: 'e2', request: 'second request' })]);

    expect(text()).toContain('first request');
    expect(text()).toContain('second request');
  });
});

describe('a run still working', () => {
  it('says what the agent is doing and holds back the outcome', () => {
    mount([run({ activity: 'thinking', tally: tally({ status: 'working', summary: null }) })], { generating: true });

    expect(text()).toContain('Thinking…');
    expect(text()).not.toContain('Restore');
  });

  it('puts a gated command to the person as a sentence', () => {
    mount([run({
      approval: { gateKey: 'network.fetch', capabilityLabel: 'fetch a URL', command: null },
      tally: tally({ status: 'waiting' }),
    })]);

    expect(text()).toContain('Allow');
    expect(text()).toContain("Don't");
  });

  it('names a gate it has no wording for by its own label', () => {
    mount([run({
      approval: { gateKey: 'custom.unknown-gate', capabilityLabel: 'launch the rockets', command: null },
      tally: tally({ status: 'waiting' }),
    })]);

    expect(text()).toContain('launch the rockets');
  });

  it('asks about a gated command only on the newest run, which is the one still waiting', () => {
    const paused = { tally: tally({ status: 'waiting' }), approval: { gateKey: 'rm', capabilityLabel: 'rm / rmdir (delete)', command: null } };
    mount([run({ id: 'e1', ...paused }), run({ id: 'e2', ...paused })]);

    expect(Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'Allow')).toHaveLength(1);
  });

  it('shows the command line an approval is for in the studio, and leaves it out of the simple view', () => {
    const paused = run({
      approval: { gateKey: 'network.fetch', capabilityLabel: 'fetch a URL', command: 'curl -s https://example.com/data.json' },
      tally: tally({ status: 'waiting' }),
    });

    mount([paused]);
    expect(text()).toContain('curl -s https://example.com/data.json');

    mount([paused], { simple: true });
    expect(text()).toContain('Allow');
    expect(text()).not.toContain('curl -s https://example.com/data.json');
  });

  it('answers Don\'t with the gate it was asked about', () => {
    const onDeny = vi.fn();
    mount([run({
      approval: { gateKey: 'network.fetch', capabilityLabel: 'fetch a URL', command: null },
      tally: tally({ status: 'waiting' }),
    })], { onDeny });

    const dont = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === "Don't");
    act(() => { dont!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(onDeny).toHaveBeenCalledWith('network.fetch', 'fetch a URL');
  });

  it('answers Allow with the gate it was asked about', () => {
    const onAllow = vi.fn();
    mount([run({
      approval: { gateKey: 'network.fetch', capabilityLabel: 'fetch a URL', command: null },
      tally: tally({ status: 'waiting' }),
    })], { onAllow });

    const allow = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Allow');
    act(() => { allow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(onAllow).toHaveBeenCalledWith('network.fetch', 'fetch a URL');
  });
});

describe("the person's request", () => {
  it('is shown as they wrote it', () => {
    mount([run({ request: 'make the header sticky' })]);

    expect(text()).toContain('make the header sticky');
  });

  it('carries the element picked on the page', () => {
    mount([run({ context: { focusContext: { domPath: 'body>h1', snippet: '<h1>Hi</h1>' } } })]);
    openContext();

    expect(text()).toContain('body>h1');
  });

  it('carries a file brought along', () => {
    mount([run({ context: { attachedFiles: [{ name: 'brief.md' }] } })]);
    openContext();

    expect(text()).toContain('brief.md');
  });

  it('adds nothing under a request that came with only words', () => {
    mount([run({ context: {} })]);

    expect(contextToggle()).toBeUndefined();
  });

  it('opens onto a recording sent with no words, which would otherwise be an empty bubble', () => {
    const clip = { type: 'input_audio' as const, input_audio: { data: 'AAAA', format: 'wav' as const } };
    mount([run({ request: '', context: { contentBlocks: [clip] } })]);
    expect(container.querySelector('audio')).not.toBeNull();

    mount([run({ id: 'e2', request: 'what do you make of this?', context: { contentBlocks: [clip] } })]);
    expect(container.querySelector('audio')).toBeNull();
  });
});

describe('a group in the simple view', () => {
  let n = 0;
  const ev = (event: string, data: unknown = {}): DebugEvent => ({ id: `q${++n}`, timestamp: n, event, data, count: 1, version: 1 });
  const call = (id: string, command: string) => [
    ev('toolCalls', { toolCalls: [{ id, function: { name: 'bash', arguments: JSON.stringify({ command }) } }] }),
    ev('tool_status', { toolCallId: id, toolName: 'bash', status: 'executing', args: JSON.stringify({ command }) }),
    ev('tool_status', { toolCallId: id, toolName: 'bash', status: 'completed', result: 'done' }),
  ];
  const events = [ev('iteration'), ...call('k1', 'cat /a.html'), ev('iteration'), ...call('k2', 'ss /a.css')];
  const group: RunSegment = {
    kind: 'steps', events, usage: null,
    tally: tally({ steps: [
      { kind: 'read', path: '/a.html', paths: ['/a.html'], steps: 1, callIds: ['k1'], done: true, failed: false },
      { kind: 'edit', path: '/a.css', paths: ['/a.css'], steps: 1, callIds: ['k2'], done: true, failed: false },
    ], commandCount: 2 }),
  };
  const openGroup = () => {
    const header = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').startsWith('Read a.html'))!;
    if (header.getAttribute('aria-expanded') !== 'true') act(() => { header.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    return header.nextElementSibling as HTMLElement;
  };

  it('opens to steps that do not open onto their calls, where the studio\'s do', () => {
    mount([run({ segments: [group] })], { simple: true });
    expect(openGroup().querySelectorAll('button')).toHaveLength(0);

    mount([run({ segments: [group] })]);
    expect(openGroup().querySelectorAll('button').length).toBeGreaterThan(0);
  });
});

describe('an opening', () => {
  it('stands before the runs as the agent\'s first card, in place of the empty thread\'s line', () => {
    mount([], { opening: 'What are you making?' });
    expect(text()).toContain('What are you making?');
    expect(text()).not.toContain('No messages yet');

    mount([run({ request: 'A bakery site' })], { opening: 'What are you making?' });
    expect(text().indexOf('What are you making?')).toBeLessThan(text().indexOf('A bakery site'));
  });
});

describe('an empty thread', () => {
  it('says what to do rather than showing an empty card, which in the simple view is a change to ask for', () => {
    mount([], { simple: true });
    expect(text()).toContain('Say what you want changed');

    mount([]);
    expect(text()).toContain('No messages yet');
    expect(text()).not.toContain('Say what you want changed');
  });
});

/**
 * What the one chat adds to a card: the notices and stop card where they happened, the run's usage
 * line, its closing words, and Retry beside Undo.
 */
describe('the full account of a run', () => {
  const usage = (over: Partial<RunUsage> = {}): RunUsage => ({
    calls: 1, promptTokens: 900, cachedTokens: 800, completionTokens: 100, reasoningTokens: 0, totalTokens: 1_000,
    cost: 0.0012, ms: 5_000, ...over,
  });
  const steps = (over: Partial<Extract<RunSegment, { kind: 'steps' }>> = {}): RunSegment => ({
    kind: 'steps', events: [], usage: null,
    tally: tally({ steps: [{ kind: 'read', path: '/a.html', paths: ['/a.html'], steps: 1, callIds: [], done: true, failed: false }], commandCount: 1 }),
    ...over,
  });
  const limits = createTranslator({ locale: 'en', messages: en, namespace: 'limits' });

  it('shows the card a provider stop leaves, in place of a bare failure line', () => {
    mount([run({
      stopped: { id: 's1', data: { errorCategory: 'daily_limit', provider: 'openrouter', model: 'm' } },
      tally: tally({ status: 'failed', summary: { kind: 'failed' } }),
    })], { onContinue: vi.fn() });

    expect(text()).toContain(limits('titleDaily', { provider: 'OpenRouter' }));
    expect(text()).not.toContain('Something went wrong');
  });

  it('offers to carry on only from the newest run\'s stop, and not while a run is going', () => {
    const stopped = { id: 's1', data: { errorCategory: 'rate_limited', provider: 'groq', model: 'm' } };
    const failed = tally({ status: 'failed', summary: { kind: 'failed' } });

    mount([run({ stopped, tally: failed })], { onContinue: vi.fn() });
    expect(text()).toContain(limits('stoppedHere'));

    // Once something was sent after it, the stop is history.
    mount([run({ id: 'e1', stopped, tally: failed }), run({ id: 'e2', request: 'again' })], { onContinue: vi.fn() });
    expect(text()).not.toContain(limits('stoppedHere'));

    mount([run({ stopped, tally: failed })], { onContinue: vi.fn(), generating: true });
    expect(text()).not.toContain(limits('stoppedHere'));
  });

  it('offers Retry from the checkpoint a run finished on: every run in the studio, the newest in the simple view', () => {
    const onRetry = vi.fn();
    const runs = [run({ id: 'e1', checkpointId: 'cp1' }), run({ id: 'e2', checkpointId: 'cp2' })];
    const retries = () => Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === 'Retry');

    mount(runs, { onRetry });
    expect(retries()).toHaveLength(2);
    act(() => { retries()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onRetry).toHaveBeenLastCalledWith('cp1');

    mount(runs, { onRetry, simple: true });
    expect(retries()).toHaveLength(1);
    act(() => { retries()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onRetry).toHaveBeenLastCalledWith('cp2');
  });

  it('ends a run on its usage line: tokens, cost and time', () => {
    mount([run({ usage: usage({ totalTokens: 854_936, cost: 0.0252, ms: 169_000 }) })]);

    expect(text()).toContain('Tokens: 854,936 • Cost: $0.0252 • 2m 49s');
  });

  it('closes a finished run with its own account of what it did when it ended on steps', () => {
    mount([run({ segments: [steps()], closing: { text: 'Made the header blue', task: 'Make the header blue', remaining: 'none' } })]);

    expect(text()).toContain('Made the header blue');
    expect(text().indexOf('Read a.html')).toBeLessThan(text().indexOf('Made the header blue'));
  });

  it('sets the prose a finished run ended on apart above the actions, once', () => {
    mount([run({ segments: [steps(), { kind: 'text', text: 'The header is blue now.' }] })]);

    expect(text().split('The header is blue now.')).toHaveLength(2);
    // After the rule that closes the steps, and before the actions.
    const rule = container.querySelector('.border-dashed')!;
    const prose = Array.from(container.querySelectorAll('p')).find((el) => el.textContent === 'The header is blue now.')!;
    expect(rule.compareDocumentPosition(prose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(prose.compareDocumentPosition(container.querySelector('.justify-between')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the run\'s notices among its steps, in the order they happened', () => {
    mount([run({
      segments: [
        steps(),
        { kind: 'notice', notice: { kind: 'compaction', before: 38_518, after: 19_137 } },
        { kind: 'notice', notice: { kind: 'correction', text: 'Error: no such file' } },
        { kind: 'notice', notice: { kind: 'limit', data: { kind: 'switched', provider: 'openrouter', fromModel: 'a/x', toModel: 'b/y', reason: 'busy' } } },
      ],
    })]);

    const parts = ['Read a.html', 'Context compacted — 39K → ~19K tokens', 'Auto-correction', limits('switchedBusy', { from: 'x', to: 'y' })];
    for (const part of parts) expect(text()).toContain(part);
    const at = parts.map((part) => text().indexOf(part));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('shows what the run has cost once, at the end, while it is still going, and no icon on any message', () => {
    mount([run({
      segments: [
        { kind: 'text', text: 'Now the two pages:' },
        { kind: 'notice', notice: { kind: 'compaction', before: 1, after: 1 } },
        { kind: 'steps', events: [], usage: usage({ calls: 3 }), tally: tally({ status: 'working', commandCount: 1, steps: [{ kind: 'read', path: '/a.html', paths: ['/a.html'], steps: 1, callIds: [], done: true, failed: false }] }) },
      ],
      activity: 'thinking',
      tally: tally({ status: 'working' }),
      usage: usage({ totalTokens: 120_000, cost: 0.004, ms: 34_000 }),
    })], { generating: true });

    expect(container.querySelector('svg.lucide-info')).toBeNull();
    expect(text().split('Tokens:')).toHaveLength(2);
    const row = container.querySelector('.justify-between')!;
    expect(row.textContent).toContain('Tokens: 120,000 • Cost: $0.0040 • 34s');
    expect(row.lastElementChild!.textContent).toContain('Tokens:');
  });
});

/**
 * How a card is divided and how it ends: a faint rule where a batch of tool calls gives way to prose
 * or to the ending, the run's own account as a row, the actions and the figures on one line, and
 * what is happening while it is live.
 */
describe('the card\'s sections and ending', () => {
  const steps = (): RunSegment => ({
    kind: 'steps', events: [], usage: null,
    tally: tally({ steps: [{ kind: 'read', path: '/a.html', paths: ['/a.html'], steps: 1, callIds: [], done: true, failed: false }], commandCount: 1 }),
  });
  const words = (text: string): RunSegment => ({ kind: 'text', text });
  const compaction: RunSegment = { kind: 'notice', notice: { kind: 'compaction', before: 40_000, after: 20_000 } };
  const rules = () => container.querySelectorAll('.border-border\\/60');

  it('rules off a batch of tool calls from the prose after it and from the ending, and nowhere else', () => {
    mount([run({ segments: [steps(), words('Now the styles:'), steps(), compaction, steps()] })]);

    // After the first batch, before "Now the styles:"; none between that prose and the steps it
    // introduces, none beside the notice; one before the ending.
    expect(rules()).toHaveLength(2);
  });

  it('leaves the ending unruled after a notice, which already divides', () => {
    mount([run({ segments: [steps(), compaction] })]);

    expect(rules()).toHaveLength(0);
  });

  it('says how each row stands in words, with no icon beside it: an account, an error, the work going on', () => {
    // Icons stay on the action buttons, the chevrons that open rows and the figures' (i).
    const strayIcons = () => Array.from(container.querySelectorAll('svg')).filter((svg) => {
      const name = svg.getAttribute('class') ?? '';
      const action = /^(Undo this|Redo this|Retry|Save|Restore)$/.test((svg.closest('button')?.textContent ?? '').trim());
      return !name.includes('lucide-chevron-right') && !name.includes('lucide-info') && !action;
    });

    mount([run({ segments: [steps()], closing: { text: 'Made the header blue', task: 'Make the header blue', remaining: 'none' } })]);
    expect(text()).toContain('Made the header blue');
    expect(strayIcons()).toEqual([]);

    mount([run({ tally: tally({ status: 'failed', summary: { kind: 'failed' } }), error: { message: '401 Unauthorized', stack: 'at x' } })]);
    expect(text()).toContain('401 Unauthorized');
    expect(strayIcons()).toEqual([]);

    mount([run({ activity: 'thinking', tally: tally({ status: 'working', summary: null }) })], { generating: true });
    expect(text()).toContain('Thinking…');
    expect(strayIcons()).toEqual([]);
  });

  it('closes on the run\'s own account as a row that opens onto the task, and what remains only when something does', () => {
    mount([run({ segments: [steps()], closing: { text: 'Made the header blue', task: 'Make the header blue', remaining: 'none' } })]);
    const row = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Made the header blue')!;
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(text()).not.toContain('Make the header blue');

    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(text()).toContain('Task');
    expect(text()).toContain('Make the header blue');
    expect(text()).not.toContain('Remaining');
  });

  it('says what remains when the run left something', () => {
    mount([run({ segments: [steps()], closing: { text: 'Made the header blue', task: 'Make it all blue', remaining: 'the footer' } })]);
    act(() => { Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Made the header blue')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(text()).toContain('Remaining');
    expect(text()).toContain('the footer');
  });

  it('puts the actions and the run\'s figures on one line', () => {
    mount([run({ usage: { calls: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 1, reasoningTokens: 0, totalTokens: 11_429, cost: 0.0009, ms: 0 } })], { onUndoLatest: vi.fn() });
    const row = container.querySelector('.justify-between')!;

    expect(row.textContent).toContain('Undo this');
    expect(row.textContent).toContain('Tokens: 11,429');
  });

  it('keeps "Writing…" under prose that is still streaming, since a tool call may follow it', () => {
    mount([run({ segments: [words('Now the two pages:')], activity: 'writing', tally: tally({ status: 'working' }) })], { generating: true });

    expect(text()).toContain('Writing…');
  });

  it('shows reasoning about a group\'s next step once, in that group, not again on the card', () => {
    const group: RunSegment = {
      kind: 'steps', events: [], usage: null,
      tally: tally({ status: 'working', commandCount: 2, steps: [
        { kind: 'read', path: '/a.html', paths: ['/a.html'], steps: 1, callIds: [], done: true, failed: false },
        { kind: 'edit', path: '/a.css', paths: ['/a.css'], steps: 1, callIds: [], done: true, failed: false },
      ] }),
    };
    mount([run({ segments: [group], activity: 'thinking', tally: tally({ status: 'working' }) })], { generating: true });

    expect(text().split('Thinking…')).toHaveLength(2);
    const thinking = Array.from(container.querySelectorAll('span')).find((el) => el.textContent === 'Thinking…')!;
    expect(thinking.closest('.space-y-1\\.5')).not.toBeNull();
  });

  it('shows the call being written on its own after prose, in place of the activity line', () => {
    mount([run({
      segments: [words('Now the two pages:')], activity: 'working', tally: tally({ status: 'working' }),
      forming: { kind: 'write', path: '/this-week.html', lines: 57 },
    })], { generating: true });

    expect(text()).toContain('Writing this-week.html');
    expect(text()).toContain('57 lines');
    expect(text()).not.toContain('Working…');
  });
});

/**
 * What else a run can end on: a question with options to pick from, an interview's completion
 * check with its follow-up, an error in its own words. And the reasoning of a response that ran no
 * tools, which no group holds.
 */
describe('questions, interviews, errors and reasoning', () => {
  const buttons = (label: string) => Array.from(container.querySelectorAll('button')).filter((b) => (b.textContent ?? '').startsWith(label));
  const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const question = { prompt: 'Aesthetic direction?', options: ['Bold geometric', 'Soft organic'] };
  const steps = (kind: 'read' | 'ask' = 'read'): RunSegment => ({
    kind: 'steps', events: [], usage: null,
    tally: tally({ steps: [{ kind, path: kind === 'read' ? '/a.html' : null, paths: kind === 'read' ? ['/a.html'] : [], steps: 1, callIds: [], done: true, failed: false }], commandCount: 1 }),
  });

  it('ends a run that asked on its question, and sends the option picked as the next message', () => {
    const onAnswer = vi.fn();
    mount([run({ segments: [steps('ask')], ask: question })], { onAnswer });

    expect(text()).toContain('Asked you to choose');
    expect(text()).toContain('Aesthetic direction?');
    click(buttons('Soft organic')[0]);
    expect(onAnswer).toHaveBeenCalledWith('Soft organic');
  });

  it('lets only the newest run\'s question be answered', () => {
    mount([run({ id: 'e1', ask: question }), run({ id: 'e2', ask: question })], { onAnswer: vi.fn() });

    expect(buttons('Bold geometric').map((b) => b.disabled)).toEqual([true, false]);
  });

  it('marks the option an answered question was answered with, from the request that followed', () => {
    // The card is drawn again whenever a run starts, so a pick held only by the chips would be gone.
    const picked = (label: string) => (buttons(label)[0].textContent ?? '').includes('✓');
    mount([run({ id: 'e1', ask: question }), run({ id: 'e2', request: 'Soft organic' })], { onAnswer: vi.fn() });

    expect(picked('Soft organic')).toBe(true);
    expect(picked('Bold geometric')).toBe(false);

    // An answer typed instead marks none of them.
    mount([run({ id: 'e1', ask: question }), run({ id: 'e2', request: 'Something calmer' })], { onAnswer: vi.fn() });
    expect(picked('Soft organic')).toBe(false);
    expect(picked('Bold geometric')).toBe(false);
  });

  it('shows an interview\'s completion check with its follow-up, which waits while a task runs', () => {
    const handoff = { label: 'Build it from the brief', prompt: 'Build the site', mode: 'code' as const };
    const gate: RunSegment = { kind: 'notice', notice: { kind: 'interview', gate: { complete: true, items: [], handoff } } };
    const onHandoff = vi.fn();
    mount([run({ segments: [gate] })], { onHandoff });

    expect(text()).toContain('Interview complete');
    click(buttons('Build it from the brief')[0]);
    expect(onHandoff).toHaveBeenCalledWith(handoff);

    mount([run({ id: 'e1', segments: [gate] }), run({ id: 'e2' })], { onHandoff, generating: true });
    expect(buttons('Build it from the brief')[0].disabled).toBe(true);
  });

  it('lists what an interview is still missing', () => {
    const gate: RunSegment = { kind: 'notice', notice: { kind: 'interview', gate: { complete: false, items: [
      { id: 'a', elicit: 'Brand colours', passed: false, reason: 'not in the brief' },
      { id: 'b', elicit: 'Audience', passed: true },
    ] } } };
    mount([run({ segments: [gate] })]);

    expect(text()).toContain('Not complete yet');
    expect(text()).toContain('Brand colours — not in the brief');
    expect(text()).not.toContain('Audience');
  });

  it('says what went wrong in the error\'s own words, with its stack trace a row away', () => {
    mount([run({
      tally: tally({ status: 'failed', summary: { kind: 'failed' } }),
      error: { message: '401 Unauthorized: Invalid API key', stack: 'Error: 401\n    at call (llm-client.ts:1)' },
    })]);

    expect(text()).toContain('401 Unauthorized: Invalid API key');
    expect(text()).not.toContain('Something went wrong');
    expect(text()).not.toContain('llm-client.ts');
    click(buttons('Stack trace')[0]);
    expect(text()).toContain('at call (llm-client.ts:1)');
  });

  it('keeps its own sentence for an error that came without words, and offers no stack trace it does not have', () => {
    mount([run({ tally: tally({ status: 'failed', summary: { kind: 'failed' } }), error: { message: '', stack: '' } })]);

    expect(text()).toContain('Something went wrong');
    expect(buttons('Stack trace')).toHaveLength(0);
  });

  const reasoning: RunSegment = {
    kind: 'reasoning',
    events: [{ id: 'r1', timestamp: 1, event: 'reasoning_delta', data: { text: 'Two headers, one hidden.\n\nThe hidden one is for print.' }, count: 1, version: 1 }],
  };
  const words = (text: string): RunSegment => ({ kind: 'text', text });
  const rules = () => container.querySelectorAll('.border-border\\/60');

  it('shows the reasoning of a response that ran no tools as a row before its prose, kept with it at the end', () => {
    mount([run({ segments: [steps(), reasoning, words('It has two headers.')] })]);
    const row = buttons('Two headers, one hidden.')[0];

    expect(text()).not.toContain('The hidden one is for print.');
    // A rule before the ending, which holds the reasoning and its prose together, and one under it.
    expect(rules()).toHaveLength(2);
    const prose = Array.from(container.querySelectorAll('p')).find((el) => el.textContent === 'It has two headers.')!;
    expect(rules()[0].compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(prose) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(prose.compareDocumentPosition(rules()[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    click(row);
    expect(text()).toContain('The hidden one is for print.');
  });

  it('rules off a batch of tool calls from the reasoning that opens the next response', () => {
    mount([run({ segments: [steps(), reasoning, words('Now the styles:'), steps()] })]);

    // Before the reasoning, and before the ending; none between the reasoning and its prose.
    expect(rules()).toHaveLength(2);
  });
});

/**
 * A finished card's last line: the actions get a rule above them, and where the line has no room for
 * the tokens and cost beside them, those move into an (i) next to the time.
 */
describe('the actions and the figures', () => {
  const steps: RunSegment = {
    kind: 'steps', events: [], usage: null,
    tally: tally({ steps: [{ kind: 'read', path: '/a.html', paths: ['/a.html'], steps: 1, callIds: [], done: true, failed: false }], commandCount: 1 }),
  };
  const rules = () => Array.from(container.querySelectorAll('.border-border\\/60'));
  const footer = () => container.querySelector('.justify-between')!;
  const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const closing = { text: 'Made the header blue', task: 'Make the header blue', remaining: 'none' };

  it('rules the actions off from what the run ended on, as the ending is from the steps', () => {
    mount([run({ segments: [steps], closing })]);
    const status = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Made the header blue')!;

    expect(rules()).toHaveLength(2);
    expect(follows(rules()[0], status)).toBe(true);
    expect(follows(status, rules()[1])).toBe(true);
    expect(follows(rules()[1], footer())).toBe(true);
  });

  it('keeps one rule above the actions when the run ended on its steps, and none over actions alone', () => {
    mount([run({ segments: [steps] })]);
    expect(rules()).toHaveLength(1);
    expect(follows(rules()[0], footer())).toBe(true);

    mount([run()]);
    expect(rules()).toHaveLength(0);
  });

  describe('where the line has room', () => {
    const usage: RunUsage = {
      calls: 3, promptTokens: 800_000, cachedTokens: 0, completionTokens: 54_936, reasoningTokens: 0, totalTokens: 854_936,
      cost: 0.0252, ms: 169_000,
    };
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!;
    /**
     * jsdom does no layout and reports every width as 0, which reads as a line with room for
     * anything. A row of the given width, and elements as wide as their text, stand in for it.
     */
    function lay(row: number) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return row; } });
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return (this.textContent ?? '').length * 7; } });
    }
    afterEach(() => {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', original);
      vi.unstubAllGlobals();
    });
    const info = () => container.querySelector('button[aria-label="Tokens and cost"]') as HTMLButtonElement | null;

    it('moves the tokens and cost into an (i) beside the time when there is none', () => {
      lay(300);
      mount([run({ usage })], { onUndoLatest: vi.fn(), onRetry: vi.fn() });

      const figures = Array.from(footer().children).find((el) => el.textContent?.startsWith('Tokens:')) as HTMLElement;
      expect(figures.style.visibility).toBe('hidden');
      expect(info()).not.toBeNull();
      expect(info()!.parentElement!.textContent).toBe('2m 49s');

      // The popover places itself with a ResizeObserver, which jsdom does not have.
      vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
      // A tap, which is how a phone opens it: a tooltip opens only on hover or focus.
      act(() => { info()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
      const shown = document.querySelector('[data-slot="popover-content"]');
      expect(shown?.textContent).toContain('Tokens: 854,936 • Cost: $0.0252');
      expect(shown?.textContent).not.toContain('2m 49s');
    });

    it('keeps the full figures on the line when they fit', () => {
      lay(900);
      mount([run({ usage })], { onUndoLatest: vi.fn(), onRetry: vi.fn() });

      expect(info()).toBeNull();
      const figures = Array.from(footer().children).find((el) => el.textContent?.startsWith('Tokens:')) as HTMLElement;
      expect(figures.style.visibility).toBe('');
      expect(figures.textContent).toBe('Tokens: 854,936 • Cost: $0.0252 • 2m 49s');
    });
  });
});
