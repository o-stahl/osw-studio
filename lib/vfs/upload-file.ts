import { toast } from 'sonner';
import { vfs } from './index';
import { ensureAncestorDirs } from './archive/read-folder';
import { FILE_SIZE_LIMITS, getFileTypeFromPath, isTextExtension } from './types';
import { logger } from '@/lib/utils';
import { translator } from '@/lib/i18n/runtime';

/** Puts a File from a browser file input or drop into a project. */

/** Why the upload did not complete. `cancelled` is declined, not failed. */
export type UploadOutcome = 'ok' | 'too-large' | 'cancelled' | 'error';

export interface UploadFileOptions {
  /** Write here instead of deriving the path from `targetDir` and the file's name. */
  explicitPath?: string;
  /**
   * No toasts and no prompts. A folder upload reports progress itself and must not stop on a
   * dialog per duplicate, so a collision is skipped rather than asked about.
   */
  silent?: boolean;
  /** Do not call `onReload`. A batch caller refreshes once at the end instead of per file. */
  skipReload?: boolean;
  /**
   * No toasts, but still prompt. `silent` also means "never prompt", which a caller that just wants
   * to report the outcome itself must not inherit — declining a prompt nobody saw is not a refusal.
   */
  quiet?: boolean;
  /** Refresh whatever list the caller shows. Called after a successful write unless `skipReload`. */
  onReload?: () => Promise<void> | void;
}

export async function uploadFileToProject(
  projectId: string,
  file: File,
  targetDir: string | undefined,
  options?: UploadFileOptions,
): Promise<UploadOutcome> {
  const silent = options?.silent === true;
  const quiet = silent || options?.quiet === true;
  const skipReload = options?.skipReload === true;

  const fileType = getFileTypeFromPath(file.name);
  const sizeLimit = FILE_SIZE_LIMITS[fileType];
  if (file.size > sizeLimit) {
    if (!quiet) toast.error(translator()('upload.tooLarge', { name: file.name, mb: Math.round(sizeLimit / 1024 / 1024) }));
    return 'too-large';
  }

  const filePath = options?.explicitPath
    ?? (targetDir === '/' || !targetDir ? `/${file.name}` : `${targetDir}/${file.name}`);
  const isLarge = file.size > 512 * 1024; // 512KB threshold

  const doUpload = async () => {
    // Bytes unless this is a known text format. Reading an unrecognised file as text would
    // silently corrupt it, so anything not positively identified as text keeps its bytes.
    const content: string | ArrayBuffer = isTextExtension(file.name)
      ? await file.text()
      : await file.arrayBuffer();

    await ensureAncestorDirs(projectId, filePath);
    await vfs.createFile(projectId, filePath, content);
    if (!skipReload) await options?.onReload?.();
  };

  try {
    if (isLarge) {
      const sizeMB = (file.size / 1e6).toFixed(1);
      await toast.promise(doUpload(), {
        loading: translator()('upload.uploading', { name: file.name, mb: sizeMB }),
        success: quiet ? null as unknown as string : translator()('upload.uploaded', { name: file.name }),
        error: () => {
          // Suppress toast — error is handled in the outer catch
          return null as unknown as string;
        },
      });
    } else {
      await doUpload();
      if (!quiet) toast.success(translator()('upload.uploaded', { name: file.name }));
    }
    return 'ok';
  } catch (error: any) {
    if (error.message?.includes('already exists')) {
      if (silent) {
        // Folder upload: don't prompt, skip duplicates silently.
        return 'error';
      }
      if (confirm(translator()('upload.confirmOverwrite', { name: file.name }))) {
        try {
          await vfs.deleteFile(projectId, filePath);
          return await uploadFileToProject(projectId, file, targetDir, options);
        } catch (deleteError) {
          logger.error('Failed to overwrite file:', deleteError);
          if (!quiet) toast.error(translator()('upload.overwriteFailed'));
          return 'error';
        }
      }
      return 'cancelled';
    }
    logger.error('Failed to upload file:', error);
    if (!quiet) toast.error(translator()('upload.failed', { name: file.name, error: error.message }));
    return 'error';
  }
}

/** Where an uploaded file lands, given the same arguments -- without uploading it. */
export function uploadTargetPath(
  file: File,
  targetDir: string | undefined,
  explicitPath?: string,
): string {
  return explicitPath ?? (targetDir === '/' || !targetDir ? `/${file.name}` : `${targetDir}/${file.name}`);
}
