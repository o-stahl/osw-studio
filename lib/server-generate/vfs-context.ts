import { AsyncLocalStorage } from 'node:async_hooks';
import { registerContextVFSProvider } from '@/lib/vfs';
import type { VirtualFileSystem } from '@/lib/vfs';

const vfsStorage = new AsyncLocalStorage<VirtualFileSystem>();

export function runWithVFS<T>(vfs: VirtualFileSystem, fn: () => Promise<T>): Promise<T> {
  return vfsStorage.run(vfs, fn);
}

export function getContextVFS(): VirtualFileSystem | undefined {
  return vfsStorage.getStore();
}

registerContextVFSProvider(getContextVFS);
