import { getRuntimeConfig } from '@/lib/runtimes/registry';
import { replaceBlobUrlsWithPaths } from '@/lib/publishing/rewrite-asset-urls';
import { stripPreviewScripts } from '@/lib/preview/strip-preview-scripts';
import { withoutPlaceholders } from '@/lib/semantic-blocks/placeholder';
import type { VirtualFileSystem } from '@/lib/vfs';

interface StaticFile {
  path: string;                    // no leading slash
  content: string | ArrayBuffer;
}

export class TerminalRuntimeError extends Error {
  constructor(public runtime: string) {
    super(`Runtime "${runtime}" runs in a terminal and cannot be served as a static site.`);
    this.name = 'TerminalRuntimeError';
  }
}

/**
 * Compile a project to the static files a static host serves.
 * Mirrors the non-terminal branch of vfs.exportProjectAsZip.
 */
export async function compileStaticSite(
  vfs: VirtualFileSystem,
  projectId: string,
): Promise<{ files: StaticFile[]; runtime: string }> {
  const project = await vfs.getProject(projectId);
  const runtime = project?.settings?.runtime || 'handlebars';
  if (getRuntimeConfig(runtime).previewMode === 'terminal') {
    throw new TerminalRuntimeError(runtime);
  }

  const { VirtualServer } = await import('@/lib/preview/virtual-server');
  const server = new VirtualServer(vfs, projectId, { runtime: project?.settings?.runtime, minify: true });
  try {
    const compiledProject = await server.compileProject();

    // compileProject() rewrites internal asset references into instance-local
    // blob: URLs for the live preview. Build a reverse map so the export can
    // restore the real root-relative paths — otherwise the exported HTML/CSS
    // points at blob URLs from the machine that ran the export and fails to
    // load anywhere else.
    const blobUrlToPath = new Map<string, string>();
    for (const [filePath, blobUrl] of compiledProject.blobUrls) {
      blobUrlToPath.set(blobUrl, filePath);
    }

    const files: StaticFile[] = [];
    for (const file of compiledProject.files) {
      // Skip template files, data files, and template directories
      if (vfs.shouldExcludeFromExportPublic(file.path)) {
        continue;
      }

      let content = file.content;
      if (typeof content === 'string') {
        content = replaceBlobUrlsWithPaths(content, blobUrlToPath);
        // Strip the preview-only instrumentation (VFS interceptor, console capture)
        if (file.path.endsWith('.html')) {
          content = withoutPlaceholders(stripPreviewScripts(content));
        }
      }

      const zipPath = file.path.startsWith('/') ? file.path.slice(1) : file.path;
      files.push({ path: zipPath, content });
    }

    return { files, runtime };
  } finally {
    server.cleanupBlobUrls();
  }
}
