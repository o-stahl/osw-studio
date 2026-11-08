// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Bug, File, Folder, FolderTree, History, Import, MessageSquare, Trash2, Upload } from 'lucide-react';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import { PanelDockProvider, PanelHeader, type PanelAction, type PanelDockContext, type PanelDockHeader } from '../panel';

/**
 * The panel header: a lone panel's title or a group's tab strip, both handles for the workspace's
 * docking, and actions that move into a ⋯ menu when the header runs out of room.
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // A focused tab shows its tooltip, which places itself with a ResizeObserver; jsdom has none.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tab = (key: string, title: string, icon = MessageSquare, badge: 'unread' | 'busy' | null = null) => ({ key, title, icon, color: 'red', badge });

function dock(header: Partial<PanelDockHeader> | null, overrides: Partial<PanelDockContext> = {}): PanelDockContext {
  return {
    header: () => (header ? { tabs: [tab('chat', 'Chat')], active: 'chat', maximized: false, ...header } : null),
    onPointerDown: vi.fn(),
    onActivate: vi.fn(),
    onToggleMaximize: vi.fn(),
    Menu: ({ children }) => children,
    consumeClick: () => false,
    ...overrides,
  };
}

function render(ctx: PanelDockContext | null, props: Partial<React.ComponentProps<typeof PanelHeader>> = {}) {
  act(() => root.render(withMessages(
    <PanelDockProvider value={ctx}>
      <PanelHeader icon={MessageSquare} title="Chat" panelKey="chat" onClose={() => {}} {...props} />
    </PanelDockProvider>,
  )));
}

const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
const grip = () => container.querySelector<HTMLButtonElement>('button[aria-label^="Drag to move"]');
const slots = () => Array.from(container.querySelectorAll<HTMLElement>('[data-panel-action]'));
const more = () => container.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!;

describe('PanelHeader without docking', () => {
  it('shows its title and no grip, as on a phone or in quick edit', () => {
    render(null);
    expect(container.querySelector('[data-panel-title]')?.textContent).toBe('Chat');
    expect(grip()).toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });

  it('renders each action as a button named by its label', () => {
    const onSelect = vi.fn();
    render(null, { actions: [{ id: 'clear', icon: Trash2, label: 'Clear chat', onSelect }] });
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Clear chat"]')!;
    act(() => button.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('PanelHeader with docking', () => {
  it('makes a lone panel\'s title a handle: a press starts a drag of the panel, a double-click maximizes', () => {
    const ctx = dock({});
    render(ctx);
    const title = container.querySelector<HTMLElement>('[data-panel-title]')!;
    act(() => { title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); });
    expect(ctx.onPointerDown).toHaveBeenCalledWith(expect.anything(), 'chat', false);
    act(() => { title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(ctx.onToggleMaximize).toHaveBeenCalledWith('chat');
  });

  it('draws a group as tabs, the front one selected, with a background tab\'s unread dot', () => {
    render(dock({ tabs: [tab('chat', 'Chat'), tab('console', 'Console', Bug, 'unread')], active: 'chat' }));
    expect(tabs().map((t) => [t.dataset.panelTab, t.getAttribute('aria-selected')])).toEqual([['chat', 'true'], ['console', 'false']]);
    expect(tabs()[1].textContent).toBe('ConsoleUnread output');
    expect(tabs()[0].textContent).toBe('Chat');
  });

  it('brings a clicked tab to the front, unless the click ended a drag', () => {
    const ctx = dock({ tabs: [tab('chat', 'Chat'), tab('checkpoints', 'Checkpoints', History)], active: 'chat' });
    render(ctx);
    act(() => tabs()[1].click());
    expect(ctx.onActivate).toHaveBeenCalledWith('checkpoints');
    const dragged = dock({ tabs: [tab('chat', 'Chat'), tab('checkpoints', 'Checkpoints', History)], active: 'chat' }, { consumeClick: () => true });
    render(dragged);
    act(() => tabs()[1].click());
    expect(dragged.onActivate).not.toHaveBeenCalled();
  });

  it('moves along the strip with the arrow keys and activates with Enter', () => {
    const ctx = dock({ tabs: [tab('chat', 'Chat'), tab('checkpoints', 'Checkpoints', History), tab('debug', 'Debug Events', Bug)], active: 'chat' });
    render(ctx);
    act(() => tabs()[0].focus());
    act(() => { tabs()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(document.activeElement).toBe(tabs()[2]);
    act(() => { tabs()[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(ctx.onActivate).toHaveBeenCalledWith('debug');
  });

  it('shows a drop\'s tabs dashed in the strip, and they take no clicks', () => {
    const ctx = dock({ tabs: [tab('chat', 'Chat'), tab('files', 'File Explorer', FolderTree)], active: 'chat', ghosts: ['files'] });
    render(ctx);
    const ghost = tabs().find((t) => t.hasAttribute('data-ghost'))!;
    expect(ghost.textContent).toBe('File Explorer');
    act(() => ghost.click());
    expect(ctx.onActivate).not.toHaveBeenCalled();
  });

  it('gives a group\'s grip to the whole group', () => {
    const ctx = dock({ tabs: [tab('chat', 'Chat'), tab('checkpoints', 'Checkpoints', History)], active: 'chat' });
    render(ctx);
    act(() => { grip()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); });
    expect(ctx.onPointerDown).toHaveBeenCalledWith(expect.anything(), 'chat', true);
  });

  it('opens the panel menu from Shift+F10 or the Menu key, which a Mac does not turn into a right-click', () => {
    render(dock({ tabs: [tab('chat', 'Chat'), tab('checkpoints', 'Checkpoints', History)], active: 'chat' }));
    const opened: string[] = [];
    container.addEventListener('contextmenu', (e) => opened.push((e.target as HTMLElement).textContent ?? ''));
    act(() => { tabs()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })); });
    act(() => { grip()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true })); });
    act(() => { tabs()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', bubbles: true })); });
    expect(opened).toEqual(['Checkpoints', '']);
  });

  it('gives a tab and a lone title a tooltip: the name, what a background tab has, and what the handle does', () => {
    vi.useFakeTimers();
    try {
      const tip = (el: Element) => {
        act(() => { el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })); });
        act(() => { vi.advanceTimersByTime(800); });
        const text = document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;
        act(() => { el.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body })); });
        return text;
      };
      render(dock({ tabs: [tab('chat', 'Chat'), tab('console', 'Console', Bug, 'unread')], active: 'chat' }));
      expect(tip(tabs()[1])).toBe('Console · Unread outputDrag to move · double-click to maximize · right-click for options');
      render(dock({ maximized: true }));
      expect(tip(container.querySelector('[data-panel-title] span')!)).toBe('ChatDouble-click to restore · right-click for options');
      render(null);
      expect(tip(container.querySelector('[data-panel-title] span')!)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('trades the grip for a restore button while maximized', () => {
    const ctx = dock({ maximized: true });
    render(ctx);
    expect(grip()).toBeNull();
    const restore = container.querySelector<HTMLButtonElement>('button[aria-label="Restore layout"]')!;
    act(() => restore.click());
    expect(ctx.onToggleMaximize).toHaveBeenCalledWith('chat');
  });
});

describe('PanelHeader actions without room', () => {
  const actions: PanelAction[] = [
    { id: 'upload', icon: Upload, label: 'Upload Files', onSelect: () => {} },
    { id: 'new-file', icon: File, label: 'New File', onSelect: () => {} },
    { id: 'new-folder', icon: Folder, label: 'New Folder', onSelect: () => {} },
    { id: 'import', icon: Import, label: 'Import into this project', items: [{ id: 'file', icon: File, label: 'From a file', onSelect: () => {} }] },
  ];

  /**
   * jsdom does no layout, so the title's room is stubbed: 80 px of title in a box that gains 30 px for
   * every action that has gone into the menu. Two have to go before it fits.
   */
  function stubRoom() {
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) { return this.parentElement; });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.matches('[data-panel-header]')) return 300;
      if (this.matches('[data-panel-title] span')) {
        const header = this.closest('[data-panel-header]')!;
        const gone = Array.from(header.querySelectorAll<HTMLElement>('[data-panel-action]')).filter((slot) => slot.hidden).length;
        return 20 + gone * 30;
      }
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.matches('[data-panel-title] span') ? 80 : 0;
    });
  }

  it('moves them into the ⋯ menu one at a time from the right, until the title fits', () => {
    stubRoom();
    render(null, { actions, title: 'File Explorer' });
    expect(slots().filter((slot) => !slot.hidden).map((slot) => slot.dataset.panelAction)).toEqual(['upload', 'new-file']);
    expect(more().hidden).toBe(false);
  });

  it('keeps every action out of the menu when there is room', () => {
    render(null, { actions, title: 'File Explorer' });
    expect(more().hidden).toBe(true);
    expect(slots().filter((slot) => !slot.hidden)).toHaveLength(4);
  });

  it('hides a disabled action with its slot, tooltip wrapper and all', () => {
    stubRoom();
    render(null, { actions: actions.map((a) => (a.id === 'import' ? a : { ...a, disabled: a.id === 'new-folder' })), title: 'File Explorer' });
    const folder = slots().find((slot) => slot.dataset.panelAction === 'new-folder')!;
    expect(folder.hidden).toBe(true);
    expect(folder.querySelector('button')!.disabled).toBe(true);
  });
});
