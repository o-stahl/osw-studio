// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The upload the file explorer has always performed, now that it is shared.
 *
 * These exist because of the *extraction*, not because the behaviour is new: `uploadFile` was a
 * closure inside `components/file-explorer/index.tsx`, which has no tests, and the preview toolbar's
 * image picker is now a second caller. What has to keep holding is what the explorer's callers
 * already depend on — the four outcome codes, the size gate, the text/bytes decision, and the
 * difference between `silent` (never prompt) and `quiet` (prompt, but say nothing).
 */

// Hoisted, because `vi.mock`'s factory runs before any top-level binding in this file exists.
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  promise: vi.fn(async (p: Promise<unknown>) => { await p; }),
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const createFile = vi.fn();
const deleteFile = vi.fn();
vi.mock('../index', () => ({
  vfs: {
    createFile: (...a: unknown[]) => createFile(...a),
    deleteFile: (...a: unknown[]) => deleteFile(...a),
  },
}));

const ensureAncestorDirs = vi.fn();
vi.mock('../archive/read-folder', () => ({
  ensureAncestorDirs: (...a: unknown[]) => ensureAncestorDirs(...a),
}));

import { uploadFileToProject, uploadTargetPath } from '../upload-file';
import { FILE_SIZE_LIMITS } from '../types';

/**
 * A `File` that can be read.
 *
 * jsdom's `File` implements neither `arrayBuffer()` nor `text()`, so an unpatched one makes every
 * upload return `'error'` — and, since the failure is caught and logged, it does so silently.
 */
function file(name: string, body = 'x'): File {
  const f = new File([body], name);
  Object.defineProperty(f, 'arrayBuffer', { value: async () => new TextEncoder().encode(body).buffer });
  Object.defineProperty(f, 'text', { value: async () => body });
  return f;
}

/** A `File` that reports a size without holding the bytes. */
function hugeFile(name: string, size: number): File {
  const f = file(name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

beforeEach(() => {
  vi.clearAllMocks();
  createFile.mockResolvedValue(undefined);
  deleteFile.mockResolvedValue(undefined);
  ensureAncestorDirs.mockResolvedValue(undefined);
});

describe('uploadFileToProject', () => {
  it('writes to targetDir and reloads', async () => {
    const onReload = vi.fn();

    expect(await uploadFileToProject('p1', file('a.png'), '/images', { onReload })).toBe('ok');

    expect(createFile).toHaveBeenCalledWith('p1', '/images/a.png', expect.anything());
    expect(ensureAncestorDirs).toHaveBeenCalledWith('p1', '/images/a.png');
    expect(onReload).toHaveBeenCalled();
  });

  it('writes to the root when there is no targetDir', async () => {
    await uploadFileToProject('p1', file('a.png'), undefined);
    expect(createFile).toHaveBeenCalledWith('p1', '/a.png', expect.anything());
  });

  it('an explicit path wins over the targetDir', async () => {
    await uploadFileToProject('p1', file('a.png'), '/images', { explicitPath: '/deep/nested/a.png' });
    expect(createFile).toHaveBeenCalledWith('p1', '/deep/nested/a.png', expect.anything());
  });

  it('keeps the bytes of anything not positively identified as text', async () => {
    // Reading an unrecognised file as text silently corrupts it, so the default is bytes.
    await uploadFileToProject('p1', file('a.png'), '/');
    // Not `toBeInstanceOf(ArrayBuffer)`: buffers cross realms in jsdom and the check fails on one
    // that is unmistakably an ArrayBuffer. "Not a string, and has bytes" is the property that
    // matters — a `.png` read as text is the corruption this branch exists to prevent.
    const written = createFile.mock.calls[0][2] as ArrayBuffer;
    expect(typeof written).not.toBe('string');
    expect(written.byteLength).toBe(1);

    createFile.mockClear();
    await uploadFileToProject('p1', file('notes.md', 'hello'), '/');
    expect(createFile.mock.calls[0][2]).toBe('hello');
  });

  it('refuses a file over the type limit without writing', async () => {
    expect(await uploadFileToProject('p1', hugeFile('a.png', 500 * 1024 * 1024), '/')).toBe('too-large');
    expect(createFile).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('takes the limit exactly: one byte over is refused, the limit itself is not', async () => {
    expect(await uploadFileToProject('p1', hugeFile('a.png', FILE_SIZE_LIMITS.image + 1), '/')).toBe('too-large');
    expect(createFile).not.toHaveBeenCalled();
    expect(await uploadFileToProject('p1', hugeFile('b.png', FILE_SIZE_LIMITS.image), '/')).toBe('ok');
  });

  it('skips the reload when the caller batches its own', async () => {
    const onReload = vi.fn();
    await uploadFileToProject('p1', file('a.png'), '/', { skipReload: true, onReload });
    expect(createFile).toHaveBeenCalled();
    expect(onReload).not.toHaveBeenCalled();
  });

  describe('a collision', () => {
    beforeEach(() => {
      createFile.mockRejectedValueOnce(new Error('File already exists: /a.png'));
    });

    it('overwrites when the prompt is accepted', async () => {
      vi.stubGlobal('confirm', vi.fn(() => true));

      expect(await uploadFileToProject('p1', file('a.png'), '/')).toBe('ok');

      expect(deleteFile).toHaveBeenCalledWith('p1', '/a.png');
      expect(createFile).toHaveBeenCalledTimes(2);
    });

    it('reports "cancelled", not "error", when the prompt is declined', async () => {
      // The distinction is the whole difference between "nothing happened because you said so" and
      // "nothing happened and nobody knows why"; the import dialog's copy depends on it.
      vi.stubGlobal('confirm', vi.fn(() => false));

      expect(await uploadFileToProject('p1', file('a.png'), '/')).toBe('cancelled');
      expect(deleteFile).not.toHaveBeenCalled();
    });

    it('never prompts when silent, and skips instead', async () => {
      const ask = vi.fn(() => true);
      vi.stubGlobal('confirm', ask);

      expect(await uploadFileToProject('p1', file('a.png'), '/', { silent: true })).toBe('error');
      expect(ask).not.toHaveBeenCalled();
    });

    it('still prompts when only quiet', async () => {
      // `quiet` suppresses the toasts, not the question: declining a prompt nobody saw is not a
      // refusal, and the folder upload is the only caller that wants silence to mean both.
      const ask = vi.fn(() => false);
      vi.stubGlobal('confirm', ask);

      expect(await uploadFileToProject('p1', file('a.png'), '/', { quiet: true })).toBe('cancelled');
      expect(ask).toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });
  });

  it('reports an error without a toast when quiet', async () => {
    createFile.mockRejectedValueOnce(new Error('storage is full'));

    expect(await uploadFileToProject('p1', file('a.png'), '/', { quiet: true })).toBe('error');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports an error with a toast otherwise', async () => {
    createFile.mockRejectedValueOnce(new Error('storage is full'));

    expect(await uploadFileToProject('p1', file('a.png'), '/')).toBe('error');
    expect(toast.error).toHaveBeenCalled();
  });
});

describe('uploadTargetPath', () => {
  it('answers with the path the upload will use', async () => {
    expect(uploadTargetPath(file('a.png'), '/images')).toBe('/images/a.png');
    expect(uploadTargetPath(file('a.png'), '/')).toBe('/a.png');
    expect(uploadTargetPath(file('a.png'), undefined)).toBe('/a.png');
    expect(uploadTargetPath(file('a.png'), '/images', '/other/b.png')).toBe('/other/b.png');

    // And it agrees with what the upload actually wrote — the reason it exists rather than the
    // picker re-deriving the rule.
    await uploadFileToProject('p1', file('a.png'), '/images');
    expect(createFile.mock.calls[0][1]).toBe(uploadTargetPath(file('a.png'), '/images'));
  });
});
