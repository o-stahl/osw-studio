/** Whether this is a Mac, whose shortcuts use ⌘ where other systems use Ctrl. */
export const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');

/** A shortcut with the platform's modifier, as menus write it: ⌘S on a Mac, Ctrl+S elsewhere. */
export const modShortcut = (key: string): string => (isMac() ? `⌘${key}` : `Ctrl+${key}`);

/** The same with Shift: ⇧⌘Z on a Mac, Ctrl+Shift+Z elsewhere. */
export const modShiftShortcut = (key: string): string => (isMac() ? `⇧⌘${key}` : `Ctrl+Shift+${key}`);

/** A shortcut with Alt: ⌥↑ on a Mac, Alt+↑ elsewhere. */
export const altShortcut = (key: string): string => (isMac() ? `⌥${key}` : `Alt+${key}`);

/** A shortcut with the platform's modifier and Alt: ⌥⌘G on a Mac, Ctrl+Alt+G elsewhere. */
export const modAltShortcut = (key: string): string => (isMac() ? `⌥⌘${key}` : `Ctrl+Alt+${key}`);

/** A shortcut with Shift: ⇧1 on a Mac, Shift+1 elsewhere. */
export const shiftShortcut = (key: string): string => (isMac() ? `⇧${key}` : `Shift+${key}`);
