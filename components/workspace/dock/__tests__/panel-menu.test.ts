// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { WorkspaceLayout } from '@/lib/workspace-layout';
import { splitRightTarget } from '../panel-menu';

/** Split right, from the panel menu or Ctrl/Cmd+\: a new column just after the panel's own. */

const layout: WorkspaceLayout = { v: 1, columns: [
  { id: 'col1', size: 50, cells: [{ id: 'cell2', size: 100, tabs: ['chat', 'console'], active: 'chat' }] },
  { id: 'col3', size: 50, cells: [{ id: 'cell4', size: 100, tabs: ['preview'], active: 'preview' }] },
] };

describe('splitRightTarget', () => {
  it('is a new column just after the panel\'s own, for a background tab too', () => {
    expect(splitRightTarget(layout, 'console')).toEqual({ kind: 'column', before: 'col3' });
  });

  it('is a new last column for a panel in the last column', () => {
    expect(splitRightTarget(layout, 'preview')).toEqual({ kind: 'column', before: null });
  });

  it('is nothing for a panel that is not open', () => {
    expect(splitRightTarget(layout, 'files')).toBeNull();
  });
});
