// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Importing a `.osws` backup from Settings → Data: an invalid file stops before anything is
 * written, the confirm decides replace against merge, and the progress row names each stage.
 */
const mocks = vi.hoisted(() => ({
  validateBackupFile: vi.fn(),
  importAllData: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@/lib/vfs/backup-service', () => ({
  BackupService: { validateBackupFile: mocks.validateBackupFile, importAllData: mocks.importAllData, exportAllData: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }));
vi.mock('@/components/about-modal', () => ({ AboutModal: () => null }));

import { DataPane } from '../data-pane';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';

let container: HTMLDivElement;
let root: Root;
let picker: HTMLInputElement | null = null;
const file = new File(['{}'], 'backup.osws');

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  picker = null;
  // The pane builds its own file input and clicks it; catch that input instead of opening a dialog.
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
    const el = createElement(tag, options);
    if (tag === 'input') {
      picker = el as HTMLInputElement;
      picker.click = () => {};
    }
    return el;
  });
  vi.stubGlobal('confirm', vi.fn(() => true));
  mocks.validateBackupFile.mockResolvedValue({ valid: true, metadata: { projectCount: 3 } });
  mocks.importAllData.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(withMessages(<DataPane />)); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const importButton = () =>
  Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent === en.common.actions.import || b.textContent === en.settings.importing);

/** Press Import and choose the file; resolves once the handler has run as far as it can. */
async function chooseFile(waitForEnd = true) {
  await act(async () => { importButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  if (!picker) throw new Error('no file picker opened');
  Object.defineProperty(picker, 'files', { value: [file] });
  await act(async () => {
    const run = picker!.onchange?.({ target: picker } as unknown as Event);
    if (waitForEnd) await run;
    else await new Promise((r) => setTimeout(r, 0));
  });
}

describe('importing a backup', () => {
  it('only accepts backup files', async () => {
    await act(async () => { importButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(picker?.accept).toBe('.osws');
  });

  it('stops at an invalid file, says why, and writes nothing', async () => {
    mocks.validateBackupFile.mockResolvedValue({ valid: false, reason: 'not a backup' });
    await chooseFile();
    expect(mocks.toastError).toHaveBeenCalledWith('Invalid backup file: not a backup');
    expect(mocks.importAllData).not.toHaveBeenCalled();
    expect(importButton()?.disabled).toBe(false);
  });

  it('replaces everything when the confirm is accepted, naming the project count', async () => {
    await chooseFile();
    expect(vi.mocked(confirm).mock.calls[0][0]).toContain('Import 3 projects?');
    expect(mocks.importAllData).toHaveBeenCalledWith(file, expect.objectContaining({ mode: 'replace' }));
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it('merges when the confirm is declined', async () => {
    vi.mocked(confirm).mockReturnValue(false);
    await chooseFile();
    expect(mocks.importAllData).toHaveBeenCalledWith(file, expect.objectContaining({ mode: 'merge' }));
  });

  it('names the stage and progress while it runs, then lets go', async () => {
    let finish: () => void = () => {};
    mocks.importAllData.mockImplementation((_f: File, opts: { onProgress: (p: number, s: string) => void }) => {
      opts.onProgress(40, 'clearing');
      return new Promise<void>((resolve) => { finish = resolve; });
    });
    await chooseFile(false);
    expect(container.textContent).toContain(en.settings.importStage.clearing);
    expect(container.textContent).toContain('40%');
    expect(importButton()?.disabled).toBe(true);

    await act(async () => { finish(); });
    expect(container.textContent).not.toContain(en.settings.importStage.clearing);
    expect(importButton()?.disabled).toBe(false);
  });

  it('reports a failed import with its own message', async () => {
    mocks.importAllData.mockRejectedValue(new Error('disk full'));
    await chooseFile();
    expect(mocks.toastError).toHaveBeenCalledWith('disk full');
    expect(importButton()?.disabled).toBe(false);
  });
});
