'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { NewItemKind, NewItemProblem } from './new-item';

/** A new file or folder the explorer asks a name for: what it is, and the folder it goes in. */
export interface NewItemRequest {
  kind: NewItemKind;
  parentPath: string;
}

/**
 * Asks for the name of a new file or folder, in the app's own dialog: the desktop app's Electron has
 * no `window.prompt()`. A problem with the name keeps the dialog open, with the name in place.
 */
export function CreateItemDialog({ request, onClose, onCreate }: {
  /** Null while closed. */
  request: NewItemRequest | null;
  onClose: () => void;
  /** Make the item: null once it exists, or why it could not be made. */
  onCreate: (name: string) => Promise<NewItemProblem | null>;
}) {
  const t = useTranslations('fileExplorer');
  const tc = useTranslations('common');
  // The request on screen, kept while the dialog closes so its title does not change as it fades.
  const [shown, setShown] = useState<NewItemRequest | null>(request);
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<NewItemProblem | null>(null);
  const [busy, setBusy] = useState(false);
  if (request && request !== shown) {
    // Each request starts with an empty name.
    setShown(request);
    setName('');
    setProblem(null);
    setBusy(false);
  }

  const trimmed = name.trim();
  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    const result = await onCreate(trimmed);
    setBusy(false);
    if (result) setProblem(result);
    else onClose();
  };

  const message = problem === 'invalid' ? t('nameInvalid')
    : problem === 'exists' ? t('nameTaken', { name: trimmed })
    : problem === 'failed' ? t('createFailed', { name: trimmed })
    : null;

  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-[420px]">
        <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <DialogHeader>
            <DialogTitle>{shown?.kind === 'directory' ? t('newFolder') : t('newFile')}</DialogTitle>
            <DialogDescription>{t('newItemIn', { folder: shown?.parentPath ?? '/' })}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="new-item-name">{tc('labels.name')}</Label>
            <Input
              id="new-item-name"
              value={name}
              onChange={(e) => { setName(e.target.value); setProblem(null); }}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              aria-invalid={message !== null}
              aria-describedby={message ? 'new-item-problem' : undefined}
            />
            {message && <p id="new-item-problem" className="text-sm text-destructive">{message}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{tc('actions.cancel')}</Button>
            <Button type="submit" disabled={busy || trimmed === ''}>{busy ? tc('actions.creating') : t('create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
