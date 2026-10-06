'use client';

/** Text editing dialog. Neither reads nor writes; onRead and onApply are injected by the workspace. */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ApplyResult } from '@/lib/direct-edit/types';
import type { TextReadResult } from '@/lib/direct-edit/apply-text';
import {
  textConfirmationMessage,
  textIsChanged,
  textRefusal,
  textRefusalAgentPrompt,
  textRefusalMessage,
  textRefusalOffersAgent,
  textRefusalTitle,
  type TextRefusal,
} from './state';

export interface TextPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the selected element says, read out of source. Called once per opening. */
  onRead: () => Promise<TextReadResult>;
  /**
   * Write the new text. Returns what happened; this component renders it.
   *
   * `confirmedMultiInstance` is passed straight through to `applyText`, which refuses without it
   * whenever the source tag renders more than once.
   */
  onApply: (text: string, confirmedMultiInstance: boolean) => Promise<ApplyResult>;
  /** Hand a refusal to the agent, where the refusal is one the agent could act on. */
  onAskAgent?: (prompt: string) => void;
}

/** A held-back edit: the file was not written, and will not be until the user says yes. */
interface PendingEdit {
  instances: number;
  file?: string;
}

export function TextPopover({ open, onOpenChange, onRead, onApply, onAskAgent }: TextPopoverProps) {
  const tc = useTranslations('common');
  const ts = useTranslations('styles');
  const tt = useTranslations('tooltips');
  const ttp = useTranslations('textPopover');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The text as it was read. Save is inert until the field differs from it. */
  const [original, setOriginal] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [refusal, setRefusal] = useState<TextRefusal | null>(null);
  const [pending, setPending] = useState<PendingEdit | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // A fresh dialog starts with no verdict and no text on the screen: both describe the element
    // that was selected last time, which is not the one this is about.
    setRefusal(null);
    setPending(null);
    setOriginal(null);
    setText('');
    setLoading(true);
    void (async () => {
      const result = await onRead();
      // The dialog can be closed and reopened against another element before a read returns; the
      // late answer must not overwrite the new one's.
      if (cancelled) return;
      setLoading(false);
      if (result.ok) {
        setOriginal(result.text);
        setText(result.text);
        return;
      }
      setRefusal(textRefusal(result));
    })();
    return () => { cancelled = true; };
  }, [open, onRead]);

  const apply = useCallback(async (confirmed: boolean) => {
    setBusy(true);
    try {
      const result = await onApply(text, confirmed);
      if (result.ok) {
        onOpenChange(false);
        return;
      }
      if (result.reason === 'needs-confirmation') {
        setRefusal(null);
        setPending({ instances: result.instances ?? 0, file: result.file });
        return;
      }
      setPending(null);
      setRefusal(textRefusal(result));
    } finally {
      setBusy(false);
    }
  }, [onApply, onOpenChange, text]);

  const askAgent = () => {
    if (!refusal || !onAskAgent) return;
    onAskAgent(textRefusalAgentPrompt(refusal));
    onOpenChange(false);
  };

  const changed = original !== null && textIsChanged(original, text);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{ts('editText')}</DialogTitle>
          <DialogDescription>{ts('editTextDesc')}</DialogDescription>
        </DialogHeader>

        {refusal && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" />
              {textRefusalTitle(refusal, ttp)}
            </div>
            <p className="mt-1 text-muted-foreground">{textRefusalMessage(refusal, ttp)}</p>
            {onAskAgent && textRefusalOffersAgent(refusal) && (
              <Button className="mt-2" size="sm" variant="outline" onClick={askAgent}>
                {ts('askAgent')}
              </Button>
            )}
          </div>
        )}

        {pending && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" />
              {tt('usedMoreThanOnce')}
            </div>
            <p className="mt-1 text-muted-foreground">
              {textConfirmationMessage(pending.instances, ttp, pending.file)}
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void apply(true)}>
                {pending.instances > 1 ? ts('changeAll', { count: pending.instances }) : ts('changeIt')}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setPending(null)}>
                {tc('actions.cancel')}
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> {ts('reading')}
          </div>
        ) : original !== null && (
          <Textarea
            data-osw-text-field
            autoFocus
            rows={4}
            value={text}
            disabled={busy}
            onChange={event => setText(event.target.value)}
          />
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>{tc('actions.cancel')}</Button>
          {original !== null && (
            <Button data-osw-text-save disabled={busy || !changed} onClick={() => void apply(false)}>
              {tc('actions.save')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
