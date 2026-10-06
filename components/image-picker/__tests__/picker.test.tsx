// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import fi from '@/messages/fi.json';
import { deepMerge } from '@/lib/i18n/merge';

/**
 * The dialog's own wiring, which the pure module cannot reach.
 *
 * Three things only a mounted component can be wrong about: that a click applies *that* row's path,
 * that `needs-confirmation` holds instead of closing, and that the confirm button re-applies with
 * the flag set. The last is the one that matters — a confirm that re-sends `false` produces the same
 * refusal forever, and reads to the user as a button that does nothing.
 */

const listFiles = vi.fn();
vi.mock('@/lib/vfs', () => ({ vfs: { init: vi.fn(async () => {}), listFiles: (...a: unknown[]) => listFiles(...a) } }));

const uploadFileToProject = vi.fn();
vi.mock('@/lib/vfs/upload-file', () => ({
  uploadFileToProject: (...a: unknown[]) => uploadFileToProject(...a),
  uploadTargetPath: (file: File, dir: string) => `${dir === '/' ? '' : dir}/${file.name}`,
}));

import { ImagePicker } from '..';
import type { ApplyResult } from '@/lib/direct-edit/types';
import { imageRefusalAgentPrompt } from '../state';

let container: HTMLDivElement;
let root: Root;
const onApply = vi.fn<(path: string, confirmed: boolean) => Promise<ApplyResult>>();
const onOpenChange = vi.fn();

const FILES = [
  { path: '/images/b.png', content: 'b', type: 'image' },
  { path: '/index.html', content: '<html>', type: 'html' },
  { path: '/images/a.jpg', content: 'a', type: 'image' },
];

beforeEach(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  // jsdom has no object URLs, and the tiles are backgrounds built from them.
  URL.createObjectURL = vi.fn(() => 'blob:stub');
  URL.revokeObjectURL = vi.fn();
  listFiles.mockResolvedValue(FILES);
  onApply.mockResolvedValue({ ok: true, filesWritten: ['/index.html'] });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => {
    root.render(withMessages(
      <ImagePicker
        open
        projectId="p1"
        currentSrc="/images/a.jpg"
        onOpenChange={onOpenChange}
        onApply={onApply}
      />,
    ));
  });
}

/** The dialog portals out of `container`, so every query is against the document. */
const options = () => Array.from(document.querySelectorAll('[data-osw-image-option]'));
const optionPaths = () => options().map(el => el.getAttribute('data-osw-image-option'));
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};
const buttonSaying = (text: string) =>
  Array.from(document.querySelectorAll('button')).find(b => (b.textContent ?? '').includes(text));

describe('ImagePicker', () => {
  it('offers the project images in path order, and nothing else', async () => {
    await mount();
    expect(optionPaths()).toEqual(['/images/a.jpg', '/images/b.png']);
  });

  it('marks the picture the element is already using', async () => {
    await mount();
    const current = options().find(el => el.getAttribute('data-osw-image-option') === '/images/a.jpg')!;
    expect(current.textContent).toContain('in use');
    const other = options().find(el => el.getAttribute('data-osw-image-option') === '/images/b.png')!;
    expect(other.textContent).not.toContain('in use');
  });

  it('applies the row that was clicked, unconfirmed, and closes on success', async () => {
    await mount();
    await click(options()[1]);

    expect(onApply).toHaveBeenCalledWith('/images/b.png', false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('holds a multi-instance replacement open, says the number, and confirms it', async () => {
    onApply.mockResolvedValueOnce({ ok: false, reason: 'needs-confirmation', instances: 3, file: '/index.html' });
    await mount();
    await click(options()[0]);

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('rendered 3 times');

    const confirm = buttonSaying('Replace all 3')!;
    expect(confirm).toBeTruthy();
    await click(confirm);

    // The flag, not a second unconfirmed attempt — which would refuse identically and for ever.
    expect(onApply).toHaveBeenLastCalledWith('/images/a.jpg', true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows a refusal and stays open', async () => {
    onApply.mockResolvedValueOnce({ ok: false, reason: 'expression-src', file: '/index.html' });
    await mount();
    await click(options()[0]);

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('This image is set by the template');
  });

  it('asks the agent in English while the panel speaks Finnish', async () => {
    const onAskAgent = vi.fn();
    onApply.mockResolvedValueOnce({ ok: false, reason: 'expression-src', file: '/index.html' });
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="fi" messages={deepMerge(en, fi)}>
          <ImagePicker
            open
            projectId="p1"
            currentSrc="/images/a.jpg"
            onOpenChange={onOpenChange}
            onApply={onApply}
            onAskAgent={onAskAgent}
          />
        </NextIntlClientProvider>,
      );
    });
    await click(options()[0]);
    await click(buttonSaying(fi.styles.askAgent)!);

    expect(onAskAgent).toHaveBeenCalledWith(imageRefusalAgentPrompt({ reason: 'expression-src', file: '/index.html' }));
    expect(onAskAgent.mock.calls[0][0]).toContain('comes from the template');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not apply an upload that was declined', async () => {
    uploadFileToProject.mockResolvedValue('cancelled');
    await mount();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'new.png')] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });

    expect(uploadFileToProject).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('applies an uploaded file at the path it landed on', async () => {
    uploadFileToProject.mockResolvedValue('ok');
    await mount();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'new.png')] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });

    // Uploaded next to the images the project already has, not into a second folder of its own.
    expect(uploadFileToProject).toHaveBeenCalledWith('p1', expect.any(File), '/images', { quiet: true });
    expect(onApply).toHaveBeenCalledWith('/images/new.png', false);
  });
});
