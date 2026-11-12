// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { keepWorkspaceFocus, WORKSPACE_FOCUS_ATTR } from '../use-layout-commands';

/**
 * After a layout change, focus goes back to the workspace when the change took it away, so Ctrl+Z
 * still reaches the layout; and it stays where it is when it is still somewhere useful.
 */

let workspace: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  workspace = document.createElement('div');
  workspace.tabIndex = -1;
  workspace.setAttribute(WORKSPACE_FOCUS_ATTR, '');
  document.body.append(workspace);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('keepWorkspaceFocus', () => {
  it('gives focus back to the workspace when nothing has it', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    keepWorkspaceFocus();
    vi.runAllTimers();
    expect(document.activeElement).toBe(workspace);
  });

  it('leaves focus on a control that still has it', () => {
    const tab = document.createElement('button');
    workspace.append(tab);
    tab.focus();
    keepWorkspaceFocus();
    vi.runAllTimers();
    expect(document.activeElement).toBe(tab);
  });
});
