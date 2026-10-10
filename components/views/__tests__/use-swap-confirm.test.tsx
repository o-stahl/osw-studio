// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSwapConfirm } from '../use-swap-confirm';

/**
 * A save that changes a published deployment's project waits on the swap dialog: confirm carries
 * it on, cancel leaves it unsaved, and a view that goes away mid-question settles it as cancelled.
 */

let root: Root;
let hook: ReturnType<typeof useSwapConfirm>;
const details = { deploymentId: 'd1', deploymentName: 'Site', currentProjectId: 'p1', newProjectId: 'p2', newProjectName: 'New' };

function Probe() {
  hook = useSwapConfirm();
  return null;
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
});

async function answer(confirmed: boolean) {
  let asked!: Promise<boolean>;
  act(() => { asked = hook.ask(details); });
  expect(hook.pending).toMatchObject(details);
  await act(async () => hook.pending!.resolve(confirmed));
  return asked;
}

describe('useSwapConfirm', () => {
  it('resolves true on confirm and closes the dialog', async () => {
    expect(await answer(true)).toBe(true);
    expect(hook.pending).toBeNull();
  });

  it('resolves false on cancel and closes the dialog', async () => {
    expect(await answer(false)).toBe(false);
    expect(hook.pending).toBeNull();
  });

  it('settles as cancelled when the view unmounts with the dialog open', async () => {
    let asked!: Promise<boolean>;
    act(() => { asked = hook.ask(details); });
    act(() => root.unmount());
    expect(await asked).toBe(false);
    root = createRoot(document.createElement('div'));
  });
});
