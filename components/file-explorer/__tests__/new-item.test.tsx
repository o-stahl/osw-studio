// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';

/**
 * New File and New Folder ask for the name in the app's own dialog. The desktop app's Electron has
 * no `window.prompt()`: it throws "prompt() is not supported.", so the buttons did nothing there.
 */

const fake = vi.hoisted(() => ({
  items: [] as Array<{ path: string; name: string; type: 'file' | 'directory' }>,
  createFile: vi.fn(),
  createDirectory: vi.fn(),
}));

vi.mock('@/lib/vfs', () => ({
  vfs: {
    init: async () => {},
    getAllFilesAndDirectories: async () => fake.items.map((item) => ({ ...item })),
    listDirectory: async () => [],
    getGeneratedFiles: () => [],
    isGeneratedPath: () => false,
    getProject: async () => ({ name: 'P' }),
    createFile: fake.createFile,
    createDirectory: fake.createDirectory,
  },
}));
vi.mock('@/lib/vfs/skills', () => ({ skillsService: { getEnabledSkills: async () => [] } }));
vi.mock('@/components/import-dialog', () => ({ ImportDialog: () => null }));
vi.mock('@/components/import-dialog/pick', () => ({ pickFolderSource: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(), warning: vi.fn() } }));

import { FileExplorer } from '../index';
import { createNewItem } from '../new-item';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  fake.items = [
    { path: '/index.html', name: 'index.html', type: 'file' },
    { path: '/images', name: 'images', type: 'directory' },
  ];
  fake.createFile.mockReset().mockResolvedValue({});
  fake.createDirectory.mockReset().mockResolvedValue(undefined);
  // As in the desktop app.
  vi.stubGlobal('prompt', () => { throw new Error('prompt() is not supported.'); });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(withMessages(<FileExplorer projectId="p1" />)); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (title: string) => container.querySelector(`button[title="${title}"]`) as HTMLButtonElement;
/** The open dialog. A closed one can stay in the document for its closing animation. */
const dialog = () => document.querySelector('[role="dialog"][data-state="open"]') as HTMLElement | null;
const field = () => dialog()!.querySelector('input') as HTMLInputElement;

async function open(title: string) {
  await act(async () => { button(title).click(); });
}

async function name(text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(field(), text);
    field().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    dialog()!.querySelector('form')!.requestSubmit();
    // The name is checked, the item written and the tree reloaded over several awaits.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('FileExplorer — naming a new file or folder', () => {
  it('asks for a new file\'s name in its own dialog and creates it at the root', async () => {
    await open('New File');
    expect(dialog()?.textContent).toContain('New File');

    await name('  about.html ');
    await submit();

    expect(fake.createFile).toHaveBeenCalledWith('p1', '/about.html', '');
    expect(dialog()).toBeNull();
  });

  it('asks for a new folder\'s name and creates it', async () => {
    await open('New Folder');
    expect(dialog()?.textContent).toContain('New Folder');

    await name('css');
    await submit();

    expect(fake.createDirectory).toHaveBeenCalledWith('p1', '/css');
    expect(dialog()).toBeNull();
  });

  it('refuses a name a file or folder already has, and keeps the dialog open to change it', async () => {
    await open('New Folder');
    await name('index.html');
    await submit();

    expect(dialog()?.textContent).toContain('index.html already exists here.');
    expect(fake.createDirectory).not.toHaveBeenCalled();

    await name('images');
    await submit();
    expect(dialog()?.textContent).toContain('images already exists here.');
    expect(fake.createDirectory).not.toHaveBeenCalled();
  });

  it('refuses a name that is not one name, without writing anything', async () => {
    await open('New File');
    for (const bad of ['css/site.css', '..']) {
      await name(bad);
      await submit();
      expect(dialog()?.textContent).toContain("A name can't contain / or \\, or be . or ..");
    }
    expect(fake.createFile).not.toHaveBeenCalled();
  });

  it('offers nothing to create until a name is typed', async () => {
    await open('New File');
    const create = [...dialog()!.querySelectorAll('button')].find((b) => b.textContent === 'Create') as HTMLButtonElement;
    expect(create.disabled).toBe(true);

    await name('   ');
    expect(create.disabled).toBe(true);
    await submit();
    expect(fake.createFile).not.toHaveBeenCalled();
  });

  it('says so in the dialog when the file cannot be written', async () => {
    fake.createFile.mockRejectedValueOnce(new Error('File too large'));
    await open('New File');
    await name('notes.md');
    await submit();

    expect(dialog()?.textContent).toContain("Couldn't create notes.md.");
  });
});

describe('createNewItem', () => {
  it('makes the item inside the folder it was asked for', async () => {
    const store = { init: async () => {}, getAllFilesAndDirectories: async () => [], createFile: vi.fn(), createDirectory: vi.fn() };

    expect(await createNewItem(store as never, 'p1', 'file', '/images', 'logo.svg')).toBeNull();
    expect(await createNewItem(store as never, 'p1', 'directory', '/images', 'icons')).toBeNull();

    expect(store.createFile).toHaveBeenCalledWith('p1', '/images/logo.svg', '');
    expect(store.createDirectory).toHaveBeenCalledWith('p1', '/images/icons');
  });
});
