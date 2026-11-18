// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import type { PlacementResult } from '@/lib/preview/types';

/**
 * Which `placement-complete` messages from the preview frame the host acts on.
 *
 * The frame runs the project's own scripts, so a message from it proves only where it came from, not
 * that a drag happened: a page script can post a completed placement whenever it likes. The host
 * takes one only for the block a drop it made is waiting on, and only once.
 */

vi.mock('@/lib/vfs', () => ({ vfs: { init: async () => {} } }));
vi.mock('@/lib/preview/virtual-server', () => ({
  VirtualServer: class {
    async compileProject() {
      return {
        entryPoint: '/index.html',
        routes: [],
        files: [{ path: '/index.html', content: '<html><head></head><body><main></main></body></html>' }],
        blobUrls: new Map<string, string>(),
      };
    }
    cleanupBlobUrls() {}
  },
}));

import { MultipagePreview, type MultipagePreviewHandle } from '../multipage-preview';

const hero = { id: 'hero', name: 'Hero Section', wireframeHtml: '<div data-semantic-placeholder="true">Hero</div>' };
const placed = (blockId: string): PlacementResult => ({ blockId, place: { after: '/index.html:0' }, instances: 1, page: '/index.html' });

let container: HTMLElement;
let root: Root;
let handle: React.RefObject<MultipagePreviewHandle | null>;
let onPlacementComplete: ReturnType<typeof vi.fn<(payload: PlacementResult) => void>>;

const frame = () => {
  const iframe = container.querySelector('iframe');
  expect(iframe, 'the preview never rendered its frame').not.toBeNull();
  return iframe as HTMLIFrameElement;
};

/** A message as the frame's own window posts it. */
function fromFrame(data: unknown) {
  act(() => {
    window.dispatchEvent(Object.assign(new Event('message'), { data, source: frame().contentWindow }));
  });
}

function drop() {
  act(() => { frame().parentElement!.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true })); });
}

function startDrag(block = hero) {
  act(() => { handle.current!.startBlockDrag(block); });
}

beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onPlacementComplete = vi.fn<(payload: PlacementResult) => void>();
  handle = createRef<MultipagePreviewHandle>();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(withMessages(
      <MultipagePreview ref={handle} projectId="p1" standalone onPlacementComplete={onPlacementComplete} />,
    ));
  });
  // The compile resolves over a few turns; the frame is there once it has.
  for (let i = 0; i < 10 && !container.querySelector('iframe'); i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  }
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('a placement-complete from the preview frame', () => {
  it('is ignored when no drop is waiting for it', () => {
    fromFrame({ type: 'placement-complete', payload: placed('hero') });
    expect(onPlacementComplete).not.toHaveBeenCalled();
  });

  it('is ignored while a block is only being dragged, before it is dropped', () => {
    startDrag();
    fromFrame({ type: 'placement-complete', payload: placed('hero') });
    expect(onPlacementComplete).not.toHaveBeenCalled();
  });

  it('is taken once for the block that was dropped', () => {
    startDrag();
    drop();
    fromFrame({ type: 'placement-complete', payload: placed('hero') });
    fromFrame({ type: 'placement-complete', payload: placed('hero') });
    expect(onPlacementComplete).toHaveBeenCalledTimes(1);
    expect(onPlacementComplete).toHaveBeenCalledWith(placed('hero'));
  });

  it('is ignored for a block other than the one that was dropped', () => {
    startDrag();
    drop();
    fromFrame({ type: 'placement-complete', payload: placed('footer') });
    expect(onPlacementComplete).not.toHaveBeenCalled();
  });

  it('is ignored once the frame has cancelled the drop', () => {
    startDrag();
    drop();
    fromFrame({ type: 'placement-cancelled' });
    fromFrame({ type: 'placement-complete', payload: placed('hero') });
    expect(onPlacementComplete).not.toHaveBeenCalled();
  });
});
