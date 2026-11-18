// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SCRUB_PX, Stepper } from '../controls';

/**
 * Dragging a Stepper's label to scrub its value, mounted: the press is on the label, the moves and
 * the release are on the window, and what is asserted is which of the three callbacks run when.
 */

let container: HTMLDivElement;
let root: Root;
let onStart: ReturnType<typeof vi.fn<() => void>>;
let onScrub: ReturnType<typeof vi.fn<(steps: number) => void>>;
let onEnd: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onStart = vi.fn();
  onScrub = vi.fn();
  onEnd = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(withMessages(
      <Stepper
        label="Width"
        value="10"
        unit="px"
        units={['px']}
        onStep={vi.fn()}
        onValue={vi.fn()}
        onUnit={vi.fn()}
        onScrubStart={onStart}
        onScrub={onScrub}
        onScrubEnd={onEnd}
      />,
    ));
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const label = () => container.querySelector<HTMLElement>('[data-osw-scrub]')!;
const press = (x: number) => act(() => { label().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x })); });
const moveTo = (x: number) => act(() => { window.dispatchEvent(new PointerEvent('pointermove', { clientX: x })); });

describe('scrubbing a label', () => {
  it('steps from where the press began and ends on release', () => {
    press(100);
    moveTo(100 + SCRUB_PX * 5);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onScrub).toHaveBeenLastCalledWith(5);
    act(() => { window.dispatchEvent(new PointerEvent('pointerup', {})); });
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('ends a scrub the browser cancels, so later moves step nothing', () => {
    press(0);
    moveTo(SCRUB_PX * 5);
    expect(onScrub).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new PointerEvent('pointercancel', {})); });
    expect(onEnd).toHaveBeenCalledTimes(1);
    moveTo(SCRUB_PX * 20);
    expect(onScrub).toHaveBeenCalledTimes(1);
  });

  it('keeps a touch drag on the label rather than handing it to the page to scroll', () => {
    expect(label().style.touchAction).toBe('none');
  });
});
