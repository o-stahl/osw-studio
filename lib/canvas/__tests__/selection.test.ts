import { describe, it, expect } from 'vitest';
import { OwnSelections, clickTarget, deeperTarget, doubleClickTarget, clickableChain, isDoubleClick, type ChainItem } from '../selection';

// body > main (page tall) > section > div.card > h2
const chain: ChainItem[] = [
  { nodeId: 'main', parentId: null, height: 3000 },
  { nodeId: 'section', parentId: 'main', height: 600 },
  { nodeId: 'card', parentId: 'section', height: 200 },
  { nodeId: 'h2', parentId: 'card', height: 40 },
];
const PAGE = 3100;

describe('the click chain', () => {
  it('leaves out wrappers nearly as tall as the page, but never the element clicked', () => {
    expect(clickableChain(chain, PAGE).map((c) => c.nodeId)).toEqual(['section', 'card', 'h2']);
    expect(clickableChain([{ nodeId: 'main', parentId: null, height: 3000 }], PAGE).map((c) => c.nodeId)).toEqual(['main']);
  });

  it('leaves out <main> whatever its height: a header and footer can take more than a tenth of the page', () => {
    const shortMain: ChainItem[] = [{ nodeId: 'm', parentId: null, height: 2000, tag: 'main' }, { nodeId: 's', parentId: 'm', height: 600, tag: 'section' }];
    expect(clickableChain(shortMain, PAGE).map((c) => c.nodeId)).toEqual(['s']);
    expect(clickableChain(shortMain.slice(0, 1), PAGE).map((c) => c.nodeId)).toEqual(['m']);
  });
});

describe('clickTarget', () => {
  it('selects the outermost element below the page-tall wrappers', () => {
    expect(clickTarget(chain, PAGE, null, false)!.nodeId).toBe('section');
  });

  it('selects the deepest with ⌘ held', () => {
    expect(clickTarget(chain, PAGE, null, true)!.nodeId).toBe('h2');
  });

  it('keeps the selection when the click is inside it', () => {
    expect(clickTarget(chain, PAGE, { nodeId: 'card', parentId: 'section' }, false)!.nodeId).toBe('card');
  });

  it('moves to a sibling at the same level', () => {
    const other: ChainItem[] = [chain[0], chain[1], { nodeId: 'card2', parentId: 'section', height: 200 }, { nodeId: 'p', parentId: 'card2', height: 20 }];
    expect(clickTarget(other, PAGE, { nodeId: 'card', parentId: 'section' }, false)!.nodeId).toBe('card2');
  });

  it('is null over nothing that came from a source file', () => {
    expect(clickTarget([], PAGE, null, false)).toBeNull();
  });
});

describe('deeperTarget', () => {
  it('goes one level deeper along the chain under the pointer', () => {
    expect(deeperTarget(chain, PAGE, 'section')!.nodeId).toBe('card');
    expect(deeperTarget(chain, PAGE, 'card')!.nodeId).toBe('h2');
  });

  it('is null at the innermost element, or for a selection off the chain', () => {
    expect(deeperTarget(chain, PAGE, 'h2')).toBeNull();
    expect(deeperTarget(chain, PAGE, 'elsewhere')).toBeNull();
    expect(deeperTarget(chain, PAGE, null)).toBeNull();
  });
});

describe('doubleClickTarget', () => {
  const leafy: ChainItem[] = [...chain.slice(0, 3), { ...chain[3], leafText: true }];

  it('goes one level below what its first click selects, whether or not that selection has landed', () => {
    // Nothing selected: the first click takes the section, the double-click its card.
    expect(doubleClickTarget(chain, PAGE, null, false)).toEqual({ select: chain[2], editText: false });
    // The same with the first click's selection already in place.
    expect(doubleClickTarget(chain, PAGE, { nodeId: 'section', parentId: 'main' }, false)).toEqual({ select: chain[2], editText: false });
    expect(doubleClickTarget(chain, PAGE, { nodeId: 'card', parentId: 'section' }, false).select!.nodeId).toBe('h2');
  });

  it('starts from the element the first click moves to, when the selection is elsewhere', () => {
    const other: ChainItem[] = [chain[0], chain[1], { nodeId: 'card2', parentId: 'section', height: 200 }, { nodeId: 'p', parentId: 'card2', height: 20 }];
    // A sibling of the selected card: its first click takes card2, the double-click its paragraph.
    expect(doubleClickTarget(other, PAGE, { nodeId: 'card', parentId: 'section' }, false).select!.nodeId).toBe('p');
    // Selected somewhere unrelated: the first click takes the section.
    expect(doubleClickTarget(other, PAGE, { nodeId: 'nav', parentId: null }, false).select!.nodeId).toBe('card2');
  });

  it('types in place at the innermost element when it has words of its own', () => {
    expect(doubleClickTarget(leafy, PAGE, { nodeId: 'h2', parentId: 'card' }, false)).toEqual({ select: leafy[3], editText: true });
    // ⌘ takes the innermost at once.
    expect(doubleClickTarget(leafy, PAGE, null, true)).toEqual({ select: leafy[3], editText: true });
    // Without words, it stays selected.
    expect(doubleClickTarget(chain, PAGE, { nodeId: 'h2', parentId: 'card' }, false)).toEqual({ select: chain[3], editText: false });
  });

  it('is nothing over nothing from a source file', () => {
    expect(doubleClickTarget([], PAGE, null, false)).toEqual({ select: null, editText: false });
  });
});

describe('OwnSelections', () => {
  it('passes the latest of its own, skips older ones and leaves other selections alone', () => {
    const own = new OwnSelections();
    own.add('b1', 'section');
    own.add('b1', 'section');
    own.add('b1', 'card');
    // The double-click's two clicks confirm late: putting the section back would undo the card.
    expect(own.settle('b1', 'section')).toBe('stale');
    expect(own.settle('b1', 'section')).toBe('stale');
    expect(own.settle('b1', 'card')).toBe('own');
    // A row picked in the Elements tree.
    expect(own.settle('b1', 'h2')).toBe('foreign');
    // The same node on another artboard is another selection.
    own.add('b2', 'card');
    expect(own.settle('b1', 'card')).toBe('foreign');
    expect(own.settle('b2', 'card')).toBe('own');
  });

  it('keeps no more than the last sixteen', () => {
    const own = new OwnSelections();
    for (let i = 0; i < 20; i++) own.add('b', `n${i}`);
    // n4 to n19 are kept: the four before them are gone.
    expect(own.settle('b', 'n3')).toBe('foreign');
    expect(own.settle('b', 'n4')).toBe('stale');
    expect(own.settle('b', 'n19')).toBe('own');
  });
});

describe('isDoubleClick', () => {
  it('is every second click of a run, not only the browser\'s one double-click at the 2nd', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(isDoubleClick)).toEqual([false, true, false, true, false, true, false, true]);
    expect(isDoubleClick(0)).toBe(false);
  });
});
