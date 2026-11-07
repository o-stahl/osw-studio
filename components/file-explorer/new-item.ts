import type { VirtualFileSystem } from '@/lib/vfs';
import { logger } from '@/lib/utils';

/** What New File and New Folder make. */
export type NewItemKind = 'file' | 'directory';

/**
 * Why a new file or folder was not made: a name that is not one name (a slash in it, or `.` or
 * `..`), a name something in that folder already has, or a write that failed.
 */
export type NewItemProblem = 'invalid' | 'exists' | 'failed';

/** Whether `name` names one item: no slash of either kind, and not `.` or `..`. */
export function newItemNameProblem(name: string): 'invalid' | null {
  return /[\\/]/.test(name) || name === '.' || name === '..' ? 'invalid' : null;
}

type ItemStore = Pick<VirtualFileSystem, 'init' | 'getAllFilesAndDirectories' | 'createFile' | 'createDirectory'>;

/**
 * Make a new file or folder called `name` in `parentPath`: null once it exists, or what stopped it.
 * A name taken by either kind is refused here, from the project's own list, since the VFS refuses
 * only a file over a file, and `createDirectory` does nothing over an existing folder.
 */
export async function createNewItem(
  store: ItemStore,
  projectId: string,
  kind: NewItemKind,
  parentPath: string,
  name: string,
): Promise<NewItemProblem | null> {
  const trimmed = name.trim();
  if (!trimmed || newItemNameProblem(trimmed)) return 'invalid';
  const path = parentPath === '/' ? `/${trimmed}` : `${parentPath}/${trimmed}`;
  try {
    await store.init();
    const items = await store.getAllFilesAndDirectories(projectId);
    if (items.some((item) => item.path === path)) return 'exists';
    if (kind === 'file') await store.createFile(projectId, path, '');
    else await store.createDirectory(projectId, path);
    return null;
  } catch (error) {
    logger.error(`Failed to create ${kind}:`, error);
    return 'failed';
  }
}
