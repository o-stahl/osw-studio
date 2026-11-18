import { describe, it, expect } from 'vitest';
import {
  activeOptionValue,
  atLadderEnd,
  convertUnit,
  formatComputed,
  formatNumber,
  isMixed,
  optionMatches,
  parsePx,
  pxPerUnit,
  readValue,
  stepValue,
  toLadderNumber,
  typedValue,
  unknownUnitContext,
  writeValue,
  type UnitContext,
} from '../controls';
import { propertyEntry, type SegmentedEntry, type StepperEntry } from '../properties';

/**
 * The root font size the frame reported, as a context.
 *
 * Written out at every call site that needs one rather than defaulted, because "16" being a
 * *measurement* and not an assumption is the property these tests exist to hold: a `rem` conversion
 * with no context now produces `null`, not a number computed against a guess.
 */
const rem16: UnitContext = { rootFontSize: 16 };
const rem10: UnitContext = { rootFontSize: 10 };

/**
 * The controls' value maths, tested as plain functions.
 *
 * The widgets themselves are not asserted on: there is no React Testing Library here, and a shallow
 * assertion on JSX would be a test of the test. Everything with a decision in it — the px-to-unit
 * conversion, which option lights up, where a step lands — is here.
 */

const padding = propertyEntry('padding-block') as StepperEntry;
const lineHeight = propertyEntry('line-height') as StepperEntry;
const borderWidth = propertyEntry('border-width') as StepperEntry;
const fontSize = propertyEntry('font-size') as StepperEntry;
const textAlign = propertyEntry('text-align') as SegmentedEntry;
const display = propertyEntry('display') as SegmentedEntry;

/** A computed reply with both padding sides agreeing. */
const pad = (value: string) => ({ 'padding-block-start': value, 'padding-block-end': value });

describe('parsePx', () => {
  it('reads a computed length', () => {
    expect(parsePx('24px')).toBe(24);
    expect(parsePx('0px')).toBe(0);
    expect(parsePx('0')).toBe(0);
    expect(parsePx(' 1.5px ')).toBe(1.5);
  });

  it('refuses anything that is not a length, rather than reading it as zero', () => {
    for (const bad of ['', 'auto', 'normal', '50%', 'calc(1rem + 2px)', 'inherit', undefined, null]) {
      expect(parsePx(bad), `should refuse ${String(bad)}`).toBeNull();
    }
  });
});

describe('readValue', () => {
  it('returns the value the sides agree on', () => {
    expect(readValue(padding, pad('16px'))).toBe('16px');
  });

  it('returns nothing when the sides disagree, rather than picking one', () => {
    const values = { 'padding-block-start': '16px', 'padding-block-end': '32px' };
    expect(readValue(padding, values)).toBeNull();
    expect(isMixed(padding, values)).toBe(true);
  });

  it('returns nothing when the frame has not answered', () => {
    expect(readValue(padding, {})).toBeNull();
    expect(readValue(padding, { 'padding-block-start': '16px' })).toBeNull();
    expect(isMixed(padding, {})).toBe(false);
  });

  it('ignores the divisor a ratio also fetches', () => {
    expect(readValue(lineHeight, { 'line-height': '24px', 'font-size': '16px' })).toBe('24px');
  });
});

describe('formatComputed', () => {
  it('renders a computed px value in the unit the control writes', () => {
    expect(formatComputed(padding, pad('24px'), rem16)).toBe('1.5rem');
    expect(formatComputed(padding, pad('0px'), rem16)).toBe('0rem');
  });

  it('leaves a px control in px', () => {
    const values = Object.fromEntries(borderWidth.read.map(n => [n, '2px']));
    expect(formatComputed(borderWidth, values)).toBe('2px');
  });

  it('renders a ratio against the element\'s own font size, not the root', () => {
    // 30px line-height on a 20px element is 1.5 — reading it against the 16px root would say 1.875.
    expect(formatComputed(lineHeight, { 'line-height': '30px', 'font-size': '20px' })).toBe('1.5');
  });

  it('honours a non-default root font size', () => {
    expect(formatComputed(padding, pad('20px'), rem10)).toBe('2rem');
  });

  it('shows nothing at all until the frame has said what a rem is worth', () => {
    // The alternative — falling back to 16 — puts `1.25rem` on screen for an element that is
    // 2rem on a 10px root, and the user steps from a number that was never true.
    expect(formatComputed(padding, pad('20px'), unknownUnitContext)).toBeNull();
    expect(formatNumber(padding, pad('20px'), unknownUnitContext)).toBeNull();
    // A px control needs no divisor, so it is readable in the same window.
    const widths = Object.fromEntries(borderWidth.read.map(n => [n, '2px']));
    expect(formatComputed(borderWidth, widths, unknownUnitContext)).toBe('2px');
  });

  it('renders in the unit the control is displaying, not only the entry default', () => {
    expect(formatComputed(padding, pad('24px'), rem16, 'px')).toBe('24px');
    expect(formatNumber(padding, pad('24px'), rem16, 'px')).toBe('24');
    expect(formatNumber(padding, pad('24px'), rem16)).toBe('1.5');
  });

  it('shows a keyword as it came back', () => {
    expect(formatComputed(textAlign, { 'text-align': 'justify' })).toBe('justify');
  });

  it('has nothing to show when the value is not a length', () => {
    expect(formatComputed(lineHeight, { 'line-height': 'normal', 'font-size': '16px' })).toBeNull();
    expect(formatComputed(padding, {}, rem16)).toBeNull();
  });
});

describe('pxPerUnit', () => {
  it('answers with the root size the frame reported, for rem', () => {
    expect(pxPerUnit(padding, pad('16px'), rem16, 'rem')).toBe(16);
    expect(pxPerUnit(padding, pad('16px'), rem10, 'rem')).toBe(10);
  });

  it('is 1 for px, whatever the root size is', () => {
    expect(pxPerUnit(padding, pad('16px'), rem10, 'px')).toBe(1);
    expect(pxPerUnit(padding, pad('16px'), unknownUnitContext, 'px')).toBe(1);
  });

  it('has no answer for rem until the frame has reported a root size', () => {
    expect(pxPerUnit(padding, pad('16px'), unknownUnitContext, 'rem')).toBeNull();
    expect(pxPerUnit(padding, pad('16px'), { rootFontSize: 0 }, 'rem')).toBeNull();
  });

  it('has no answer when the divisor did not come back, rather than guessing the root', () => {
    // The old fallback said 16 here, which is right only for an element whose font size happens
    // to equal the root — and `line-height` is read per element precisely because that is rare.
    expect(pxPerUnit(lineHeight, { 'line-height': '24px' }, rem16)).toBeNull();
  });

  it('never divides by zero', () => {
    expect(pxPerUnit(lineHeight, { 'line-height': '0px', 'font-size': '0px' }, rem16)).toBeNull();
  });
});

describe('a segmented control', () => {
  it('marks exactly one option active for a recognised keyword', () => {
    const values = { display: 'grid' };
    expect(display.options.filter(o => optionMatches(display, o, values))).toHaveLength(1);
    expect(activeOptionValue(display, values)).toBe('grid');
  });

  it('leaves every option inactive for an unrecognised keyword', () => {
    // `-webkit-center` is what Chrome computes for `<center>`, and it is not one of ours. Lighting
    // up "Centre" would claim a value the control does not write.
    const values = { 'text-align': '-webkit-center' };
    for (const option of textAlign.options) {
      expect(optionMatches(textAlign, option, values), `${option.value} should not match -webkit-center`)
        .toBe(false);
    }
    expect(activeOptionValue(textAlign, values)).toBeNull();
    expect(activeOptionValue(textAlign, { 'text-align': 'justify' })).toBe('justify');
  });

  it('leaves every option inactive when the frame has not answered', () => {
    expect(activeOptionValue(display, {})).toBeNull();
    expect(activeOptionValue(display, { display: '' })).toBeNull();
  });

  it('recognises the synonym an untouched element actually computes to', () => {
    // Chrome computes an unstyled element's text-align to `start`, not `left`.
    expect(activeOptionValue(textAlign, { 'text-align': 'start' })).toBe('left');
    expect(activeOptionValue(textAlign, { 'text-align': 'end' })).toBe('right');
  });

  it('matches a keyword whatever its case', () => {
    expect(activeOptionValue(display, { display: 'GRID' })).toBe('grid');
  });
});

describe('stepValue', () => {
  it('snaps to the nearer step when the value sits between two', () => {
    // 14px is 0.875rem; the spacing ladder has 0.75 and 1.
    expect(stepValue(padding, pad('14px'), 1, rem16)).toBe('1rem');
    expect(stepValue(padding, pad('14px'), -1, rem16)).toBe('0.75rem');
  });

  it('moves one rung from a value already on the ladder', () => {
    expect(stepValue(padding, pad('16px'), 1, rem16)).toBe('1.5rem');
    expect(stepValue(padding, pad('16px'), -1, rem16)).toBe('0.75rem');
  });

  it('writes the unit the control declares', () => {
    const values = Object.fromEntries(borderWidth.read.map(n => [n, '1px']));
    expect(stepValue(borderWidth, values, 1)).toBe('2px');
  });

  it('writes a ratio with no unit at all', () => {
    expect(stepValue(lineHeight, { 'line-height': '24px', 'font-size': '16px' }, 1)).toBe('1.75');
  });

  it('starts at the bottom of the ladder when the value could not be read', () => {
    expect(stepValue(padding, {}, 1, rem16)).toBe('0rem');
    expect(stepValue(lineHeight, { 'line-height': 'normal', 'font-size': '16px' }, 1)).toBe('1');
  });

  it('produces no floating-point tail', () => {
    expect(stepValue(padding, pad('12px'), 1, rem16)).toBe('1rem');
    expect(stepValue(padding, pad('4px'), 1, rem16)).toBe('0.5rem');
  });

  it('steps font-size from wherever the element actually is', () => {
    // The whole reason this is a stepper and not S/M/L/XL. A `2.5rem` heading is not on the ladder
    // and was not on the old four-option set either — the difference is that stepping moves it to
    // the neighbouring rung instead of offering only to shrink it to the largest named size.
    expect(formatComputed(fontSize, { 'font-size': '40px' }, rem16)).toBe('2.5rem');
    expect(stepValue(fontSize, { 'font-size': '40px' }, 1, rem16)).toBe('3rem');
    expect(stepValue(fontSize, { 'font-size': '40px' }, -1, rem16)).toBe('2.25rem');
    expect(stepValue(fontSize, { 'font-size': '16px' }, 1, rem16)).toBe('1.125rem');
  });

  it('snaps an off-ladder TYPED value onto the neighbouring rung', () => {
    // The case a typed value makes reachable: 1.0327rem is on no ladder anywhere, and `+` has to
    // mean something. It means the next rung of the project's scale in that direction — not
    // "1.0327 plus a fixed increment", which would walk a scale nobody designed, and not a refusal.
    const typed = { 'font-size': `${1.0327 * 16}px` };
    expect(formatNumber(fontSize, typed, rem16)).toBe('1.0327');
    expect(stepValue(fontSize, typed, 1, rem16)).toBe('1.125rem');
    expect(stepValue(fontSize, typed, -1, rem16)).toBe('1rem');
  });

  it('steps onto ladder rungs even when the control is writing another unit', () => {
    // The ladder is the entry's own scale, so `+` in px lands on the px value of the next rung —
    // 1.125rem is 18px on a 16px root — rather than walking a made-up px scale.
    expect(stepValue(fontSize, { 'font-size': '16px' }, 1, rem16, 'px')).toBe('18px');
    // Down from 1rem is 0.875rem, which is 14px — a rung of the type scale, not 15px.
    expect(stepValue(fontSize, { 'font-size': '16px' }, -1, rem16, 'px')).toBe('14px');
  });

  it('writes nothing at all when the rung cannot be expressed in the unit on screen', () => {
    expect(stepValue(padding, pad('16px'), 1, unknownUnitContext, 'px')).toBeNull();
  });
});

describe('convertUnit', () => {
  it('keeps the element exactly where it is, in the root size the frame reported', () => {
    // The decision this encodes: switching rem to px on a 1rem element writes 16px, not 1px.
    // Relabelling — keeping the number, changing the unit — divides the element by 16.
    expect(convertUnit(padding, pad('16px'), 'px', rem16)).toBe('16px');
    expect(convertUnit(padding, pad('17px'), 'rem', rem16)).toBe('1.0625rem');
  });

  it('computes from the frame\'s root size and not from 16', () => {
    // The same element, the same 20px, under `html { font-size: 62.5% }`. Anything hardcoding 16
    // answers 1.25rem here and writes a declaration that shrinks the element by a third.
    expect(convertUnit(padding, pad('20px'), 'rem', rem10)).toBe('2rem');
    expect(convertUnit(padding, pad('20px'), 'rem', rem16)).toBe('1.25rem');
  });

  it('converts a ratio through the element\'s own font size, both ways', () => {
    const values = { 'line-height': '30px', 'font-size': '20px' };
    expect(convertUnit(lineHeight, values, 'px', rem16)).toBe('30px');
    expect(convertUnit(lineHeight, values, 'rem', rem16)).toBe('1.875rem');
    expect(convertUnit(lineHeight, values, '', rem16)).toBe('1.5');
  });

  it('writes nothing rather than converting against a root size it has not been told', () => {
    expect(convertUnit(padding, pad('16px'), 'rem', unknownUnitContext)).toBeNull();
    // px needs no divisor, so it converts in the same window.
    expect(convertUnit(padding, pad('16px'), 'px', unknownUnitContext)).toBe('16px');
  });

  it('writes nothing for a value that is not a length', () => {
    expect(convertUnit(padding, pad('auto'), 'px', rem16)).toBeNull();
    expect(convertUnit(padding, { 'padding-block-start': '8px', 'padding-block-end': '16px' }, 'px', rem16))
      .toBeNull();
  });
});

describe('typedValue', () => {
  it('writes what was typed, in the unit the control is showing', () => {
    expect(typedValue('1.0625', 'rem')).toBe('1.0625rem');
    expect(typedValue('24', 'px')).toBe('24px');
    expect(typedValue('1.5', '')).toBe('1.5');
    expect(typedValue(' 2 ', 'rem')).toBe('2rem');
  });

  it('tolerates the unit being typed back, and only that unit', () => {
    expect(typedValue('1.5rem', 'rem')).toBe('1.5rem');
    // Not silently written as 1.5rem: the number meant px and the control is writing rem.
    expect(typedValue('1.5px', 'rem')).toBeNull();
  });

  it('refuses anything that is not a plain number', () => {
    for (const bad of ['', 'auto', '1;color:red', '12px}', 'calc(1rem + 2px)', '1.2.3', 'e5']) {
      expect(typedValue(bad, 'rem'), `should refuse ${bad}`).toBeNull();
    }
  });

  it('accepts a negative, which is a real value for a margin', () => {
    expect(typedValue('-0.5', 'rem')).toBe('-0.5rem');
  });
});

describe('atLadderEnd', () => {
  it('reports both ends', () => {
    expect(atLadderEnd(padding, pad('0px'), -1, rem16)).toBe(true);
    expect(atLadderEnd(padding, pad('0px'), 1, rem16)).toBe(false);
    expect(atLadderEnd(padding, pad('96px'), 1, rem16)).toBe(true);
  });

  it('reports neither end for a value it cannot read, so the buttons stay usable', () => {
    expect(atLadderEnd(padding, {}, 1, rem16)).toBe(false);
    expect(atLadderEnd(padding, {}, -1, rem16)).toBe(false);
  });
});

describe('writeValue', () => {
  it('drops the float tail a division leaves behind', () => {
    expect(writeValue(0.30000000000000004, 'rem')).toBe('0.3rem');
    expect(writeValue(1, 'rem')).toBe('1rem');
    expect(writeValue(1.5, '')).toBe('1.5');
  });
});

describe('toLadderNumber', () => {
  it('is null rather than zero for a value it cannot read', () => {
    expect(toLadderNumber(padding, pad('auto'), rem16)).toBeNull();
  });
});
