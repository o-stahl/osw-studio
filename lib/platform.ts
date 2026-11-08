/** Whether this is a Mac, whose shortcuts use ⌘ where other systems use Ctrl. */
export const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');

/** A shortcut with the platform's modifier, as menus write it: ⌘S on a Mac, Ctrl+S elsewhere. */
export const modShortcut = (key: string): string => (isMac() ? `⌘${key}` : `Ctrl+${key}`);
