// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act, createContext, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import type { Project } from '@/lib/vfs/types';

/**
 * The Project tab's settings show what was chosen, while the tab is open and when it is opened again.
 *
 * The workspace hands the panel the project it was opened with and never a newer one: a save goes
 * to storage and to the store's own fields, not back into the prop. So the value shown cannot be
 * read from the prop alone.
 */

let stored: Project;
const scheduleAutoSync = vi.fn();
vi.mock('@/lib/vfs', () => ({
  vfs: {
    getProject: async () => structuredClone(stored),
    updateProject: async (project: Project) => { stored = structuredClone(project); },
    scheduleAutoSync: (id: string) => scheduleAutoSync(id),
    listFiles: async () => [],
    readFile: async () => { throw new Error('no file'); },
    createFile: async () => {},
    updateFile: async () => {},
  },
}));
vi.mock('@/lib/vfs/project-schema', () => ({ getProjectSchema: async () => null }));
vi.mock('@/lib/llm/prompts', () => ({ getDomainPrompt: () => '', isDefaultDomainPrompt: () => true }));

// Radix's Select needs pointer capture and layout jsdom does not have; this stand-in keeps its
// contract (a value in, a chosen value out) and renders every item as a button.
vi.mock('@/components/ui/select', () => {
  const Chosen = createContext<(value: string) => void>(() => {});
  return {
    Select: ({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children: React.ReactNode }) => (
      <Chosen.Provider value={onValueChange ?? (() => {})}>
        <div data-select-value={value}>{children}</div>
      </Chosen.Provider>
    ),
    SelectTrigger: ({ id, children }: { id?: string; children: React.ReactNode }) => <div id={id} data-trigger>{children}</div>,
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const choose = useContext(Chosen);
      return <button type="button" data-item={value} onClick={() => choose(value)}>{children}</button>;
    },
  };
});

import { ProjectSettingsPanel } from '../index';

const opened: Project = {
  id: 'p1',
  name: 'Site',
  createdAt: new Date(0),
  updatedAt: new Date(0),
  settings: { runtime: 'handlebars' },
} as Project;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  stored = structuredClone(opened);
  scheduleAutoSync.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

/** The panel as the workspace renders it: the opened project, and an update that goes elsewhere. */
async function mount(onProjectUpdate: (project: Project) => void = () => {}) {
  await act(async () => {
    root.render(withMessages(<ProjectSettingsPanel project={opened} onProjectUpdate={onProjectUpdate} enabled={false} />));
  });
  await settle();
}

/** Closes the panel and opens it again, handed the same project as before. */
async function reopen() {
  act(() => root.unmount());
  root = createRoot(container);
  await mount();
}

/** Types into a field the way React hears it: the value set natively, then an input event. */
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

const button = (text: string) => {
  const found = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === text);
  expect(found, `no ${text} button`).toBeDefined();
  return found as HTMLButtonElement;
};

const opensIn = () => {
  const trigger = container.querySelector('#opens-in');
  expect(trigger, 'no Opens in setting').not.toBeNull();
  return trigger!.closest('[data-select-value]') as HTMLElement;
};

describe('Opens in', () => {
  it('shows the choice once it is saved, though the project it was given is the older one', async () => {
    await mount();
    expect(opensIn().querySelector('[data-trigger]')!.textContent).toBe(en.backend.opensInLast);

    await act(async () => { (opensIn().querySelector('[data-item="canvas"]') as HTMLButtonElement).click(); });
    await settle();

    expect(stored.settings?.opensIn).toBe('canvas');
    expect(opensIn().dataset.selectValue).toBe('canvas');
    expect(opensIn().querySelector('[data-trigger]')!.textContent).toBe(en.backend.opensInCanvas);
  });

  it('shows the saved choice when it is opened again with the same older project', async () => {
    await mount();
    await act(async () => { (opensIn().querySelector('[data-item="preview"]') as HTMLButtonElement).click(); });
    await settle();
    act(() => root.unmount());

    root = createRoot(container);
    await mount();

    expect(opensIn().dataset.selectValue).toBe('preview');
    expect(opensIn().querySelector('[data-trigger]')!.textContent).toBe(en.backend.opensInPreview);
  });
});

const runtime = () => {
  const trigger = container.querySelector('#runtime');
  expect(trigger, 'no Runtime setting').not.toBeNull();
  return trigger!.closest('[data-select-value]') as HTMLElement;
};

async function chooseRuntime(value: string) {
  await act(async () => { (runtime().querySelector(`[data-item="${value}"]`) as HTMLButtonElement).click(); });
  await settle();
}

describe('Runtime', () => {
  it('shows the runtime once it is saved, though the project it was given is the older one', async () => {
    const onProjectUpdate = vi.fn();
    await mount(onProjectUpdate);
    await chooseRuntime('static');

    expect(stored.settings?.runtime).toBe('static');
    expect(runtime().dataset.selectValue).toBe('static');
    expect(runtime().querySelector('[data-trigger]')!.textContent).toBe('Static');
    // The saved project still goes up, which is how the workspace store hears of it, and to sync.
    expect(onProjectUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ runtime: 'static' }) }));
    expect(scheduleAutoSync).toHaveBeenCalledWith('p1');
  });

  it('shows the saved runtime when it is opened again with the same older project', async () => {
    await mount();
    await chooseRuntime('react');
    await reopen();

    expect(runtime().dataset.selectValue).toBe('react');
    expect(runtime().querySelector('[data-trigger]')!.textContent).toBe('React + TypeScript');
  });

  it('offers Opens in by the saved runtime, not the one it was given', async () => {
    await mount();
    expect(container.querySelector('#opens-in')).not.toBeNull();
    await chooseRuntime('python');

    expect(container.querySelector('#opens-in')).toBeNull();
  });
});

const entryPoint = () => {
  const input = container.querySelector('#entry-point');
  expect(input, 'no Preview Entry Point setting').not.toBeNull();
  return input as HTMLInputElement;
};

async function commitEntryPoint(value: string) {
  await act(async () => { type(entryPoint(), value); });
  await act(async () => { entryPoint().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
  await settle();
}

describe('Preview entry point', () => {
  it('shows the saved entry point when it is opened again with the same older project', async () => {
    const onProjectUpdate = vi.fn();
    await mount(onProjectUpdate);
    await commitEntryPoint('/about.html');
    expect(stored.settings?.previewEntryPoint).toBe('/about.html');
    expect(onProjectUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ settings: expect.objectContaining({ previewEntryPoint: '/about.html' }) }));

    await reopen();

    expect(entryPoint().value).toBe('/about.html');
  });

  it('saves a change back to the entry point the project was opened with', async () => {
    await mount();
    await commitEntryPoint('/about.html');
    await commitEntryPoint('/index.html');

    expect(stored.settings?.previewEntryPoint).toBe('/index.html');
  });
});

describe('Chat suggestions', () => {
  it('shows a saved suggestion when it is opened again with the same older project', async () => {
    await mount();
    await act(async () => { button(en.backend.addSuggestion).click(); });
    await act(async () => {
      type(container.querySelector(`[aria-label="${en.backend.ariaSuggestionText.replace('{n}', '1')}"]`) as HTMLInputElement, 'Tidy');
      type(container.querySelector(`[aria-label="${en.backend.ariaSuggestionPrompt.replace('{n}', '1')}"]`) as HTMLTextAreaElement, 'Tidy the page');
    });
    await act(async () => { button(en.common.actions.save).click(); });
    await settle();
    expect(stored.settings?.promptSuggestions?.map((s) => s.label)).toEqual(['Tidy']);
    expect(button(en.common.actions.save).disabled, 'Save still offered after saving').toBe(true);

    await reopen();

    expect((container.querySelector(`[aria-label="${en.backend.ariaSuggestionText.replace('{n}', '1')}"]`) as HTMLInputElement | null)?.value).toBe('Tidy');
  });
});
