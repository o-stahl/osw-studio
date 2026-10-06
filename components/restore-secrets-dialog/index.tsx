'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle, Key } from 'lucide-react';
import type { BackendRestorePreview } from '@/lib/vfs/checkpoint';

interface RestoreSecretsDialogProps {
  open: boolean;
  /** What the checkpoint is called, so the user can tell which restore they are confirming. */
  description?: string;
  preview: BackendRestorePreview | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Shown before a restore that would cost the project a stored secret value, and only then. A
 * checkpoint holds a secret's name but never its value, so a restore that brings a deleted secret
 * back returns an empty placeholder, and one that removes a secret added since takes its value
 * with it. Everything else about a restore is reversible from another checkpoint; this is not.
 */
export function RestoreSecretsDialog({
  open,
  description,
  preview,
  onConfirm,
  onCancel,
}: RestoreSecretsDialogProps) {
  const tc = useTranslations('common');
  const tt = useTranslations('tooltips');
  const trs = useTranslations('restoreSecrets');
  if (!preview) return null;

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{trs('title')}</DialogTitle>
          <DialogDescription>
            {description
              ? trs('descNamed', { description })
              : trs('desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {preview.secretsDropped.length > 0 && (
            <SecretList
              title={tt('secretsRemoved')}
              hint={trs('removedHint')}
              names={preview.secretsDropped}
            />
          )}
          {preview.secretsCleared.length > 0 && (
            <SecretList
              title={tt('secretsRestored')}
              hint={trs('clearedHint')}
              names={preview.secretsCleared}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>{tc('actions.cancel')}</Button>
          <Button onClick={onConfirm}>{trs('restoreAnyway')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretList({ title, hint, names }: { title: string; hint: string; names: string[] }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <AlertTriangle className="h-4 w-4 text-amber-500" />
        {title}
      </div>
      <p className="pl-6 text-xs text-muted-foreground">{hint}</p>
      <div className="pl-6 space-y-1">
        {names.map(name => (
          <div key={name} className="flex items-center gap-1.5 text-sm font-mono">
            <Key className="h-3 w-3 shrink-0 text-muted-foreground" />
            {name}
          </div>
        ))}
      </div>
    </div>
  );
}
