import type { VirtualFile } from './types';

/** Whether two copies of a file hold the same bytes. */
export function sameFileContent(a: string | ArrayBuffer | undefined | null, b: string | ArrayBuffer | undefined | null): boolean {
  if (a == null || b == null) return false;
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  return x.every((byte, i) => byte === y[i]);
}

/** Whether two copies of a project hold the same paths with the same content. */
export function sameFileSets(
  one: Array<Pick<VirtualFile, 'path' | 'content'>>,
  other: Array<Pick<VirtualFile, 'path' | 'content'>>,
): boolean {
  if (one.length !== other.length) return false;
  const byPath = new Map(one.map(file => [file.path, file.content]));
  return other.every(file => byPath.has(file.path) && sameFileContent(byPath.get(file.path), file.content));
}
