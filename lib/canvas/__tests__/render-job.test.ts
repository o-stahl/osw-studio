import { describe, it, expect } from 'vitest';
import { deviceHeightFor, tileHeightFor, tilesOf, MAX_TILES } from '../render-job';

/**
 * How a rendered page is cut into images: tiles a model reads at full size (about 1.15 megapixels,
 * at most 1568 px on a side), at most `MAX_TILES` of them. The painting itself needs a browser.
 */
describe('tiles', () => {
  it('sizes a tile to what a model reads without scaling it down', () => {
    expect(tileHeightFor(375)).toBe(1568);
    expect(tileHeightFor(1440)).toBe(798);
    expect(tileHeightFor(1440) * 1440).toBeLessThanOrEqual(1_150_000);
  });

  it('covers a region top to bottom, the last tile short', () => {
    expect(tilesOf(0, 2000, 375)).toEqual({ tiles: [{ y: 0, h: 1568 }, { y: 1568, h: 432 }], cut: false });
    expect(tilesOf(100, 300, 1440)).toEqual({ tiles: [{ y: 100, h: 300 }], cut: false });
  });

  it('sends a short remainder with the slice before it, not as a strip of its own', () => {
    // The first screen at desktop width is 900 px tall and a tile 798: one image, not 798 and 102.
    expect(tilesOf(0, 900, 1440)).toEqual({ tiles: [{ y: 0, h: 900 }], cut: false });
    expect(tilesOf(0, 1700, 1440).tiles).toEqual([{ y: 0, h: 798 }, { y: 798, h: 902 }]);
    // A remainder worth an image of its own stays one.
    expect(tilesOf(0, 1200, 1440).tiles).toEqual([{ y: 0, h: 798 }, { y: 798, h: 402 }]);
    for (const h of [900, 1700, 3298, 4000]) {
      const { tiles } = tilesOf(0, h, 1440);
      expect(tiles.reduce((sum, t) => sum + t.h, 0), String(h)).toBe(h);
      expect(Math.min(...tiles.map(t => t.h)), String(h)).toBeGreaterThanOrEqual(798 * 0.15);
    }
  });

  it('stops at the most it sends, and says it cut', () => {
    const { tiles, cut } = tilesOf(0, 20000, 1440);
    expect(tiles).toHaveLength(MAX_TILES);
    expect(cut).toBe(true);
  });
});

describe('deviceHeightFor', () => {
  it('takes the height of the Canvas device nearest the width', () => {
    expect([320, 375, 768, 1024, 1440, 1920].map(deviceHeightFor)).toEqual([667, 667, 1024, 1024, 900, 900]);
  });
});
