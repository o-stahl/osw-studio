import { describe, it, expect, afterEach, vi } from 'vitest';
import { altShortcut, isMac, modAltShortcut, modShiftShortcut, modShortcut, shiftShortcut } from '../platform';

/** The shortcut labels menus show, on a Mac and elsewhere, by the platform `navigator` reports. */

const MAC = { platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15' };
const WINDOWS = { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shortcut labels', () => {
  it('use the Mac symbols on a Mac', () => {
    vi.stubGlobal('navigator', MAC);
    expect(isMac()).toBe(true);
    expect(altShortcut('↑')).toBe('⌥↑');
    expect(modAltShortcut('G')).toBe('⌥⌘G');
    expect(shiftShortcut('1')).toBe('⇧1');
    expect(modShortcut('D')).toBe('⌘D');
    expect(modShiftShortcut('Z')).toBe('⇧⌘Z');
  });

  it('spell the modifiers out elsewhere', () => {
    vi.stubGlobal('navigator', WINDOWS);
    expect(isMac()).toBe(false);
    expect(altShortcut('↑')).toBe('Alt+↑');
    expect(modAltShortcut('G')).toBe('Ctrl+Alt+G');
    expect(shiftShortcut('1')).toBe('Shift+1');
    expect(modShortcut('D')).toBe('Ctrl+D');
    expect(modShiftShortcut('Z')).toBe('Ctrl+Shift+Z');
  });

  it('read a Mac from the user agent where the platform is empty', () => {
    vi.stubGlobal('navigator', { platform: '', userAgent: MAC.userAgent });
    expect(altShortcut('↓')).toBe('⌥↓');
  });
});
