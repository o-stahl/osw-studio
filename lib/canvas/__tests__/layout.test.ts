import { describe, it, expect } from 'vitest';
import { artboardAt, BOARD_GAP, centreDistance, fitView, layoutArtboards, PAGE_GAP, visibleArtboards } from '../layout';
import { viewRectOf } from '../types';

const pages = [{ file: '/index.html', title: 'Home' }, { file: '/about.html', title: 'About' }];

describe('layoutArtboards', () => {
  it('puts each page\'s widths side by side and pages left to right, tops aligned', () => {
    const boards = layoutArtboards(pages, ['phone', 'desktop'], () => 2000);
    expect(boards.map((b) => [b.id, b.x, b.y, b.w])).toEqual([
      ['/index.html@phone', 0, 0, 375],
      ['/index.html@desktop', 375 + BOARD_GAP, 0, 1440],
      ['/about.html@phone', 375 + BOARD_GAP + 1440 + PAGE_GAP, 0, 375],
      ['/about.html@desktop', 375 + BOARD_GAP + 1440 + PAGE_GAP + 375 + BOARD_GAP, 0, 1440],
    ]);
  });

  it('keeps known heights, and estimates the rest from another width of the page, else three screens', () => {
    const boards = layoutArtboards(pages, ['phone', 'desktop'], (id) => (id === '/index.html@desktop' ? 3000 : undefined));
    const h = Object.fromEntries(boards.map((b) => [b.id, b.h]));
    expect(h['/index.html@desktop']).toBe(3000);
    // A narrower width wraps more: 3000 × (1440 / 375)^0.6.
    expect(h['/index.html@phone']).toBe(6725);
    expect(h['/about.html@phone']).toBe(667 * 3);
  });

  it('a height learnt later moves no other artboard', () => {
    const before = layoutArtboards(pages, ['phone', 'desktop'], () => undefined);
    const after = layoutArtboards(pages, ['phone', 'desktop'], (id) => (id === '/index.html@phone' ? 9000 : undefined));
    expect(after.map((b) => [b.x, b.y])).toEqual(before.map((b) => [b.x, b.y]));
  });
});

describe('view helpers', () => {
  const boards = layoutArtboards(pages, ['phone', 'desktop'], () => 2000);

  it('find the artboards in a view, with a margin', () => {
    const view = { x: 0, y: 0, w: 400, h: 800 };
    expect(visibleArtboards(boards, view).map((b) => b.id)).toEqual(['/index.html@phone']);
    expect(visibleArtboards(boards, view, 0.25).map((b) => b.id)).toEqual(['/index.html@phone', '/index.html@desktop']);
  });

  it('measure distance from the middle of the view, 0 when it is on the artboard', () => {
    expect(centreDistance(boards[0], { x: 0, y: 0, w: 400, h: 800 })).toBe(0);
    expect(centreDistance(boards[3], { x: 0, y: 0, w: 400, h: 800 })).toBeGreaterThan(2000);
  });

  it('find the artboard under a point, its label included', () => {
    expect(artboardAt(boards, 10, -10)!.id).toBe('/index.html@phone');
    expect(artboardAt(boards, 400, 10)).toBeNull();
  });

  it('fit a page\'s artboards across the width, at no more than 100%', () => {
    const page = boards.filter((b) => b.page === '/about.html');
    const v = fitView(page, 1000)!;
    const left = page[0].x * v.z + v.px;
    const right = (page[1].x + page[1].w) * v.z + v.px;
    expect(left).toBeCloseTo(36);
    expect(right).toBeCloseTo(1000 - 36);
    expect(fitView(page.slice(0, 1), 5000)!.z).toBe(1);
  });
});

describe('viewRectOf', () => {
  it('gives the part of the canvas a surface shows, in canvas pixels', () => {
    // Panned 200 px left and 100 px up at 200%: the surface's corner is canvas point (100, 50).
    expect(viewRectOf({ px: -200, py: -100, z: 2 }, 800, 600)).toEqual({ x: 100, y: 50, w: 400, h: 300 });
    // At 50%, a surface of 300 × 600 holds twice that much canvas.
    expect(viewRectOf({ px: 36, py: 66, z: 0.5 }, 300, 600)).toEqual({ x: -72, y: -132, w: 600, h: 1200 });
  });
});
