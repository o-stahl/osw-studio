import { createRepo, repoExists, commit, listFiles } from '@huggingface/hub';
import type { CommitOperation } from '@huggingface/hub';
import type { VirtualFileSystem } from '@/lib/vfs';
import { compileStaticSite } from '@/lib/publishing/compile-static-site';
import { buildSpaceReadme } from '@/lib/publishing/hf-space-readme';
import { injectAttributionFooter } from '@/lib/publishing/attribution-footer';
import { logger } from '@/lib/utils';
import type { Project } from '@/lib/vfs/types';

type SpaceRecord = NonNullable<NonNullable<Project['settings']>['hfSpace']>;

interface PublishOptions {
  accessToken: string;
  username: string;
  slug: string;
  isPrivate: boolean;
  description: string;
  includeFooter: boolean;
  mode: 'update' | 'new';
  /**
   * The paths the last publish to this Space wrote (`settings.hfSpace.publishedPaths`). Those the
   * project no longer builds are deleted; nothing else in the Space is, so files someone added to
   * it outside OSW Studio stay.
   */
  previouslyPublished?: string[];
}

export interface PublishProgress {
  phase: 'compiling' | 'creating' | 'uploading';
}

function toBlob(content: string | ArrayBuffer): Blob {
  return new Blob([content]);
}

/**
 * Deletes for what the last publish wrote and this one does not, limited to files still in the
 * Space: deleting one already gone could fail the whole commit. A dot path is never deleted
 * (publish never writes one). A Space that cannot be listed is published to without pruning.
 */
async function staleDeletes(
  repo: { type: 'space'; name: string },
  accessToken: string,
  previous: string[],
  current: Set<string>,
): Promise<CommitOperation[]> {
  const candidates = previous.filter((path) => !current.has(path) && !path.split('/')[0].startsWith('.'));
  if (candidates.length === 0) return [];
  const present = new Set<string>();
  try {
    for await (const entry of listFiles({ repo, recursive: true, accessToken })) {
      if (entry.type === 'file') present.add(entry.path);
    }
  } catch (error) {
    logger.warn('[HF Space] Could not list the Space, so nothing is removed this time:', error);
    return [];
  }
  return candidates.filter((path) => present.has(path)).map((path) => ({ operation: 'delete' as const, path }));
}

/** What the last publish wrote, when it went to this same Space: a different one shares none of its files. */
export function previouslyPublishedFor(record: SpaceRecord | undefined, repoId: string, mode: PublishOptions['mode']): string[] | undefined {
  return mode === 'update' && record?.repoId === repoId ? record.publishedPaths : undefined;
}

/** The project's record of a publish, kept so the next one knows what it may remove. */
export function spaceRecord(
  result: { repoId: string; url: string; publishedPaths: string[] },
  isPrivate: boolean,
  at: Date = new Date(),
): SpaceRecord {
  return { repoId: result.repoId, url: result.url, isPrivate, lastPublishedAt: at.toISOString(), publishedPaths: result.publishedPaths };
}

export async function publishToSpace(
  vfs: VirtualFileSystem,
  projectId: string,
  opts: PublishOptions,
  onProgress?: (p: PublishProgress) => void,
): Promise<{ repoId: string; url: string; publishedPaths: string[] }> {
  const repoId = `${opts.username}/${opts.slug}`;
  const repo = { type: 'space' as const, name: repoId };

  onProgress?.({ phase: 'compiling' });
  const { files } = await compileStaticSite(vfs, projectId); // throws TerminalRuntimeError

  const project = await vfs.getProject?.(projectId);
  const title = project?.name || opts.slug;

  const operations: CommitOperation[] = files.map((f) => {
    let content = f.content;
    if (opts.includeFooter && typeof content === 'string' && f.path.endsWith('.html')) {
      content = injectAttributionFooter(content);
    }
    return { operation: 'addOrUpdate', path: f.path, content: toBlob(content) };
  });
  operations.push({
    operation: 'addOrUpdate',
    path: 'README.md',
    content: toBlob(buildSpaceReadme({ title, shortDescription: opts.description })),
  });

  const publishedPaths = operations.map((op) => op.path);
  if (opts.mode === 'update' && opts.previouslyPublished?.length) {
    operations.push(...await staleDeletes(repo, opts.accessToken, opts.previouslyPublished, new Set(publishedPaths)));
  }

  if (opts.mode === 'new') {
    if (await repoExists({ repo, accessToken: opts.accessToken })) {
      throw new Error(`The name "${opts.slug}" is already taken. Pick a different name.`);
    }
    onProgress?.({ phase: 'creating' });
    await createRepo({ repo, private: opts.isPrivate, sdk: 'static', accessToken: opts.accessToken });
  }

  onProgress?.({ phase: 'uploading' });
  await commit({
    repo,
    title: 'Update from OSW Studio',
    operations,
    accessToken: opts.accessToken,
  });

  return { repoId, url: `https://huggingface.co/spaces/${repoId}`, publishedPaths };
}
