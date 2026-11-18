import { describe, it, expect } from 'vitest';
import {
  CSS_SHORTHANDS,
  QUERY_PROPERTIES,
  STYLE_PROPERTIES,
  WRITABLE_PROPERTIES,
  partEntry,
  propertyEntry,
  readNamesFor,
  stepLadder,
  valueNames,
  type StepperEntry,
} from '../properties';

/**
 * The property table's invariants.
 *
 * The longhand rule is asserted because the *controls* need per-side numbers and the probe's loss
 * report has to name a side — not because `getComputedStyle` cannot resolve a shorthand, which it
 * can. A test written to that second, false rationale would assert nothing.
 */

describe('the property table', () => {
  it('gives every entry at least one computed name to read', () => {
    for (const entry of STYLE_PROPERTIES) {
      expect(entry.read.length, `${entry.id} reads nothing`).toBeGreaterThan(0);
    }
  });

  it('reads longhands only — no entry asks the frame for a shorthand', () => {
    for (const entry of STYLE_PROPERTIES) {
      for (const name of entry.read) {
        expect(
          Object.prototype.hasOwnProperty.call(CSS_SHORTHANDS, name),
          `${entry.id} reads ${name}, which is a shorthand: a control cannot step one side of it`,
        ).toBe(false);
      }
    }
  });

  it('never writes a shorthand whose longhands it does not list', () => {
    for (const entry of STYLE_PROPERTIES) {
      const longhands = CSS_SHORTHANDS[entry.property];
      if (!longhands) continue;
      for (const longhand of longhands) {
        expect(entry.read, `${entry.id} writes ${entry.property} but never reads ${longhand}`)
          .toContain(longhand);
      }
    }
  });

  it('covers the shorthands it actually writes, so the rule above is not vacuous', () => {
    const written = STYLE_PROPERTIES.filter(e => CSS_SHORTHANDS[e.property]).map(e => e.property);
    expect(written).toContain('padding-block');
    expect(written).toContain('border-radius');
  });

  it('gives every entry a unique id and property', () => {
    expect(new Set(STYLE_PROPERTIES.map(e => e.id)).size).toBe(STYLE_PROPERTIES.length);
    expect(new Set(STYLE_PROPERTIES.map(e => e.property)).size).toBe(STYLE_PROPERTIES.length);
  });

  it('offers ladders that ascend and repeat nothing', () => {
    for (const entry of STYLE_PROPERTIES) {
      if (entry.control !== 'stepper') continue;
      expect(entry.ladder.length, `${entry.id} has an unusable ladder`).toBeGreaterThan(1);
      for (let i = 1; i < entry.ladder.length; i++) {
        expect(entry.ladder[i], `${entry.id} ladder is not ascending at ${i}`)
          .toBeGreaterThan(entry.ladder[i - 1]);
      }
    }
  });

  it('steps font-size over a ladder rather than offering four named sizes', () => {
    // S/M/L/XL could only write the four rungs it printed: an element the project set to 2.5rem
    // lit up no option, and the control's only offer was to shrink it to the largest name it knew.
    const entry = propertyEntry('font-size')!;
    expect(entry.control).toBe('stepper');
    if (entry.control !== 'stepper') return;
    expect(entry.kind).toBe('length');
    expect(entry.unit).toBe('rem');
    expect(entry.ladder.length).toBeGreaterThan(4);
    // Spans a heading as well as body text — an "XL" of 1.5rem was below every template's h1.
    expect(entry.ladder[entry.ladder.length - 1]).toBeGreaterThanOrEqual(2);
  });

  it('gives every segmented control keywords, since it can only write what it prints', () => {
    for (const entry of STYLE_PROPERTIES) {
      if (entry.control !== 'segmented') continue;
      expect(entry.kind, `${entry.id} is a segmented control over a non-keyword value`).toBe('keyword');
    }
  });

  it('offers segmented options that repeat no value', () => {
    for (const entry of STYLE_PROPERTIES) {
      if (entry.control !== 'segmented') continue;
      const values = entry.options.map(o => o.value);
      expect(new Set(values).size, `${entry.id} repeats an option value`).toBe(values.length);
    }
  });

  it('fetches every divisor it declares, and leaves it out of the value names', () => {
    for (const entry of STYLE_PROPERTIES) {
      if (entry.control !== 'stepper' || !entry.divisor) continue;
      expect(entry.read, `${entry.id} divides by ${entry.divisor} without reading it`)
        .toContain(entry.divisor);
      expect(valueNames(entry)).not.toContain(entry.divisor);
      expect(valueNames(entry).length).toBeGreaterThan(0);
    }
  });

  it('leaves the read names alone where there is no divisor', () => {
    const padding = propertyEntry('padding-block')!;
    expect(valueNames(padding)).toEqual(padding.read);
  });

  it('writes no length without a unit, and no ratio with one', () => {
    for (const entry of STYLE_PROPERTIES) {
      if (entry.control === 'swatch') continue;
      if (entry.kind === 'length') expect(entry.unit, entry.id).not.toBe('');
      if (entry.kind === 'ratio') expect(entry.unit, entry.id).toBe('');
    }
  });
});

describe('QUERY_PROPERTIES', () => {
  it('is the union of every entry\'s read list', () => {
    for (const entry of STYLE_PROPERTIES) {
      for (const name of entry.read) expect(QUERY_PROPERTIES).toContain(name);
    }
  });

  it('deduplicates — font-size is read by two entries and asked for once', () => {
    expect(new Set(QUERY_PROPERTIES).size).toBe(QUERY_PROPERTIES.length);
    expect(STYLE_PROPERTIES.filter(e => e.read.includes('font-size')).length).toBeGreaterThan(1);
  });
});

describe('readNamesFor', () => {
  it('maps a written property to the names its replies come back under', () => {
    expect(readNamesFor('padding-block')).toEqual(['padding-block-start', 'padding-block-end']);
  });

  it('falls back to the property itself rather than returning nothing', () => {
    expect(readNamesFor('letter-spacing')).toEqual(['letter-spacing']);
  });
});

describe('propertyEntry', () => {
  it('finds by the property written, not the id', () => {
    expect(propertyEntry('padding-block')?.id).toBe('padding-block');
    expect(propertyEntry('nonesuch')).toBeUndefined();
  });
});

describe('stepLadder', () => {
  const ladder = [0, 0.25, 0.5, 0.75, 1, 1.5, 2] as const;

  it('moves one step in the asked direction from a value on the ladder', () => {
    expect(stepLadder(ladder, 0.5, 1)).toBe(0.75);
    expect(stepLadder(ladder, 0.5, -1)).toBe(0.25);
  });

  it('stays at the top rather than going undefined', () => {
    expect(stepLadder(ladder, 2, 1)).toBe(2);
  });

  it('stays at 0 rather than producing a negative', () => {
    expect(stepLadder(ladder, 0, -1)).toBe(0);
  });

  it('steps to the nearer step when the value sits between two', () => {
    expect(stepLadder(ladder, 0.9, 1)).toBe(1);
    expect(stepLadder(ladder, 0.9, -1)).toBe(0.75);
    expect(stepLadder(ladder, 0.3, 1)).toBe(0.5);
    expect(stepLadder(ladder, 0.3, -1)).toBe(0.25);
  });

  it('clamps a value past either end back onto the ladder', () => {
    expect(stepLadder(ladder, 99, 1)).toBe(2);
    expect(stepLadder(ladder, 99, -1)).toBe(2);
    expect(stepLadder(ladder, -5, -1)).toBe(0);
    expect(stepLadder(ladder, -5, 1)).toBe(0);
  });

  it('lands on the bottom when the value could not be read at all', () => {
    expect(stepLadder(ladder, null, 1)).toBe(0);
    expect(stepLadder(ladder, null, -1)).toBe(0);
    expect(stepLadder(ladder, Number.NaN, 1)).toBe(0);
  });

  it('does not mistake float noise for a position between steps', () => {
    // 14px / 16 is exact, but 0.1 + 0.2 is not — a ladder read back through a division must not
    // step twice because the value is 1e-17 off its own rung.
    expect(stepLadder([0, 0.1, 0.30000000000000004, 0.5], 0.1 + 0.2, 1)).toBe(0.5);
    expect(stepLadder([0, 0.1, 0.30000000000000004, 0.5], 0.1 + 0.2, -1)).toBe(0.1);
  });
});

/**
 * A side is a row's longhand, built on demand.
 *
 * `partEntry` is what makes "Padding, top" a stepper in its own right rather than a special case:
 * the same reading, stepping, unit conversion and writing code runs on it. The panel builds one per
 * side per render and `WRITABLE_PROPERTIES` builds the same set once, so anything the two disagree
 * about is a control that moves nothing.
 */
describe('sides', () => {
  const padding = propertyEntry('padding-block') as StepperEntry;

  it('narrows the side to its own longhand rather than inheriting the row\'s', () => {
    const [side] = padding.parts!;
    const entry = partEntry(padding, side);
    expect(entry.property).toBe(side.property);
    expect(entry.read).toEqual([side.property]);
    // The row reads both sides to know whether they agree; the side must read only itself, or
    // stepping the top would be answered with the bottom's value.
    expect(entry.read).not.toEqual(padding.read);
  });

  it('gives a side its own id, since the panel keys the rendered rows on it', () => {
    const ids = padding.parts!.map(side => partEntry(padding, side).id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(padding.id);
  });

  it('keeps the ladder, units and kind of the row it came from', () => {
    // A side steps the same rungs as its parent — the shorthand and its longhands are one control
    // split four ways, not four controls that happen to sit together.
    const entry = partEntry(padding, padding.parts![0]);
    expect(entry.ladder).toEqual(padding.ladder);
    expect(entry.units).toEqual(padding.units);
    expect(entry.kind).toBe(padding.kind);
    expect(entry.control).toBe('stepper');
  });

  it('does not hand a side parts of its own', () => {
    // A side is a leaf. Carrying the parent's list down would make it claim a disclosure it never
    // renders and would put the same four longhands in the writable set twice.
    expect(partEntry(padding, padding.parts![0]).parts).toBeUndefined();
  });
});

describe('the writable set', () => {
  it('holds every row plus every side of every row', () => {
    const sides = STYLE_PROPERTIES.flatMap(e => (e.control === 'stepper' && e.parts ? e.parts : []));
    expect(WRITABLE_PROPERTIES).toHaveLength(STYLE_PROPERTIES.length + sides.length);
  });

  it('gives every entry a unique id and a unique property', () => {
    // The same invariant the row table has, one level down — and the one that fails first if a side
    // ever inherits its parent's id: the optimistic overlay and the loss banner both key on it, and
    // the panel uses it as the React key for the four rendered sides.
    expect(new Set(WRITABLE_PROPERTIES.map(e => e.id)).size).toBe(WRITABLE_PROPERTIES.length);
    expect(new Set(WRITABLE_PROPERTIES.map(e => e.property)).size).toBe(WRITABLE_PROPERTIES.length);
  });

  it('names a longhand for every side, so opening a row cannot write the row again', () => {
    // The rows themselves write shorthands on purpose — `padding-block` is the whole point of the
    // closed control. A *side* writing one would mean the four disclosed steppers each set both
    // edges, so "Padding, top" would move the bottom too.
    const sides = WRITABLE_PROPERTIES.filter(entry => !STYLE_PROPERTIES.includes(entry));
    expect(sides.length).toBeGreaterThan(0);
    for (const entry of sides) {
      expect(CSS_SHORTHANDS[entry.property] ?? null, `${entry.id} writes a shorthand`).toBeNull();
    }
  });

  it('keeps the rows in their table order, since one entry\'s conversion reads another\'s value', () => {
    // `line-height` is unitless and resolves against `font-size`, which has to be overlaid first.
    const rows = WRITABLE_PROPERTIES.filter(e => STYLE_PROPERTIES.includes(e)).map(e => e.id);
    expect(rows).toEqual(STYLE_PROPERTIES.map(e => e.id));
  });
});

describe('rowProperties', () => {
  it('covers a row\'s sides and their physical spellings, so its dot resets all of them', async () => {
    const { rowProperties, STYLE_PROPERTIES } = await import('../properties');
    const row = (id: string) => STYLE_PROPERTIES.find((e) => e.id === id)!;
    expect(rowProperties(row('padding-block'))).toEqual(
      ['padding-block', 'padding-block-start', 'padding-block-end', 'padding-top', 'padding-bottom'],
    );
    expect(rowProperties(row('border-radius'))).toContain('border-top-left-radius');
    expect(rowProperties(row('overflow'))).toEqual(['overflow', 'overflow-x', 'overflow-y']);
    expect(rowProperties(row('color'))).toEqual(['color']);
  });
});
