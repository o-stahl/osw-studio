'use client';

/**
 * Shows what a template renders as, before anyone commits to a project made from it.
 *
 * It compiles through the same VirtualServer the workspace preview uses, by way of a scratch
 * project that lives only as long as this dialog. Rendering from anything other than the real
 * compiler would show a page the app would not actually produce, which is the one thing a preview
 * must not do.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { MultipagePreview } from '@/components/preview/multipage-preview';
import { vfs } from '@/lib/vfs';
import {
  createTemplatePreviewProject,
  discardTemplatePreviewProject,
  templatePreviewUnavailableReason,
} from '@/lib/vfs/templates/preview-project';
import type { CustomTemplate, ProjectRuntime } from '@/lib/vfs/types';
import { logger } from '@/lib/utils';

interface TemplatePreviewDialogProps {
  /** The template-browser selection value, or null when nothing is being previewed. */
  value: string | null;
  name: string;
  runtime: ProjectRuntime;
  customTemplates: CustomTemplate[];
  onClose: () => void;
}

type State =
  | { status: 'building' }
  | { status: 'ready'; projectId: string; runtime: ProjectRuntime }
  | { status: 'unavailable'; reason: 'console' | 'loadFailed' | 'renderFailed' };

export function TemplatePreviewDialog({
  value,
  name,
  runtime,
  customTemplates,
  onClose,
}: TemplatePreviewDialogProps) {
  const t = useTranslations('templatesUi');
  const [state, setState] = useState<State>({ status: 'building' });

  /**
   * The scratch project is tracked in a ref as well as in state so cleanup can reach it from an
   * unmount, and so a build that finishes after the dialog closed still gets torn down rather than
   * leaking a project nobody can see.
   */
  const scratchId = useRef<string | null>(null);

  useEffect(() => {
    if (!value) return;

    let cancelled = false;
    setState({ status: 'building' });

    const unavailable = templatePreviewUnavailableReason(runtime);
    if (unavailable) {
      setState({ status: 'unavailable', reason: unavailable });
      return;
    }

    (async () => {
      try {
        await vfs.init();
        const created = await createTemplatePreviewProject(vfs, value, customTemplates);

        if (!created) {
          if (!cancelled) {
            setState({ status: 'unavailable', reason: 'loadFailed' });
          }
          return;
        }

        // Closing while the files were being written still leaves a project to remove.
        if (cancelled) {
          await discardTemplatePreviewProject(vfs, created.projectId);
          return;
        }

        scratchId.current = created.projectId;
        setState({ status: 'ready', projectId: created.projectId, runtime: created.runtime });
      } catch (error) {
        logger.error('[TemplatePreview] Failed to build preview:', error);
        if (!cancelled) {
          setState({ status: 'unavailable', reason: 'renderFailed' });
        }
      }
    })();

    return () => {
      cancelled = true;
      const id = scratchId.current;
      scratchId.current = null;
      if (id) void discardTemplatePreviewProject(vfs, id);
    };
  }, [value, runtime, customTemplates]);

  return (
    <Dialog open={!!value} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[95vw] lg:max-w-[80vw] 2xl:max-w-[1400px] w-full h-[90vh] p-0 flex flex-col gap-0">
        <DialogHeader className="p-4 border-b shrink-0">
          <DialogTitle className="text-base">{t('previewTitle', { name })}</DialogTitle>
          <DialogDescription className="text-xs">
            {t('previewDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-hidden">
          {state.status === 'building' && (
            <div className="h-full flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              {t('buildingPreview')}
            </div>
          )}

          {state.status === 'unavailable' && (
            <div className="h-full flex items-center justify-center p-8">
              <p className="text-sm text-muted-foreground text-center max-w-sm">{t(`previewUnavailable.${state.reason}`)}</p>
            </div>
          )}

          {state.status === 'ready' && (
            <MultipagePreview
              projectId={state.projectId}
              runtime={state.runtime}
              standalone
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
