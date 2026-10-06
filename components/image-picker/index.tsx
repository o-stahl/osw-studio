'use client';

/** Image picker dialog. Does not write; onApply is injected by the workspace. */

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import { Upload, AlertTriangle, Loader2 } from 'lucide-react';
import { vfs } from '@/lib/vfs';
import { getSpecificMimeType } from '@/lib/vfs/types';
import { uploadFileToProject, uploadTargetPath } from '@/lib/vfs/upload-file';
import { logger } from '@/lib/utils';
import type { ApplyResult } from '@/lib/direct-edit/types';
import {
  imageConfirmationMessage,
  imageRefusal,
  imageRefusalAgentPrompt,
  imageRefusalMessage,
  imageRefusalOffersAgent,
  imageRefusalTitle,
  projectImages,
  uploadDirectory,
  type ImageRefusal,
} from './state';

export interface ImagePickerProps {
  open: boolean;
  projectId: string;
  /** The element's current `src`, so the picture it is already using is marked rather than offered. */
  currentSrc?: string;
  onOpenChange: (open: boolean) => void;
  /**
   * Write the new `src`. Returns what happened; this component renders it.
   *
   * `confirmedMultiInstance` is passed straight through to `applyImageSrc`, which refuses without it
   * whenever the source tag renders more than once.
   */
  onApply: (path: string, confirmedMultiInstance: boolean) => Promise<ApplyResult>;
  /** Hand a refusal to the agent, where the refusal is one the agent could act on. */
  onAskAgent?: (prompt: string) => void;
}

interface ImageEntry {
  path: string;
  /** An object URL for the file's bytes. Revoked when the list is replaced or the dialog closes. */
  url: string;
}

/** A held-back replacement: the file was not written, and will not be until the user says yes. */
interface PendingReplacement {
  path: string;
  instances: number;
  file?: string;
}

export function ImagePicker({
  open,
  projectId,
  currentSrc,
  onOpenChange,
  onApply,
  onAskAgent,
}: ImagePickerProps) {
  const tsx = useTranslations('styles');
  const ttx = useTranslations('tooltips');
  const tc = useTranslations('common');
  const tip = useTranslations('imagePicker');
  const [entries, setEntries] = useState<ImageEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<ImageRefusal | null>(null);
  const [pending, setPending] = useState<PendingReplacement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Every object URL this dialog has minted, so closing it does not leak the project's images into
  // the document for the rest of the session.
  const urlsRef = useRef<string[]>([]);
  const revokeAll = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await vfs.init();
      const files = await vfs.listFiles(projectId);
      revokeAll();
      const next = projectImages(files).map(file => {
        const blob = new Blob([file.content], { type: getSpecificMimeType(file.path) });
        const url = URL.createObjectURL(blob);
        urlsRef.current.push(url);
        return { path: file.path, url };
      });
      setEntries(next);
    } catch (error) {
      logger.error('Image picker: could not list the project files', error);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, revokeAll]);

  useEffect(() => {
    if (!open) return;
    // A fresh dialog starts with no verdict on the screen: a refusal from the last time it was open
    // describes a selection that is no longer the one being replaced.
    setRefusal(null);
    setPending(null);
    void load();
  }, [open, load]);

  useEffect(() => revokeAll, [revokeAll]);

  const apply = useCallback(async (path: string, confirmed: boolean) => {
    setBusy(true);
    try {
      const result = await onApply(path, confirmed);
      if (result.ok) {
        onOpenChange(false);
        return;
      }
      if (result.reason === 'needs-confirmation') {
        setRefusal(null);
        setPending({ path, instances: result.instances ?? 0, file: result.file });
        return;
      }
      setPending(null);
      setRefusal(imageRefusal(result));
    } finally {
      setBusy(false);
    }
  }, [onApply, onOpenChange]);

  const handleUpload = useCallback(async (file: File) => {
    const targetDir = uploadDirectory(entries.map(entry => entry.path));
    setBusy(true);
    let outcome: string;
    try {
      // Quiet: this dialog is about to say what happened by closing or by showing a banner, and two
      // notifications for one click is one too many. The overwrite prompt still runs — `quiet` is
      // not `silent` — because replacing a picture the project already has is a real intention.
      outcome = await uploadFileToProject(projectId, file, targetDir, { quiet: true });
    } finally {
      setBusy(false);
    }
    if (outcome !== 'ok') return;
    const path = uploadTargetPath(file, targetDir);
    await load();
    await apply(path, false);
  }, [apply, entries, load, projectId]);

  const askAgent = () => {
    if (!refusal || !onAskAgent) return;
    onAskAgent(imageRefusalAgentPrompt(refusal));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tip('title')}</DialogTitle>
          <DialogDescription>
            {tip('description')}
          </DialogDescription>
        </DialogHeader>

        {refusal && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" />
              {imageRefusalTitle(refusal, tip)}
            </div>
            <p className="mt-1 text-muted-foreground">{imageRefusalMessage(refusal, tip)}</p>
            {onAskAgent && imageRefusalOffersAgent(refusal) && (
              <Button className="mt-2" size="sm" variant="outline" onClick={askAgent}>
                {tsx('askAgent')}
              </Button>
            )}
          </div>
        )}

        {pending && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium">
              <AlertTriangle className="h-4 w-4" />
              {ttx('usedMoreThanOnce')}
            </div>
            <p className="mt-1 text-muted-foreground">
              {imageConfirmationMessage(pending.instances, tip, pending.file)}
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void apply(pending.path, true)}>
                {pending.instances > 1 ? tip('replaceAll', { count: pending.instances }) : tip('replaceIt')}
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setPending(null)}>
                {tc('actions.cancel')}
              </Button>
            </div>
          </div>
        )}

        <div className="max-h-[50vh] overflow-y-auto" data-osw-image-list>
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {tip('reading')}
            </div>
          ) : entries.length === 0 ? (
            <p className="py-8 text-sm text-muted-foreground">
              {tip('noImages')}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {entries.map(entry => {
                const inUse = !!currentSrc && currentSrc.replace(/^\.?\//, '') === entry.path.replace(/^\//, '');
                return (
                  <button
                    key={entry.path}
                    type="button"
                    disabled={busy}
                    data-osw-image-option={entry.path}
                    onClick={() => void apply(entry.path, false)}
                    className="group rounded-md border border-border p-1 text-left hover:border-primary disabled:opacity-50"
                  >
                    {/* A background rather than an <img>: the same object-fit result without the
                        next/image lint rule, and a broken file degrades to an empty tile. */}
                    <div
                      className="h-24 w-full rounded bg-muted bg-contain bg-center bg-no-repeat"
                      style={{ backgroundImage: `url("${entry.url}")` }}
                    />
                    <div className="mt-1 truncate text-xs" title={entry.path}>
                      {entry.path}
                    </div>
                    {inUse && <div className="text-[10px] text-muted-foreground">in use</div>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={event => {
              const file = event.target.files?.[0];
              // Cleared before the await so choosing the same file twice in a row still fires.
              event.target.value = '';
              if (file) void handleUpload(file);
            }}
          />
          <Button variant="outline" disabled={busy} onClick={() => fileInputRef.current?.click()}>
            <Upload className="mr-2 h-4 w-4" /> {tip('upload')}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{tc('actions.cancel')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
