// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Turning the selected element's `src` into something the *app's* document can load.
 *
 * The path arithmetic is `resolveImageSrc` and is asserted as a pure function in
 * `content-state.test.ts`. What needs a DOM, and is therefore here, is the part that touches the
 * outside world: that an address the document can already load costs no storage read at all, that a
 * project path is read and minted, and that the object URL is **revoked** — a session of clicking
 * around the tree otherwise leaves every picture the user glanced at alive in the document.
 */

const readFile = vi.fn();
vi.mock('@/lib/vfs', () => ({
  vfs: { init: vi.fn(async () => {}), readFile: (...a: unknown[]) => readFile(...a) },
}));

import { useSelectedImageUrl } from '../use-image-url';

let container: HTMLDivElement;
let root: Root;

function Probe({ projectId, src }: { projectId: string | null; src?: string }) {
  const url = useSelectedImageUrl(projectId, src, 0);
  return <span data-url={url ?? ''} />;
}

const shown = () => container.firstElementChild?.getAttribute('data-url');

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  // jsdom has no object URLs.
  URL.createObjectURL = vi.fn(() => 'blob:minted');
  URL.revokeObjectURL = vi.fn();
  readFile.mockResolvedValue({ path: '/images/a.png', content: 'bytes' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  container.remove();
});

async function mount(props: { projectId: string | null; src?: string }) {
  await act(async () => { root.render(withMessages(<Probe {...props} />)); });
}

describe('the selected image URL', () => {
  it('reads the project file and mints one', async () => {
    await mount({ projectId: 'p1', src: '/images/a.png' });
    expect(readFile).toHaveBeenCalledWith('p1', '/images/a.png');
    expect(shown()).toBe('blob:minted');
    act(() => root.unmount());
  });

  it('uses an address the document can already load, without touching storage', async () => {
    await mount({ projectId: 'p1', src: 'https://cdn.example.com/a.png' });
    expect(readFile).not.toHaveBeenCalled();
    expect(shown()).toBe('https://cdn.example.com/a.png');
    act(() => root.unmount());
  });

  it('revokes what it minted when the selection goes away', async () => {
    await mount({ projectId: 'p1', src: '/images/a.png' });
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    act(() => root.unmount());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:minted');
  });

  it('answers nothing for a file that is not there, rather than leaving the last one up', async () => {
    // Asserted as a *transition* from a picture to none. Starting from nothing and asserting nothing
    // passes whether the failure is handled or thrown, because null is where the hook begins —
    // the read that throws simply never reports, and the assertion cannot tell that apart.
    await mount({ projectId: 'p1', src: '/images/a.png' });
    expect(shown()).toBe('blob:minted');

    readFile.mockRejectedValue(new Error('no such file'));
    await mount({ projectId: 'p1', src: '/images/gone.png' });
    expect(shown()).toBe('');
    act(() => root.unmount());
  });

  it('asks nothing when there is no project or no src', async () => {
    await mount({ projectId: null, src: '/images/a.png' });
    expect(readFile).not.toHaveBeenCalled();
    expect(shown()).toBe('');

    await mount({ projectId: 'p1', src: undefined });
    expect(readFile).not.toHaveBeenCalled();
    expect(shown()).toBe('');
    act(() => root.unmount());
  });
});
