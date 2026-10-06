'use client';

import { toast } from 'sonner';

import { translator } from '@/lib/i18n/runtime';

import type { ImportDialogSource } from './index';

/**
 * Opening the OS folder picker and turning what comes back into an import source.
 *
 * It lives here rather than in either caller because both surfaces need it and both need it to
 * mean the same thing — in particular the stripped root segment below, which decides whether a
 * manifest is found at all. Two copies of that rule would eventually disagree.
 *
 * There is no React input for this: `webkitdirectory` is a DOM property with no JSX attribute, so
 * the element is built by hand. It is never attached to the document; a detached input still opens
 * the picker, and nothing else in the app needs to see it.
 */
export function pickFolderSource(onPick: (source: ImportDialogSource) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.webkitdirectory = true;

  input.onchange = () => {
    const picked = Array.from(input.files ?? []);
    // A folder with nothing in it opens no dialog, so without this the menu item looks broken:
    // the picker closes and the app does nothing at all. Cancelling the picker fires no change
    // event in any browser we support, so this only ever speaks about a folder actually chosen.
    if (picked.length === 0) {
      toast.error(translator()('importDialog.emptyFolder'));
      return;
    }
    const rootName = picked[0].webkitRelativePath?.split('/')[0] ?? '';
    // Every webkitRelativePath is prefixed with the chosen folder's own name. That segment goes:
    // the user picked the folder to say "this is the project", so its contents belong at the root.
    // Keeping it would bury project.json one level down, where nothing looks for it.
    const files = picked.map((file) => {
      const parts = (file.webkitRelativePath || file.name).split('/');
      return { file, path: '/' + (parts.length > 1 ? parts.slice(1) : parts).join('/') };
    });
    // A fresh object every time, which is what makes the dialog re-analyse.
    onPick({ kind: 'folder', name: rootName || translator()('importDialog.selectedFolder'), files });
  };

  input.click();
}
