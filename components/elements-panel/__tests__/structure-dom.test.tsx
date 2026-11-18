// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withMessages } from '@/lib/i18n/__tests__/test-helpers';
import en from '@/messages/en.json';
import React, { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ElementsPanel, type ElementsPanelHandle, type ElementsPanelProps } from '..';
import type { ApplyOptions } from '@/components/styles-content/commit';
import type { MarkerOverrides } from '@/lib/direct-edit/apply-style';
import type { ApplyResult, StyleChange } from '@/lib/direct-edit/types';
import type { FocusContextPayload, PreviewHostMessage, TreeNode } from '@/lib/preview/types';

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));
import { toast } from 'sonner';

/**
 * The Elements tab's structure features, mounted: the toolbar above the tree, the row menu, the
 * keys a focused tree takes, dragging one row onto another, and the rows the page's script built.
 *
 * What each asserts is what reaches the host (`onElementAction`, `onStructure`, `sendToFrame`),
 * named by the row's own source location: the write path acts on that, so a toolbar that reports
 * the wrong element is wrong however it looks.
 */

const node = (id: string, tag: string, line: number, over: Partial<TreeNode> = {}): TreeNode => ({
  id, tag, file: '/index.html', line, instances: 1, hasChildren: false, ...over,
});

const ROOT: TreeNode[] = [
  node('1', 'header', 10),
  node('2', 'section', 40, { className: 'hero', hasChildren: true, instances: 3 }),
  node('3', 'footer', 90),
  { id: '4', tag: 'div', className: 'built', instances: 1, hasChildren: false, script: true },
];

const payload = (n: TreeNode, over: Partial<FocusContextPayload> = {}): FocusContextPayload => ({
  domPath: `body > ${n.tag}`,
  tagName: n.tag,
  nodeId: n.id,
  srcAttr: `${n.file}:${n.line}`,
  attributes: {},
  outerHTML: `<${n.tag}></${n.tag}>`,
  ...over,
});

let container: HTMLDivElement;
let root: Root;
const ref = createRef<ElementsPanelHandle>();
let sent: PreviewHostMessage[];
let onElementAction: ReturnType<typeof vi.fn>;
let onStructure: ReturnType<typeof vi.fn>;

function mount(selection: FocusContextPayload | null, over: Partial<ElementsPanelProps> = {}) {
  act(() => {
    root.render(withMessages(
      <ElementsPanel
        ref={ref}
        projectId="p1"
        runtime="static"
        previewOpen
        onOpenPreview={vi.fn()}
        sendToFrame={(m) => { sent.push(m); }}
        selection={selection}
        applyStyle={vi.fn()}
        colorTokens={[]}
        onOpenFile={vi.fn()}
        onAskAgent={vi.fn()}
        onRefreshPreview={vi.fn()}
        activeTab="tree"
        onTabChange={vi.fn()}
        onElementAction={onElementAction}
        onStructure={onStructure}
        {...over}
      />,
    ));
  });
}

function seedTree() {
  act(() => { ref.current!.handleTreeLevel({ type: 'tree-level', parentId: null, nodes: ROOT, truncated: 0 }); });
}

const row = (id: string) => container.querySelector<HTMLElement>(`[data-osw-tree-row="${id}"]`)!;
/** The structure toolbar's and the row menu's labels; a toolbar label goes on with its shortcut. */
const labels = en.canvas.menu;
const tool = (label: string) => container.querySelector<HTMLButtonElement>(`[role="toolbar"] button[aria-label^="${label}"]`)!;

/** Click a row, and hand back the payload the frame would answer with. */
function selectRow(n: TreeNode, over: Partial<FocusContextPayload> = {}) {
  act(() => { row(n.id).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  mount(payload(n, over));
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sent = [];
  onElementAction = vi.fn();
  onStructure = vi.fn();
  vi.mocked(toast).mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the Elements tab', () => {
  it('asks the frame for the tree as soon as it opens onto one', () => {
    mount(null);
    expect(sent).toContainEqual({ type: 'tree-request', nodeId: null });
  });

  it('shows a leaf\'s words and the script rows the page built', () => {
    mount(null);
    act(() => {
      ref.current!.handleTreeLevel({ type: 'tree-level', parentId: null, nodes: [node('1', 'p', 0, { text: 'Hello there' }), ROOT[3]], truncated: 0 });
    });
    expect(row('1').textContent).toContain('Hello there');
    expect(row('4').textContent).toContain(en.elementsPanel.script);
  });

  it('does not select a script row, and says why', () => {
    mount(null);
    seedTree();
    act(() => { row('4').dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(sent).not.toContainEqual({ type: 'tree-select', nodeId: '4' });
    expect(toast).toHaveBeenCalledWith(en.elementsPanel.scriptClick);
  });

  it('reads another artboard\'s document once told of it, though its selection has the selected row\'s id', () => {
    mount(null);
    seedTree();
    selectRow(ROOT[2], { page: '/index.html', viewportWidth: 1440 });
    sent.length = 0;
    // The phone artboard numbered its own h1 3.
    act(() => { ref.current!.handleStructureChanged(); });
    mount(payload(node('3', 'h1', 20), { page: '/index.html', viewportWidth: 375 }));
    expect(sent).toContainEqual({ type: 'tree-request', nodeId: null });
    expect(sent).toContainEqual({ type: 'tree-path', nodeId: '3' });
    expect(container.querySelector('[data-osw-tree-row]')).toBeNull();
  });

  it('asks again where an element picked on the page sits once the document under the tree changes', () => {
    mount(null);
    seedTree();
    // Picked on the desktop artboard: the panel asks the frame where it sits.
    mount(payload(ROOT[2], { page: '/index.html', viewportWidth: 1440 }));
    expect(sent).toContainEqual({ type: 'tree-path', nodeId: '3' });
    sent.length = 0;
    // The phone artboard numbered its own h1 3.
    act(() => { ref.current!.handleStructureChanged(); });
    mount(payload(node('3', 'h1', 20), { page: '/index.html', viewportWidth: 375 }));
    expect(sent).toContainEqual({ type: 'tree-request', nodeId: null });
    expect(sent).toContainEqual({ type: 'tree-path', nodeId: '3' });
  });
});

describe('the structure toolbar', () => {
  it('offers moves only where there is a neighbour, Unwrap only on a frame', () => {
    mount(null);
    seedTree();
    selectRow(ROOT[0]);
    expect(tool(labels.moveUp).disabled).toBe(true);
    expect(tool(labels.moveDown).disabled).toBe(false);
    expect(tool(labels.unwrap).disabled).toBe(true);
    selectRow(ROOT[2], { frame: true });
    expect(tool(labels.moveDown).disabled).toBe(true);
    expect(tool(labels.unwrap).disabled).toBe(false);
  });

  it('offers no structural edit on a locked element', () => {
    mount(null);
    seedTree();
    selectRow(ROOT[1], { locked: true });
    for (const label of [labels.moveUp, labels.moveDown, labels.wrap, labels.duplicate, labels.delete]) expect(tool(label).disabled, label).toBe(true);
  });

  it('sends the action with the selected row\'s source location and the count of elements it renders', () => {
    mount(null);
    seedTree();
    selectRow(ROOT[1]);
    act(() => { tool(labels.moveDown).click(); });
    expect(onElementAction).toHaveBeenCalledWith('move-down', { srcAttr: '/index.html:40', tagName: 'section', instanceCount: 3 });
  });
});

describe('the row menu', () => {
  it('opens on a right-click and acts on that row', () => {
    mount(null);
    seedTree();
    act(() => { row('3').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
    const menu = document.querySelector('[data-osw-element-menu]');
    expect(menu?.textContent).toContain('footer');
    const del = Array.from(document.querySelectorAll<HTMLElement>('[data-osw-element-menu] [role="menuitem"]')).find(el => el.textContent?.startsWith(labels.delete))!;
    act(() => { del.click(); });
    expect(onElementAction).toHaveBeenCalledWith('delete', { srcAttr: '/index.html:90', tagName: 'footer', instanceCount: 1 });
  });

  /** Right-click a row, and the menu item whose label starts with `label`. */
  function openMenu(id: string, label: string): HTMLElement {
    act(() => { row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
    const item = Array.from(document.querySelectorAll<HTMLElement>('[data-osw-element-menu] [role="menuitem"]')).find(el => el.textContent?.startsWith(label));
    expect(item, `no ${label} in the row menu`).toBeTruthy();
    return item!;
  }
  const choose = (item: HTMLElement) => act(() => { item.click(); });

  it('runs only the item on Enter, not the tree\'s own Enter as well', () => {
    mount(null);
    seedTree();
    act(() => { ref.current!.handleTreeLevel({ type: 'tree-level', parentId: '2', nodes: [node('5', 'h1', 50)], truncated: 0 }); });
    const duplicate = openMenu('2', labels.duplicate);
    sent.length = 0;
    act(() => {
      duplicate.focus();
      duplicate.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    expect(onElementAction.mock.calls.map(c => c[0])).toEqual(['duplicate']);
    expect(sent).not.toContainEqual({ type: 'tree-select', nodeId: '5' });
  });

  it('does not delete the row on a Backspace pressed in the menu', () => {
    mount(null);
    seedTree();
    const item = openMenu('2', labels.duplicate);
    act(() => {
      item.focus();
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    });
    expect(onElementAction).not.toHaveBeenCalled();
  });

  /** A write path that answers at once, and the time for the Styles tab's commit to fire. */
  const writes = () => vi.fn(async (_s: FocusContextPayload, _c: readonly StyleChange[], opts: ApplyOptions): Promise<ApplyResult> =>
    ({ ok: true, markerId: opts.markerId ?? 'm1', filesWritten: ['/overrides.css'], css: '' }));
  const committed = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
  const computed = (nodeId: string, display: string) => act(() => {
    ref.current!.handleStyleComputed({ type: 'style-computed', nodeId, values: { display }, rootFontSize: '16px' });
  });

  it('hides the row it was opened on, not the element the Styles tab still has', async () => {
    const applyStyle = writes();
    mount(payload(ROOT[0]), { applyStyle });
    seedTree();
    computed('1', 'block');

    choose(openMenu('3', labels.hideAll));
    await committed();
    expect(applyStyle).not.toHaveBeenCalled();

    // The frame answers the row's selection, then says what the element is.
    mount(payload(ROOT[2]), { applyStyle });
    computed('3', 'block');
    await committed();
    expect(applyStyle).toHaveBeenCalledTimes(1);
    const [selection, changes] = applyStyle.mock.calls[0];
    expect(selection.nodeId).toBe('3');
    expect(changes).toEqual([{ property: 'display', value: 'none' }]);
  });

  it('shows a hidden row it was opened on once the Styles tab knows the element is hidden', async () => {
    const applyStyle = writes();
    mount(payload(ROOT[0]), { applyStyle });
    act(() => {
      ref.current!.handleTreeLevel({ type: 'tree-level', parentId: null, nodes: [ROOT[0], ROOT[1], { ...ROOT[2], hidden: true }], truncated: 0 });
    });
    computed('1', 'block');

    choose(openMenu('3', labels.show));
    mount(payload(ROOT[2]), { applyStyle });
    await committed();
    expect(applyStyle).not.toHaveBeenCalled();
    computed('3', 'none');
    await committed();
    const [selection, changes] = applyStyle.mock.calls[0];
    expect(selection.nodeId).toBe('3');
    expect(changes).toEqual([{ property: 'display', value: 'revert-layer' }]);
  });

  it('drops a Hide when another element is selected before the row', async () => {
    const applyStyle = writes();
    mount(payload(ROOT[0]), { applyStyle });
    seedTree();
    computed('1', 'block');

    choose(openMenu('3', labels.hideAll));
    mount(payload(ROOT[1]), { applyStyle });
    computed('2', 'block');
    mount(payload(ROOT[2]), { applyStyle });
    computed('3', 'block');
    await committed();
    expect(applyStyle).not.toHaveBeenCalled();
  });

  /** The footer on the desktop artboard; the phone artboard's document gives its own footer the same id. */
  const DESKTOP = { page: '/index.html', viewportWidth: 1440 };
  const PHONE = { page: '/index.html', viewportWidth: 375 };

  it('hides the Canvas element it is told about once the Styles tab holds it, not the one with its id on another artboard', async () => {
    const applyStyle = writes();
    mount(payload(ROOT[2], PHONE), { applyStyle });
    seedTree();
    computed('3', 'block');

    act(() => { ref.current!.styleCommand('toggle-hide', '3', DESKTOP); });
    await committed();
    expect(applyStyle).not.toHaveBeenCalled();

    mount(payload(ROOT[2], DESKTOP), { applyStyle });
    computed('3', 'block');
    await committed();
    expect(applyStyle).toHaveBeenCalledTimes(1);
    const [selection, changes] = applyStyle.mock.calls[0];
    expect(selection.viewportWidth).toBe(1440);
    expect(changes).toEqual([{ property: 'display', value: 'none' }]);
  });

  it('drops a Canvas Hide when another element is selected before the one it is for', async () => {
    const applyStyle = writes();
    mount(payload(ROOT[2], PHONE), { applyStyle });
    seedTree();
    computed('3', 'block');

    act(() => { ref.current!.styleCommand('toggle-hide', '3', DESKTOP); });
    mount(payload(ROOT[1], DESKTOP), { applyStyle });
    computed('2', 'block');
    mount(payload(ROOT[2], DESKTOP), { applyStyle });
    computed('3', 'block');
    await committed();
    expect(applyStyle).not.toHaveBeenCalled();
  });

  it('clears the row\'s overrides once the file has been read for it', async () => {
    const applyStyle = writes();
    let answer: (overrides: MarkerOverrides) => void = () => {};
    const onReadOverrides = vi.fn(() => new Promise<MarkerOverrides>(resolve => { answer = resolve; }));
    const footer = payload(ROOT[2], { attributes: { 'data-osw-id': 'm3' } });
    mount(footer, { applyStyle, onReadOverrides });
    seedTree();
    computed('3', 'block');

    choose(openMenu('3', labels.clearAll));
    await act(async () => { answer({ byScope: new Map([['all', { color: 'red' }]]), text: 'x', widths: [] }); });
    await committed();
    expect(applyStyle).toHaveBeenCalledTimes(1);
    expect(applyStyle.mock.calls[0][1]).toEqual([{ property: 'color', value: null }]);
  });
});

describe('the keys a focused tree takes', () => {
  const press = (key: string, init: KeyboardEventInit = {}) => act(() => {
    container.querySelector('[data-osw-tree]')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  });

  it('deletes, moves and duplicates the selected row', () => {
    mount(null);
    seedTree();
    selectRow(ROOT[1]);
    press('Delete');
    press('ArrowDown', { altKey: true });
    press('d', { code: 'KeyD', metaKey: true });
    expect(onElementAction.mock.calls.map(c => c[0])).toEqual(['delete', 'move-down', 'duplicate']);
  });

  it('selects the parent on Escape', () => {
    mount(null);
    seedTree();
    act(() => {
      ref.current!.handleTreeLevel({ type: 'tree-level', parentId: '2', nodes: [node('5', 'h1', 50)], truncated: 0 });
    });
    act(() => { row('2').querySelector('button')!.click(); });
    selectRow(node('5', 'h1', 50));
    sent.length = 0;
    press('Escape');
    expect(sent).toContainEqual({ type: 'tree-select', nodeId: '2' });
  });
});

describe('dragging a row', () => {
  it('moves the dragged row\'s element before, after or into the row it is dropped on', () => {
    mount(null);
    seedTree();
    const target = row('2');
    target.getBoundingClientRect = () => ({ top: 100, height: 20, left: 0, width: 200, right: 200, bottom: 120, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
    document.elementFromPoint = () => target;
    act(() => { row('3').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 300 })); });
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 280 })); });
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 110 })); });
    act(() => { window.dispatchEvent(new PointerEvent('pointerup', {})); });
    // The middle of a section is into it; it goes last.
    expect(onStructure).toHaveBeenCalledWith(
      { kind: 'move', place: { parent: '/index.html:40', at: 'end' } },
      { srcAttr: '/index.html:90', tagName: 'footer', instanceCount: 1 },
    );
  });

  it('abandons a drag the browser cancels, so a later release moves nothing', () => {
    mount(null);
    seedTree();
    const target = row('2');
    target.getBoundingClientRect = () => ({ top: 100, height: 20, left: 0, width: 200, right: 200, bottom: 120, x: 0, y: 100, toJSON: () => ({}) }) as DOMRect;
    document.elementFromPoint = () => target;
    act(() => { row('3').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 300 })); });
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 280 })); });
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 110 })); });
    expect(row('2').style.boxShadow).not.toBe('');
    // A touch press that turns into a scroll.
    act(() => { window.dispatchEvent(new PointerEvent('pointercancel', {})); });
    expect(row('2').style.boxShadow).toBe('');
    // The pointer goes on over the section before the release: nothing is being dragged any more.
    act(() => { window.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 110 })); });
    expect(row('2').style.boxShadow).toBe('');
    act(() => { window.dispatchEvent(new PointerEvent('pointerup', {})); });
    expect(onStructure).not.toHaveBeenCalled();
  });
});

describe('selecting the first child', () => {
  const press = (key: string) => act(() => {
    container.querySelector('[data-osw-tree]')!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  const level = (parentId: string | null, nodes: TreeNode[]) => act(() => {
    ref.current!.handleTreeLevel({ type: 'tree-level', parentId, nodes, truncated: 0 });
  });
  const H1 = node('5', 'h1', 50);
  /**
   * A recompile: the frame loads a new document whose ids start over, and the panel reads its body.
   * Both arrive in one batch, so the section is back with children before the panel renders again.
   */
  const recompile = () => act(() => {
    ref.current!.handleFrameReady();
    ref.current!.handleTreeLevel({ type: 'tree-level', parentId: null, nodes: ROOT, truncated: 0 });
  });
  /** Open the section by its chevron, and have the frame answer with its level. */
  const expandSection = () => {
    act(() => { row('2').querySelector('button')!.click(); });
    level('2', [H1]);
  };

  it('selects the first child on Enter once its level is in', () => {
    mount(null);
    seedTree();
    selectRow(ROOT[1]);
    press('Enter');
    expect(sent).toContainEqual({ type: 'tree-request', nodeId: '2' });
    level('2', [H1]);
    expect(sent).toContainEqual({ type: 'tree-select', nodeId: '5' });
  });

  it('does nothing on Enter on a row without children, even when a later document gives that id some', () => {
    mount(null);
    seedTree();
    selectRow(ROOT[0]);
    sent.length = 0;
    press('Enter');
    const askedOnEnter = [...sent];
    act(() => { ref.current!.handleFrameReady(); });
    level(null, [node('1', 'main', 10, { hasChildren: true })]);
    act(() => { row('1').querySelector('button')!.click(); });
    level('1', [H1]);
    expect(sent).not.toContainEqual({ type: 'tree-select', nodeId: '5' });
    expect(askedOnEnter).toEqual([]);
  });

  it('stops waiting when the awaited level comes back empty', () => {
    mount(null);
    seedTree();
    selectRow(ROOT[1]);
    press('Enter');
    level('2', []);
    // A body level answering an earlier request, where the section has children again.
    level(null, ROOT);
    sent.length = 0;
    expandSection();
    expect(sent).not.toContainEqual({ type: 'tree-select', nodeId: '5' });
  });

  it('stops waiting when another row is selected before the level is in', () => {
    mount(null);
    seedTree();
    selectRow(ROOT[1]);
    press('Enter');
    selectRow(ROOT[2]);
    sent.length = 0;
    level('2', [H1]);
    expect(sent).not.toContainEqual({ type: 'tree-select', nodeId: '5' });
    // The footer is still the row the toolbar acts on.
    act(() => { tool(labels.delete).click(); });
    expect(onElementAction).toHaveBeenCalledWith('delete', { srcAttr: '/index.html:90', tagName: 'footer', instanceCount: 1 });
  });

  it('stops waiting when an element is picked in the preview before the level is in', () => {
    mount(null);
    seedTree();
    selectRow(ROOT[1]);
    press('Enter');
    // Picked on the page: the panel asks the frame where it sits, and the section's level lands first.
    mount(payload(ROOT[2]));
    expect(sent).toContainEqual({ type: 'tree-path', nodeId: '3' });
    sent.length = 0;
    level('2', [H1]);
    expect(sent).not.toContainEqual({ type: 'tree-select', nodeId: '5' });
  });

  it('stops waiting when the document is replaced before the level is in', () => {
    mount(null);
    seedTree();
    selectRow(ROOT[1]);
    press('Enter');
    recompile();
    sent.length = 0;
    expandSection();
    expect(sent).not.toContainEqual({ type: 'tree-select', nodeId: '5' });
  });
});
