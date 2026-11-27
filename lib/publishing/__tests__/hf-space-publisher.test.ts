import { describe, it, expect, vi, beforeEach } from 'vitest';

const hub = vi.hoisted(() => ({
  repoExists: vi.fn(),
  createRepo: vi.fn(),
  commit: vi.fn(),
  listFiles: vi.fn(),
}));
vi.mock('@huggingface/hub', () => hub);
vi.mock('@/lib/publishing/compile-static-site', () => ({
  compileStaticSite: vi.fn().mockResolvedValue({
    files: [{ path: 'index.html', content: '<body>hi</body>' }],
    runtime: 'static',
  }),
  TerminalRuntimeError: class extends Error {},
}));

import { previouslyPublishedFor, publishToSpace, spaceRecord } from '@/lib/publishing/hf-space-publisher';
import type { VirtualFileSystem } from '@/lib/vfs';

/** The compile is mocked, so the file system is never read. */
const noVfs = {} as VirtualFileSystem;
type Op = { operation: string; path: string; content?: Blob };

beforeEach(() => {
  hub.repoExists.mockReset();
  hub.createRepo.mockReset().mockResolvedValue({ repoUrl: 'x', id: 'alice/my-site' });
  hub.commit.mockReset().mockResolvedValue({ commit: { oid: 'abc', url: 'u' } });
  hub.listFiles.mockReset();
});

/** The Space's files, as listFiles yields them. */
function spaceHas(...paths: string[]) {
  hub.listFiles.mockImplementation(async function* () {
    for (const path of paths) yield { type: 'file', path };
    yield { type: 'directory', path: 'old' };
  });
}
const deletes = () => hub.commit.mock.calls[0][0].operations.filter((o: Op) => o.operation === 'delete').map((o: Op) => o.path);

const base = {
  accessToken: 'hf_x', username: 'alice', slug: 'my-site',
  isPrivate: false, description: 'd', includeFooter: true, mode: 'new' as const,
};

describe('publishToSpace', () => {
  it('creates a static Space under <username>/<slug> then commits files + README', async () => {
    hub.repoExists.mockResolvedValue(false);
    const res = await publishToSpace(noVfs, 'p1', base);
    expect(hub.createRepo).toHaveBeenCalledWith(expect.objectContaining({
      repo: { type: 'space', name: 'alice/my-site' }, sdk: 'static', private: false, accessToken: 'hf_x',
    }));
    const commitArg = hub.commit.mock.calls[0][0];
    expect(commitArg.repo).toEqual({ type: 'space', name: 'alice/my-site' });
    const paths = commitArg.operations.map((o: Op) => o.path);
    expect(paths).toContain('index.html');
    expect(paths).toContain('README.md');
    expect(commitArg.operations[0].content).toBeInstanceOf(Blob);
    const indexOp = commitArg.operations.find((o: Op) => o.path === 'index.html');
    const html = await indexOp.content.text();
    expect(html).toContain('data-osw-credit');
    expect(res).toEqual({ repoId: 'alice/my-site', url: 'https://huggingface.co/spaces/alice/my-site', publishedPaths: ['index.html', 'README.md'] });
  });

  it('injects the footer only when includeFooter is true', async () => {
    hub.repoExists.mockResolvedValue(false);
    await publishToSpace(noVfs, 'p1', { ...base, includeFooter: false });
    const op = hub.commit.mock.calls[0][0].operations.find((o: Op) => o.path === 'index.html');
    const text = await op.content.text();
    expect(text).not.toContain('data-osw-credit');
  });

  it('in update mode does not create, just commits', async () => {
    await publishToSpace(noVfs, 'p1', { ...base, mode: 'update' });
    expect(hub.createRepo).not.toHaveBeenCalled();
    expect(hub.commit).toHaveBeenCalled();
  });

  it('surfaces a name-taken error from createRepo', async () => {
    hub.repoExists.mockResolvedValue(true);
    await expect(publishToSpace(noVfs, 'p1', base)).rejects.toThrow(/taken|exists/i);
  });

  describe('removing what an earlier publish wrote', () => {
    const update = { ...base, mode: 'update' as const };

    it('deletes, in the same commit, a file it published last time that the project no longer has', async () => {
      spaceHas('index.html', 'README.md', 'old/page.html', '.gitattributes');
      await publishToSpace(noVfs, 'p1', { ...update, previouslyPublished: ['index.html', 'README.md', 'old/page.html'] });
      expect(hub.commit).toHaveBeenCalledTimes(1);
      expect(deletes()).toEqual(['old/page.html']);
    });

    it("leaves files it never published, which belong to whoever made the Space", async () => {
      spaceHas('index.html', 'README.md', 'their-notes.html', 'app.py');
      await publishToSpace(noVfs, 'p1', { ...update, previouslyPublished: ['index.html', 'README.md'] });
      expect(deletes()).toEqual([]);
    });

    it('prunes nothing without a record of what it published, as on the first publish after this change', async () => {
      spaceHas('index.html', 'README.md', 'old.html');
      await publishToSpace(noVfs, 'p1', update);
      expect(deletes()).toEqual([]);
      expect(hub.listFiles).not.toHaveBeenCalled();
    });

    it('never deletes a dot path, nor one already gone from the Space', async () => {
      spaceHas('index.html', 'README.md', '.github/x.yml');
      await publishToSpace(noVfs, 'p1', { ...update, previouslyPublished: ['.github/x.yml', 'gone.html'] });
      expect(deletes()).toEqual([]);
    });

    it('publishes without pruning when the Space cannot be listed', async () => {
      hub.listFiles.mockImplementation(async function* () { throw new Error('503'); });
      await publishToSpace(noVfs, 'p1', { ...update, previouslyPublished: ['old.html'] });
      expect(hub.commit).toHaveBeenCalledTimes(1);
      expect(deletes()).toEqual([]);
    });

    it('never prunes when creating a Space', async () => {
      hub.repoExists.mockResolvedValue(false);
      await publishToSpace(noVfs, 'p1', { ...base, previouslyPublished: ['old.html'] });
      expect(hub.listFiles).not.toHaveBeenCalled();
    });
  });
});

describe("the project's record of a publish", () => {
  const record = { repoId: 'alice/my-site', url: 'u', isPrivate: false, lastPublishedAt: 't', publishedPaths: ['index.html', 'old.html'] };

  it('passes on what the last publish wrote only when updating that same Space', () => {
    expect(previouslyPublishedFor(record, 'alice/my-site', 'update')).toEqual(['index.html', 'old.html']);
    expect(previouslyPublishedFor(record, 'alice/other', 'update')).toBeUndefined();
    expect(previouslyPublishedFor(record, 'alice/my-site', 'new')).toBeUndefined();
    expect(previouslyPublishedFor(undefined, 'alice/my-site', 'update')).toBeUndefined();
  });

  it('keeps what this publish wrote, for the next one', () => {
    const at = new Date('2026-11-27T12:00:00Z');
    expect(spaceRecord({ repoId: 'alice/my-site', url: 'https://huggingface.co/spaces/alice/my-site', publishedPaths: ['index.html', 'README.md'] }, true, at))
      .toEqual({ repoId: 'alice/my-site', url: 'https://huggingface.co/spaces/alice/my-site', isPrivate: true, lastPublishedAt: '2026-11-27T12:00:00.000Z', publishedPaths: ['index.html', 'README.md'] });
  });
});
