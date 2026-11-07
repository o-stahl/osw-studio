// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReasoningRows, TallyList } from '../tally-list';
import type { Tally, TallyStep } from '@/lib/quick-edit/tally';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { collate, phraseCollated } from '@/lib/quick-edit/collate';
import type { DebugEvent } from '@/lib/stores/types';
import type { Usage } from '@/lib/quick-edit/runs';
import type { FormingStep } from '@/lib/quick-edit/forming';

// An opened stretch of reasoning renders through MarkdownRenderer, which routes links with the app router.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

/**
 * What a stretch of tool activity looks like at rest, and what it takes to open.
 *
 * `collate` is tested as a function in `lib/quick-edit/__tests__/collate.test.ts`; the sentence it
 * produces is not re-asserted here. What needs a DOM is the choice this component makes *around*
 * that sentence: a stretch of one step is shown as that step, and only a longer one is folded
 * behind a disclosure. A version that collated everything passes every assertion about `collate`
 * and still puts a single row behind a caret, restated in more general words.
 */

let container: HTMLDivElement;
let root: Root;

function step(over: Partial<TallyStep> = {}): TallyStep {
  const base = { kind: 'read' as const, path: '/index.html' as string | null, steps: 1, callIds: [], done: true, failed: false, ...over };
  return { ...base, paths: over.paths ?? (base.path ? [base.path] : []) };
}

function tally(steps: TallyStep[], over: Partial<Tally> = {}): Tally {
  return {
    status: 'done',
    steps,
    commandCount: steps.reduce((n, s) => n + s.steps, 0),
    filesChanged: [],
    summary: null,
    ...over,
  };
}

function mount(t: Tally, live = false, extra: { events?: DebugEvent[]; usage?: Usage | null; forming?: FormingStep | null; thinking?: boolean; simple?: boolean } = {}) {
  act(() => { root.render(withMessages(<TallyList tally={t} live={live} {...extra} />)); });
}

/** The group's own row comes first, so the first button is the disclosure. */
function disclosure(): HTMLButtonElement | null {
  return container.querySelector('button');
}

/**
 * The labels of the step rows on screen.
 *
 * Keyed on the row's own label span and on being outside the disclosure, because the collated
 * sentence is a span too and reads like a step ("Read index.html, then edited styles.css") — a
 * looser selector counts the summary as a row and cannot tell a closed stretch from an open one.
 */
function rowLabels(): string[] {
  return Array.from(container.querySelectorAll('span.flex-1'))
    .filter((el) => el.closest('button') === null)
    .map((el) => el.textContent ?? '');
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

describe('a stretch of tool activity', () => {
  it('shows a single step as itself, with nothing to open', () => {
    mount(tally([step()]));

    expect(disclosure()).toBeNull();
    expect(container.textContent).toContain('Read index.html');
  });

  it('does not restate a single step in more general words', () => {
    // `collate` files a write under the changes it groups ("Edited index.html"); the step says what
    // happened ("Wrote index.html"). A read would not tell the two apart: both name the file.
    mount(tally([step({ kind: 'write' })]));

    expect(container.textContent).toContain('Wrote index.html');
    expect(container.textContent).not.toContain('Edited');
  });

  it('folds a longer stretch behind a disclosure', () => {
    mount(tally([step(), step({ kind: 'edit', path: '/styles.css' })]));

    expect(disclosure()).not.toBeNull();
    // The sentence is showing; the individual rows are not, until it is opened.
    expect(rowLabels()).not.toContain('Edited styles.css');
  });

  it('heads the folded stretch with the collated sentence', () => {
    const t = tally([step(), step({ kind: 'edit', path: '/styles.css' })]);
    mount(t);

    const sentence = phraseCollated(collate(t)!, createTranslator({ locale: 'en', messages: en, namespace: 'quickEdit.collate' }));
    expect(sentence).not.toBe('');
    expect(disclosure()!.textContent).toContain(sentence);
  });

  it('opens onto every step', () => {
    mount(tally([step(), step({ kind: 'edit', path: '/styles.css' })]));

    act(() => { disclosure()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(rowLabels()).toContain('Read index.html');
    expect(rowLabels()).toContain('Edited styles.css');
  });

  it('shows the step in flight under the sentence while the stretch is live', () => {
    const running = step({ kind: 'edit', path: '/styles.css', done: false });
    mount(tally([step(), running], { status: 'working' }), true);

    // Closed, so the only row on screen is the one still running, worded as happening.
    expect(rowLabels()).toEqual(['Editing styles.css…']);
  });

  it('shows no step in flight once the stretch is finished', () => {
    mount(tally([step(), step({ kind: 'edit', path: '/styles.css' })]), false);

    expect(rowLabels()).toEqual([]);
  });

  it('renders nothing for a tally with no steps', () => {
    mount(tally([]));

    expect(container.textContent).toBe('');
  });

  it('counts a repeated step rather than listing it twice', () => {
    mount(tally([step({ path: null, steps: 3 })]));

    expect(container.textContent).toContain('x3');
  });
});

/**
 * A group opened in full: its reasoning and steps from its own events, each step opening onto the
 * tool rows of its calls (`ToolDisplay`), and what it cost. The rows come from `stepDetail` (tested
 * as a function); what needs a DOM is that they are the ones on screen, in order, and that a step
 * opens.
 */
describe('an opened group', () => {
  let n = 0;
  const ev = (event: string, data: unknown = {}): DebugEvent => ({ id: `g${++n}`, timestamp: n, event, data, count: 1, version: 1 });
  const call = (id: string, command: string) => [
    ev('toolCalls', { toolCalls: [{ id, function: { name: 'bash', arguments: JSON.stringify({ command }) } }] }),
    ev('tool_status', { toolCallId: id, toolName: 'bash', status: 'executing', args: JSON.stringify({ command }) }),
    ev('tool_status', { toolCallId: id, toolName: 'bash', status: 'completed', result: 'done' }),
  ];
  const events = [
    ev('iteration'), ev('reasoning_delta', { all: [{ text: 'Read the page before touching it.' }] }), ...call('k1', 'cat /index.html'),
    ev('iteration'), ...call('k2', 'ss /styles.css'),
  ];
  const twoSteps = tally([step({ callIds: ['k1'] }), step({ kind: 'edit', path: '/styles.css', callIds: ['k2'] })]);
  const usage: Usage = { calls: 2, promptTokens: 900, cachedTokens: 800, completionTokens: 100, reasoningTokens: 0, totalTokens: 1_000, cost: 0.0012 };
  const open = () => act(() => { disclosure()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  /** The opened list under the sentence, which the sentence itself is not part of. */
  const list = () => disclosure()!.nextElementSibling as HTMLElement;

  it('lists its reasoning and steps in the order they happened', () => {
    mount(twoSteps, false, { events });
    open();

    const textOf = list().textContent ?? '';
    const thought = textOf.indexOf('Read the page before touching it.');
    expect(thought).toBeGreaterThan(-1);
    expect(thought).toBeLessThan(textOf.indexOf('Read index.html'));
    expect(textOf.indexOf('Read index.html')).toBeLessThan(textOf.indexOf('Edited styles.css'));
  });

  it('opens a step onto the tool row for its call', () => {
    mount(twoSteps, false, { events });
    open();
    const row = Array.from(list().querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Read index.html'))!;
    expect(container.textContent).not.toContain('cat /index.html');

    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container.textContent).toContain('cat /index.html');
    expect(container.textContent).toContain('Parameters');
  });

  /** The `code` elements showing a command, as a step opened onto its calls shows them. */
  const commandLines = (command: string) => Array.from(container.querySelectorAll('code')).filter((c) => c.textContent === command);
  const openStep = (label: string) => {
    const row = Array.from(list().querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(label))!;
    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  };

  it('opens a step straight onto its call, whose command line opens nothing more', () => {
    mount(twoSteps, false, { events });
    open();
    openStep('Read index.html');

    const [line] = commandLines('cat /index.html');
    // The step row above it is what opens and closes the call: the command line is its heading,
    // with nothing on it that reads as a way to open it.
    expect(line.closest('button')).toBeNull();
    expect(line.parentElement!.querySelector('svg.lucide-chevron-right')).toBeNull();
    expect(container.textContent).toContain('Parameters');
    expect(container.textContent).toContain('Result');
  });

  it('opens a step of several calls onto all of them', () => {
    const repeated = [
      ev('iteration'), ...call('k1', 'cat /index.html'), ...call('k3', 'cat /index.html'),
      ev('iteration'), ...call('k2', 'ss /styles.css'),
    ];
    mount(twoSteps, false, { events: repeated });
    open();
    openStep('Read index.html');

    const lines = commandLines('cat /index.html');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.closest('button')).toBeNull();
    expect(container.textContent?.match(/Parameters/g)).toHaveLength(2);
  });

  it('shows nothing as still happening once its run is over, though a call never ran', () => {
    const cutOff = [
      ...events,
      ev('iteration'),
      ev('toolCalls', { toolCalls: [{ id: 'k3', function: { name: 'bash', arguments: '' } }] }),
      ev('tool_param_delta', { all: [{ toolId: 'k3', fragment: '{"command": "cat > /footer.html << \'EOF\'' }] }),
    ];
    mount(twoSteps, false, { events: cutOff });
    open();

    expect(list().textContent).not.toContain('footer.html');
    expect(list().querySelector('.animate-pulse')).toBeNull();
  });

  it('ends on what it cost once the stretch is finished, not while it is still going', () => {
    mount(twoSteps, true, { events, usage });
    open();
    expect(container.textContent).not.toContain('2 calls');

    // The same opened group, as the stretch ends.
    mount(twoSteps, false, { events, usage });
    expect(container.textContent).toContain('2 calls • 900 in (800 cached) • 100 out');
  });

  it('carries no usage icon, opened or not', () => {
    mount(twoSteps, false, { events, usage });
    expect(container.querySelector('svg.lucide-info')).toBeNull();
    open();
    expect(container.querySelector('svg.lucide-info')).toBeNull();
  });

  it('shows every row, with no scroll box capping it', () => {
    mount(twoSteps, false, { events });
    open();
    expect(list().style.maxHeight).toBe('');
  });
});

describe('reasoning among the steps', () => {
  let n = 0;
  const ev = (event: string, data: unknown = {}): DebugEvent => ({ id: `r${++n}`, timestamp: n, event, data, count: 1, version: 1 });
  const call = (id: string, command: string) => [
    ev('toolCalls', { toolCalls: [{ id, function: { name: 'bash', arguments: JSON.stringify({ command }) } }] }),
    ev('tool_status', { toolCallId: id, toolName: 'bash', status: 'executing', args: JSON.stringify({ command }) }),
    ev('tool_status', { toolCallId: id, toolName: 'bash', status: 'completed', result: 'done' }),
  ];
  const twoSteps = tally([step({ callIds: ['k1'] }), step({ kind: 'edit', path: '/styles.css', callIds: ['k2'] })]);
  const open = () => act(() => { disclosure()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const list = () => disclosure()!.nextElementSibling as HTMLElement;

  it('reads as a row like a step: its first line, in the steps\' colour, with no label and no code marks', () => {
    const events = [ev('iteration'), ev('reasoning_delta', { all: [{ text: 'Append before final `})();`.\n\nThen the styles.' }] }), ev('reasoning_complete'), ...call('k1', 'cat /index.html'), ev('iteration'), ...call('k2', 'ss /styles.css')];
    mount(twoSteps, false, { events });
    open();
    const buttons = Array.from(list().querySelectorAll('button'));
    const row = buttons.find((b) => (b.textContent ?? '').includes('Append before final'))!;
    const stepRow = buttons.find((b) => (b.textContent ?? '').includes('Read index.html'))!;

    expect(row.textContent).toBe('Append before final })();.');
    expect(list().textContent).not.toMatch(/reasoning/i);
    // One list, one colour: no row's words among the steps are set apart by a quieter one.
    const words = (button: Element) => button.querySelector('span.flex-1')!;
    expect(words(row).classList.contains('text-muted-foreground')).toBe(false);
    expect(words(stepRow).classList.contains('text-muted-foreground')).toBe(false);
  });

  it('is quiet on its own, above the prose it led to', () => {
    const events = [ev('iteration'), ev('reasoning_delta', { all: [{ text: 'Two headers, one hidden.' }] }), ev('reasoning_complete')];
    act(() => { root.render(withMessages(<ReasoningRows events={events} />)); });

    const row = container.querySelector('button')!;
    expect(row.textContent).toBe('Two headers, one hidden.');
    expect(row.querySelector('span.flex-1')!.classList.contains('text-muted-foreground')).toBe(true);
  });

  it('opens onto the whole of it', () => {
    const events = [ev('iteration'), ev('reasoning_delta', { all: [{ text: 'Append before final.\n\nThen the styles.' }] }), ev('reasoning_complete'), ...call('k1', 'cat /index.html'), ev('iteration'), ...call('k2', 'ss /styles.css')];
    mount(twoSteps, false, { events });
    open();
    const row = Array.from(list().querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('Append before final'))!;
    expect(list().textContent).not.toContain('Then the styles.');

    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(list().textContent).toContain('Then the styles.');
  });

  it('shows the newest words of a stretch still being written, pulsing, with nothing to open', () => {
    const words = 'The page has a header and a footer; now I need to check which styles the plan pages share.';
    const events = [ev('iteration'), ...call('k1', 'cat /index.html'), ev('iteration'), ...call('k2', 'ss /styles.css'), ev('iteration'), ev('reasoning_delta', { all: [{ text: words }] })];
    mount(twoSteps, true, { events });
    open();
    const entries = list().firstElementChild!.children;
    const live = entries[entries.length - 1];

    expect(live.textContent?.startsWith('…')).toBe(true);
    expect(live.textContent?.endsWith('the plan pages share.')).toBe(true);
    expect(live.querySelector('.animate-pulse')).not.toBeNull();
    expect(live.querySelector('button')).toBeNull();
  });
});

/**
 * The rows say their state in words, with nothing beside them on the left: the only icon in a row
 * is the chevron that opens it. Opened, a group's rows hang from it as a tree, each entry holding
 * what its row opens onto.
 */
describe('rows in words, under a tree', () => {
  let n = 0;
  const ev = (event: string, data: unknown = {}): DebugEvent => ({ id: `w${++n}`, timestamp: n, event, data, count: 1, version: 1 });
  const call = (id: string, command: string, status: 'completed' | 'failed' = 'completed') => [
    ev('toolCalls', { toolCalls: [{ id, function: { name: 'bash', arguments: JSON.stringify({ command }) } }] }),
    ev('tool_status', { toolCallId: id, toolName: 'bash', status: 'executing', args: JSON.stringify({ command }) }),
    ev('tool_status', { toolCallId: id, toolName: 'bash', status, result: status === 'failed' ? 'Error: no match' : 'done' }),
  ];
  const events = [
    ev('iteration'), ev('reasoning_delta', { all: [{ text: 'Swap the colour in the stylesheet.' }] }), ev('reasoning_complete'),
    ...call('k1', "sed -i 's/red/blue/' /styles.css", 'failed'),
    ev('iteration'), ...call('k2', 'cat > /styles.css'),
  ];
  const stretch = tally([
    step({ kind: 'edit', path: '/styles.css', callIds: ['k1'], failed: true }),
    step({ kind: 'write', path: '/styles.css', callIds: ['k2'] }),
  ]);
  const open = () => act(() => { disclosure()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const tree = () => (disclosure()!.nextElementSibling as HTMLElement).firstElementChild as HTMLElement;

  it('says a failed step failed, in words, in the same colour as the rows around it', () => {
    mount(stretch, false, { events });
    open();

    expect(tree().textContent).toContain('Tried to edit styles.css, but it failed');
    expect(tree().textContent).toContain('Wrote styles.css');
    const failed = Array.from(tree().querySelectorAll('span.flex-1')).find((el) => el.textContent?.startsWith('Tried to edit'))!;
    expect(failed.classList.contains('text-muted-foreground')).toBe(false);
  });

  it('hangs "Thinking…" from a closed group in the rows\' colour, pulsing', () => {
    mount(tally([step(), step({ kind: 'edit', path: '/styles.css' })]), true, { thinking: true });

    const words = (disclosure()!.nextElementSibling as HTMLElement).querySelector('span.flex-1')!;
    expect(words.textContent).toBe('Thinking…');
    expect(words.classList.contains('animate-pulse')).toBe(true);
    expect(words.classList.contains('text-muted-foreground')).toBe(false);
  });

  it('puts no icon on a row, only the chevron that opens it', () => {
    mount(stretch, false, { events });
    open();

    const icons = Array.from(tree().querySelectorAll('svg')).map((svg) => svg.getAttribute('class') ?? '');
    expect(icons.length).toBeGreaterThan(0);
    expect(icons.every((name) => name.includes('lucide-chevron-right'))).toBe(true);
  });

  it('gives each row an entry of the tree, which holds what the row opens onto', () => {
    mount(stretch, false, { events });
    open();
    const entries = Array.from(tree().children);
    expect(entries.every((entry) => entry.tagName === 'LI')).toBe(true);
    expect(entries.map((entry) => entry.querySelector('button')?.textContent)).toEqual([
      'Swap the colour in the stylesheet.', 'Tried to edit styles.css, but it failed', 'Wrote styles.css',
    ]);

    const failed = entries[1].querySelector('button')!;
    act(() => { failed.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(entries[1].textContent).toContain("sed -i 's/red/blue/' /styles.css");
    expect(entries[2].textContent).not.toContain('sed -i');
  });

  it('hangs the step in flight from a closed group, as the tree\'s only entry', () => {
    const running = step({ kind: 'edit', path: '/styles.css', done: false });
    mount(tally([step(), running], { status: 'working' }), true);

    // The tree, its one entry, and in it the row.
    const hung = disclosure()!.nextElementSibling as HTMLElement;
    expect(hung.children).toHaveLength(1);
    expect(hung.firstElementChild!.tagName).toBe('LI');
    const row = hung.firstElementChild!.firstElementChild!;
    expect(row.textContent).toBe('Editing styles.css…');
    expect(row.querySelector('.animate-pulse')).not.toBeNull();
    expect(hung.querySelector('svg')).toBeNull();
  });

  it('opens a single step onto its reasoning and its call, each an entry of a tree under it', () => {
    const one = [ev('iteration'), ev('reasoning_delta', { all: [{ text: 'Swap the colour in the stylesheet.' }] }), ev('reasoning_complete'), ...call('k9', 'cat > /styles.css')];
    mount(tally([step({ kind: 'write', path: '/styles.css', callIds: ['k9'] })]), false, { events: one });
    const row = container.querySelector('button')!;
    expect(row.textContent).toBe('Wrote styles.css');

    act(() => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // Opened, the step sits above what it opens onto, in a wrapper of its own: found again.
    const opened = container.querySelector('button')!;
    const entries = Array.from((opened.nextElementSibling as HTMLElement).children);
    expect(entries.map((entry) => entry.tagName)).toEqual(['LI', 'LI']);
    expect(entries.map((entry) => (entry.textContent ?? '').includes('Swap the colour'))).toEqual([true, false]);
    expect(entries[1].textContent).toContain('cat > /styles.css');
  });
});

/**
 * Quick edit's simple view opens a group to its rows, and no step opens onto its calls, so no tool
 * call's command or output is reached from there. Reasoning opens in full, in a group as above prose.
 */
describe('the simple view', () => {
  let n = 0;
  const ev = (event: string, data: unknown = {}): DebugEvent => ({ id: `s${++n}`, timestamp: n, event, data, count: 1, version: 1 });
  const call = (id: string, command: string) => [
    ev('toolCalls', { toolCalls: [{ id, function: { name: 'bash', arguments: JSON.stringify({ command }) } }] }),
    ev('tool_status', { toolCallId: id, toolName: 'bash', status: 'executing', args: JSON.stringify({ command }) }),
    ev('tool_status', { toolCallId: id, toolName: 'bash', status: 'completed', result: 'done' }),
  ];
  const thought = (text: string) => [ev('reasoning_delta', { all: [{ text }] }), ev('reasoning_complete')];

  it('opens a group to its rows: its reasoning opens in full, its steps not onto their calls', () => {
    const events = [ev('iteration'), ...thought('Read the page first.\n\nThen the styles.'), ...call('k1', 'cat /index.html'), ev('iteration'), ...call('k2', 'ss /styles.css')];
    mount(tally([step({ callIds: ['k1'] }), step({ kind: 'edit', path: '/styles.css', callIds: ['k2'] })]), false, { events, simple: true });
    act(() => { disclosure()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const tree = (disclosure()!.nextElementSibling as HTMLElement).firstElementChild as HTMLElement;
    expect(tree.textContent).toContain('Read index.html');
    const opens = Array.from(tree.querySelectorAll('button'));
    expect(opens.map((b) => b.textContent)).toEqual(['Read the page first.']);
    expect(tree.textContent).not.toContain('Then the styles.');

    act(() => { opens[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(tree.textContent).toContain('Then the styles.');
    expect(container.textContent).not.toContain('cat /index.html');
  });

  it('opens a single step onto the reasoning that led to it, and not at all without any', () => {
    const one = [ev('iteration'), ...thought('Swap the colour.'), ...call('k9', 'cat > /styles.css')];
    mount(tally([step({ kind: 'write', path: '/styles.css', callIds: ['k9'] })]), false, { events: one, simple: true });
    act(() => { container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(container.textContent).toContain('Swap the colour.');
    expect(container.textContent).not.toContain('cat > /styles.css');

    const bare = [ev('iteration'), ...call('k8', 'cat > /styles.css')];
    mount(tally([step({ kind: 'write', path: '/styles.css', callIds: ['k8'] })]), false, { events: bare, simple: true });
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('the files a step names', () => {
  it('sets them in the quieter colour, after the step\'s own words', () => {
    mount(tally([step({ kind: 'read', path: '/scripts/main.js' })]));

    const words = container.querySelector('span.flex-1')!;
    expect(words.textContent).toBe('Read main.js');
    expect(words.classList.contains('text-muted-foreground')).toBe(false);
    const names = words.querySelector('.text-muted-foreground')!;
    expect(names.textContent).toBe('main.js');
  });

  it('names every file a step read, counting the rest past three', () => {
    mount(tally([step({ path: '/a.html', paths: ['/a.html', '/b.css'] })]));
    expect(container.querySelector('span.flex-1')!.textContent).toBe('Read a.html, b.css');

    mount(tally([step({ path: '/a.html', paths: ['/a.html', '/b.css', '/c.js', '/d.md', '/e.txt'] })]));
    expect(container.querySelector('span.flex-1')!.textContent).toBe('Read a.html, b.css, c.js +2');
  });

  it('names nothing for a step whose kind reads the same whatever it touched', () => {
    mount(tally([step({ kind: 'search', path: null })]));

    const words = container.querySelector('span.flex-1')!;
    expect(words.textContent).toBe('Searched the project');
    expect(words.querySelector('.text-muted-foreground')).toBeNull();
  });
});

describe('the call being written', () => {
  it('shows under a closed group while the stretch is live, worded as happening, with the lines in so far', () => {
    mount(tally([step(), step({ kind: 'edit', path: '/styles.css' })]), true, { forming: { kind: 'write', path: '/this-week.html', lines: 57 } });

    expect(container.textContent).toContain('Writing this-week.html');
    expect(container.textContent).toContain('57 lines');
  });

  it('is not shown once the stretch is no longer live', () => {
    mount(tally([step(), step({ kind: 'edit', path: '/styles.css' })]), false, { forming: { kind: 'write', path: '/this-week.html', lines: 57 } });

    expect(container.textContent).not.toContain('Writing');
  });
});
