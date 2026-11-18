import { describe, it, expect } from 'vitest';
import { blurOf, gradientString, isOneGradient, layers, parseGradient, parseShadow, readShadow, shadowString, withBlur } from '../effects';

describe('shadows', () => {
  it('reads the first layer in either order the engine and an author write it', () => {
    expect(parseShadow('0px 8px 24px 0px rgba(0, 0, 0, 0.16)')).toMatchObject({ x: 0, y: 8, blur: 24, spread: 0, color: 'rgba(0, 0, 0, 0.16)' });
    expect(parseShadow('rgb(1, 2, 3) 2px 4px 6px 0px')).toMatchObject({ x: 2, y: 4, blur: 6, color: 'rgb(1, 2, 3)' });
    expect(parseShadow('none')).toBeNull();
  });

  it('writes the first layer back with the others as they were', () => {
    const s = parseShadow('inset 1px 1px 2px 0px #000, 0px 0px 4px 0px red')!;
    expect(shadowString({ ...s, y: 3 })).toBe('inset 1px 3px 2px 0px #000, 0px 0px 4px 0px red');
  });

  it('splits only at top-level commas', () => {
    expect(layers('a, rgba(0, 0, 0, 1) 1px, b')).toEqual(['a', 'rgba(0, 0, 0, 1) 1px', 'b']);
  });

  it('reads the declaration where it is a colour and px lengths, and the computed value where it is not', () => {
    const computed = 'rgba(0, 0, 0, 0.1) 0px 1px 2px 0px';
    expect(readShadow('0 2px 4px var(--shade)', computed)).toMatchObject({ x: 0, y: 2, blur: 4, color: 'var(--shade)' });
    expect(readShadow('var(--shadow-sm)', computed)).toMatchObject({ x: 0, y: 1, blur: 2, color: 'rgba(0, 0, 0, 0.1)' });
    expect(readShadow('0 0.5rem 1rem rgba(0, 0, 0, 0.2)', computed)).toMatchObject({ y: 1, blur: 2 });
    expect(readShadow('0 1px 2px black', computed)).toMatchObject({ color: 'rgba(0, 0, 0, 0.1)' });
    expect(readShadow('none', computed)).toBeNull();
    // Neither can be read: no fields, rather than zeros.
    expect(readShadow('var(--shadow-sm)', undefined)).toBeNull();
  });
});

describe('gradients', () => {
  it('reads an angle and two colours, project tokens included', () => {
    expect(parseGradient('linear-gradient(135deg, var(--mist), #2f6f5e)')).toEqual({ angle: 135, from: 'var(--mist)', to: '#2f6f5e' });
    expect(parseGradient('linear-gradient(to right, white, rgb(0, 0, 0))')).toEqual({ angle: 90, from: 'white', to: 'rgb(0, 0, 0)' });
    expect(parseGradient('linear-gradient(#fff, #000)')).toEqual({ angle: 180, from: '#fff', to: '#000' });
    expect(parseGradient('none')).toBeNull();
    expect(gradientString({ angle: 90, from: 'red', to: 'blue' })).toBe('linear-gradient(90deg, red, blue)');
  });

  it('reads nothing the fields could not write back whole', () => {
    expect(parseGradient('linear-gradient(#000, #000), url("hero.jpg")')).toBeNull();
    expect(parseGradient('url("a.png"), linear-gradient(#fff, #000)')).toBeNull();
    expect(parseGradient('linear-gradient(90deg, #fff, #888, #000)')).toBeNull();
    expect(parseGradient('linear-gradient(90deg, #fff 20%, #000 80%)')).toBeNull();
    expect(parseGradient('radial-gradient(#fff, #000)')).toBeNull();
    expect(parseGradient('linear-gradient(to top right, #fff, #000)')).toBeNull();
  });

  it('tells one gradient from a background with other layers', () => {
    expect(isOneGradient('linear-gradient(90deg, #fff, #888, #000)')).toBe(true);
    expect(isOneGradient('linear-gradient(#000, #000), url("hero.jpg")')).toBe(false);
    expect(isOneGradient('url("hero.jpg")')).toBe(false);
  });
});

describe('blur in a filter list', () => {
  it('sets, changes and removes the blur and keeps the other functions', () => {
    expect(blurOf('brightness(1.2) blur(4px)')).toBe(4);
    expect(withBlur('brightness(1.2) blur(4px)', 8)).toBe('blur(8px) brightness(1.2)');
    expect(withBlur('brightness(1.2) blur(4px)', 0)).toBe('brightness(1.2)');
    expect(withBlur('blur(4px)', 0)).toBeNull();
    expect(withBlur('none', 6)).toBe('blur(6px)');
  });
});
