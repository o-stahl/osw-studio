import { describe, it, expect } from 'vitest';
import { pinPageViewportUnits, pinViewportUnits, viewportRule } from '../viewport-units';

describe('pinViewportUnits', () => {
  it('writes every viewport-height length in terms of --osw-vh', () => {
    expect(pinViewportUnits('min-height: 100vh')).toBe('min-height: calc(100 * var(--osw-vh))');
    expect(pinViewportUnits('height: 50dvh; top: -10svh; max-height: 1.5lvh; inset: .5vh'))
      .toBe('height: calc(50 * var(--osw-vh)); top: calc(-10 * var(--osw-vh)); max-height: calc(1.5 * var(--osw-vh)); inset: calc(.5 * var(--osw-vh))');
    expect(pinViewportUnits('height: calc(100vh - 64px)')).toBe('height: calc(calc(100 * var(--osw-vh)) - 64px)');
  });

  it('leaves widths and names alone', () => {
    expect(pinViewportUnits('width: 100vw')).toBe('width: 100vw');
    expect(pinViewportUnits('.h-100vh { height: 100vh } :root { --gap-10vh: 2px }'))
      .toBe('.h-100vh { height: calc(100 * var(--osw-vh)) } :root { --gap-10vh: 2px }');
  });
});

describe('pinPageViewportUnits', () => {
  it('pins style blocks and style attributes, and not the page text', () => {
    const html = '<style>.hero{min-height:100vh}</style><div style="height: 80vh">80vh tall</div><p style=\'top:5vh\'>x</p>';
    expect(pinPageViewportUnits(html)).toBe(
      '<style>.hero{min-height:calc(100 * var(--osw-vh))}</style><div style="height: calc(80 * var(--osw-vh))">80vh tall</div><p style=\'top:calc(5 * var(--osw-vh))\'>x</p>');
  });
});

describe('viewportRule', () => {
  it('makes one vh a hundredth of the device height', () => {
    expect(viewportRule(900)).toBe(':root{--osw-vh:9px}');
    expect(viewportRule(667)).toBe(':root{--osw-vh:6.67px}');
  });
});
