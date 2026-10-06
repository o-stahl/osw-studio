// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SimpleThread } from '../thread';
import type { Run, RunContext } from '@/lib/quick-edit/runs';
import type { Tally } from '@/lib/quick-edit/tally';

/**
 * What a finished run says about itself, and what the request carries with it.
 *
 * `splitRuns` and `buildTally` are tested as functions; this is about the two decisions the card
 * makes from what they produce. A run that simply worked ends on its steps — restating them as a
 * count of files says less than the steps already did — while a failure and a run the person
 * stopped have to report themselves, because nothing else in the card would. The distinction is
 * drawn on `tally.status`, not on the wording, so it survives a rewrite of either message.
 *
 * The request is also marked up the way the workspace marks it: an element picked on the page or a
 * file brought along appears under the words, so quick edit and the transcript agree about what
 * was sent.
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
    tally: tally(),
    ...over,
  };
}

function mount(runs: Run[], props: Partial<React.ComponentProps<typeof SimpleThread>> = {}) {
  act(() => {
    root.render(withMessages(
      <SimpleThread
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

/**
 * Open the context card under a request.
 *
 * It renders collapsed, summarising what came along ("1 file"), so what was actually carried is
 * only visible once opened. Asserting on the summary alone would pass for a card that was handed
 * the wrong element.
 */
function openContext() {
  const toggle = Array.from(container.querySelectorAll('button'))
    .find((b) => (b.textContent ?? '').startsWith('Context'));
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
    mount([run({ tally: tally({ status: 'done', summary: { kind: 'changed', files: 1 }, filesChanged: ['/a.css'] }) })]);

    // The summary the tally carries is deliberately not rendered for a run that succeeded.
    expect(text()).not.toContain('Changed 1 file.');
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

  it('counts the files a stopped run had already changed', () => {
    mount([run({ tally: tally({ status: 'idle', summary: { kind: 'changed', files: 3 }, filesChanged: ['/a', '/b', '/c'] }) })]);

    expect(text()).toContain('Changed 3 files.');
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
      approval: { gateKey: 'network.fetch', capabilityLabel: 'fetch a URL' },
      tally: tally({ status: 'waiting' }),
    })]);

    expect(text()).toContain('Allow');
    expect(text()).toContain("Don't");
  });

  it('names a gate it has no wording for by its own label', () => {
    mount([run({
      approval: { gateKey: 'custom.unknown-gate', capabilityLabel: 'launch the rockets' },
      tally: tally({ status: 'waiting' }),
    })]);

    expect(text()).toContain('launch the rockets');
  });

  it('answers Allow with the gate it was asked about', () => {
    const onAllow = vi.fn();
    mount([run({
      approval: { gateKey: 'network.fetch', capabilityLabel: 'fetch a URL' },
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

    expect(text()).not.toContain('focus');
  });
});

describe('an empty thread', () => {
  it('says what to do rather than showing an empty card', () => {
    mount([]);

    expect(text()).toContain('Say what you want changed');
  });
});
