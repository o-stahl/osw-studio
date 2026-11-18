import { describe, it, expect } from 'vitest';
import { DRAWN_SHARE, MIN_ELEMENTS, isDrawn, mostlyDrawn, readTraced } from '../tracing';

/**
 * Which pages give the Canvas little to work on. The numbers come from a frame that runs the
 * project's code, so they are checked before they are believed.
 */

describe('isDrawn', () => {
  it('is false for a page written as HTML, whatever its scripts add at the edges', () => {
    expect(isDrawn({ source: 140, script: 0, drawn: 0 })).toBe(false);
    expect(isDrawn({ source: 140, script: 60, drawn: 0 })).toBe(false);
  });

  it('is true once most of what shows was built by script', () => {
    expect(isDrawn({ source: 8, script: 12, drawn: 0 })).toBe(true);
    expect(isDrawn({ source: 9, script: 11, drawn: 0 })).toBe(false);
  });

  it('says nothing of a page with too few elements to judge by their share', () => {
    expect(isDrawn({ source: 1, script: MIN_ELEMENTS - 2, drawn: 0 })).toBe(false);
    expect(isDrawn({ source: 1, script: MIN_ELEMENTS - 1, drawn: 0 })).toBe(true);
  });

  it('is true for a page that is one drawing surface, however few elements it has', () => {
    expect(isDrawn({ source: 3, script: 0, drawn: DRAWN_SHARE })).toBe(true);
    expect(isDrawn({ source: 3, script: 0, drawn: DRAWN_SHARE - 0.01 })).toBe(false);
  });
});

describe('mostlyDrawn', () => {
  const site = { source: 100, script: 0, drawn: 0 };
  const game = { source: 4, script: 0, drawn: 0.9 };

  it('takes more than half of the measured pages', () => {
    expect(mostlyDrawn([game])).toBe(true);
    expect(mostlyDrawn([game, site])).toBe(false);
    expect(mostlyDrawn([game, game, site])).toBe(true);
    expect(mostlyDrawn([site, site, site])).toBe(false);
  });

  it('is false before anything was measured', () => {
    expect(mostlyDrawn([])).toBe(false);
  });
});

describe('readTraced', () => {
  it('takes three numbers and nothing else', () => {
    expect(readTraced({ source: 3, script: 1, drawn: 0.25, extra: 'x' })).toEqual({ source: 3, script: 1, drawn: 0.25 });
    expect(readTraced({ source: 3, script: 1, drawn: 7 })).toEqual({ source: 3, script: 1, drawn: 1 });
    for (const bad of [null, 'x', {}, { source: '3', script: 1, drawn: 0 }, { source: -1, script: 1, drawn: 0 }, { source: 1, script: NaN, drawn: 0 }]) {
      expect(readTraced(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
