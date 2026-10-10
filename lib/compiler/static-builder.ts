/**
 * Static Deployment Builder
 *
 * Compiles projects from SQLite using VirtualServer (Handlebars rendering)
 * and writes compiled static files to public directory
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createServerAdapter, getWorkspaceAdapter } from '@/lib/vfs/adapters/server';
import { VirtualServer } from '@/lib/preview/virtual-server';
import { VirtualFile, FileTreeNode, Deployment, ProjectRuntime, PublishSettings } from '@/lib/vfs/types';
import { logger } from '@/lib/utils';
import { processHtml } from '@/lib/publishing/html-processor';
import { stripPreviewScripts } from '@/lib/preview/strip-preview-scripts';
import { collectBlobs, linkBlob, putBlob } from '@/lib/vfs/adapters/blob-store';
import { resolveWithin } from '@/lib/vfs/path-safety';
import { generateSitemap, generateRobotsTxt } from '@/lib/publishing/seo-generator';
import { extractBackendFeatures } from './backend-feature-extractor';
import { deploymentStaticDir } from './deployment-static-dir';
import { deploymentReviewDir } from './deployment-review-dir';
import { resolveDeploymentServing, replaceAssetPathsWithPrefix } from './deployment-paths';
import { appUrl, sitesOrigin } from '@/lib/web/site-origin';

export interface BuildResult {
  success: boolean;
  deploymentId: string;
  projectId: string;
  filesWritten: number;
  outputPath: string;
  error?: string;
}

type BuildAdapter =
  | Awaited<ReturnType<typeof createServerAdapter>>
  | ReturnType<typeof getWorkspaceAdapter>;

/** One output copy of the site. */
interface BuildTarget {
  /** What in-page absolute asset paths are rewritten to. Empty when served at a domain root. */
  pathPrefix: string;
  reviewWidget: boolean;
}

/** A file as it is written, after the target's transform. */
interface OutputFile {
  path: string;
  content: string | ArrayBuffer;
}

interface PreparedBuild {
  /**
   * Produce one target's files.
   *
   * Returns a new array of new objects on every call and never writes back to the compiled files,
   * because both targets transform the same compiled site: rewriting in place would leave the
   * second call prefixing asset paths that the first already prefixed and injecting the SEO and
   * script blocks a second time.
   */
  transform(target: BuildTarget): OutputFile[];
  /** Paths of the compiled HTML pages, for the sitemap. */
  htmlFiles: string[];
  publicTarget: BuildTarget;
  baseUrl: string;
  publishSettings: PublishSettings;
  cleanup(): void;
}

/**
 * Create a minimal VFS-like wrapper for server-side VirtualServer compilation
 * Only implements the methods that VirtualServer actually uses
 */
function createServerVfs(
  projectId: string,
  allFiles: VirtualFile[]
) {
  const generatedFiles = new Map<string, VirtualFile>();

  return {
    async getAllFilesAndDirectories(pid: string): Promise<VirtualFile[]> {
      if (pid !== projectId) throw new Error('Invalid project ID');
      return allFiles;
    },

    async listDirectory(pid: string, dirPath: string): Promise<VirtualFile[]> {
      if (pid !== projectId) throw new Error('Invalid project ID');
      if (dirPath === '/') return allFiles;
      return allFiles.filter(f => f.path.startsWith(dirPath));
    },

    async readFile(pid: string, filePath: string): Promise<VirtualFile> {
      if (pid !== projectId) throw new Error('Invalid project ID');
      const file = allFiles.find(f => f.path === filePath);
      if (!file) throw new Error(`File not found: ${filePath}`);
      return file;
    },

    async fileExists(pid: string, filePath: string): Promise<boolean> {
      if (pid !== projectId) throw new Error('Invalid project ID');
      return allFiles.some(f => f.path === filePath);
    },

    // Generated file methods used by VirtualServer during bundled runtime compilation
    clearGeneratedFiles(): void {
      generatedFiles.clear();
    },

    setGeneratedFile(path: string, content: string, mimeType: string): void {
      const now = new Date();
      generatedFiles.set(path, {
        id: `generated-${path}`,
        projectId,
        path,
        name: path.split('/').pop() || path,
        type: path.endsWith('.css') ? 'css' : 'js',
        content,
        mimeType,
        size: content.length,
        createdAt: now,
        updatedAt: now,
        metadata: { isGenerated: true },
      });
    },

    getGeneratedFiles(): VirtualFile[] {
      return Array.from(generatedFiles.values());
    },

    isGeneratedPath(path: string): boolean {
      return generatedFiles.has(path);
    },
  };
}

/**
 * The publish-time view of a deployment's settings, shared by the HTML processor, the sitemap and
 * robots.txt so the three cannot describe the same deployment differently.
 */
function toPublishSettings(deployment: Deployment): PublishSettings {
  return {
    underConstruction: deployment.underConstruction,
    customDomain: deployment.customDomain,
    headScripts: deployment.headScripts,
    bodyScripts: deployment.bodyScripts,
    cdnLinks: deployment.cdnLinks,
    analytics: deployment.analytics,
    seo: deployment.seo,
    compliance: deployment.compliance,
    settingsVersion: deployment.settingsVersion,
    lastPublishedVersion: deployment.lastPublishedVersion,
  };
}

/**
 * Compile the project once and hand back a transform that can render it for any number of targets.
 */
async function prepareBuild(
  adapter: BuildAdapter,
  deployment: Deployment,
  deploymentId: string,
  runtime: ProjectRuntime | undefined
): Promise<PreparedBuild> {
  const allFiles = await adapter.listFiles(deployment.projectId);

  // Create a minimal VFS-like wrapper for server-side compilation
  const serverVfs = createServerVfs(deployment.projectId, allFiles);

  // Check if project has edge functions (for conditional interceptor injection)
  const edgeFunctions = adapter.listEdgeFunctions
    ? await adapter.listEdgeFunctions(deployment.projectId)
    : [];
  const hasEdgeFunctions = edgeFunctions.some(f => f.enabled);

  // Compile project using VirtualServer (renders Handlebars templates)
  const server = new VirtualServer(serverVfs as any, deployment.projectId, { runtime, minify: true });
  const compiledProject = await server.compileProject();

  // Create reverse map: blobUrl -> filePath for replacements
  const blobUrlToPath = new Map<string, string>();
  for (const [filePath, blobUrl] of compiledProject.blobUrls) {
    blobUrlToPath.set(blobUrl, filePath);
  }

  // Decide how the deployment is served — controls asset path style and SEO URLs.
  const { servedAtRoot, baseUrl } = resolveDeploymentServing(deployment, deploymentId, {
    staticProxyEnabled: process.env.STATIC_PROXY === 'true',
    appUrl: appUrl(),
    sitesOrigin: sitesOrigin(),
  });

  const publishSettings = toPublishSettings(deployment);

  return {
    publicTarget: {
      pathPrefix: servedAtRoot ? '' : `/deployments/${deploymentId}`,
      reviewWidget: false,
    },
    baseUrl,
    publishSettings,
    htmlFiles: compiledProject.files
      .filter(file => typeof file.content === 'string' && file.path.endsWith('.html'))
      .map(file => file.path),

    transform(target: BuildTarget): OutputFile[] {
      return compiledProject.files.map((file) => {
        // Binary content passes through untouched, so the target only borrows the reference.
        if (typeof file.content !== 'string') {
          return { path: file.path, content: file.content };
        }

        // Replace both blob URLs and file path references with absolute paths
        let content = replaceAssetPathsWithPrefix(file.content, blobUrlToPath, target.pathPrefix);

        if (file.path.endsWith('.html')) {
          // Remove preview instrumentation scripts from HTML files
          content = stripPreviewScripts(content);

          // Apply deployment settings to HTML files
          content = processHtml(content, {
            publishSettings,
            projectId: deployment.projectId,
            baseUrl,
            deploymentId,
            hasEdgeFunctions,
            reviewWidget: target.reviewWidget,
          });
        }

        return { path: file.path, content };
      });
    },

    cleanup: () => server.cleanupBlobUrls(),
  };
}

/**
 * Build a static deployment from a deployment entity
 * Uses VirtualServer to compile Handlebars templates (same as export)
 */
export async function buildStaticDeployment(deploymentId: string, workspaceId?: string): Promise<BuildResult> {
  try {
    const adapter = workspaceId ? getWorkspaceAdapter(workspaceId) : await createServerAdapter();
    await adapter.init();

    // Get deployment
    const deployment = await adapter.getDeployment?.(deploymentId);
    if (!deployment) {
      logger.error(`[Static Builder] Deployment ${deploymentId} not found in database`);
      return {
        success: false,
        deploymentId,
        projectId: '',
        filesWritten: 0,
        outputPath: '',
        error: 'Deployment not found',
      };
    }

    // Get project
    const project = await adapter.getProject(deployment.projectId);
    if (!project) {
      logger.error(`[Static Builder] Project ${deployment.projectId} not found in database`);
      return {
        success: false,
        deploymentId,
        projectId: deployment.projectId,
        filesWritten: 0,
        outputPath: '',
        error: 'Project not found',
      };
    }

    const outputDir = deploymentStaticDir(deploymentId);
    const reviewDir = deploymentReviewDir(deploymentId);
    const reviewEnabled = deployment.review?.enabled === true;
    const reviewTarget: BuildTarget = {
      pathPrefix: `/review/${deploymentId}`,
      reviewWidget: true,
    };

    // Undefined for an adapter with nothing on disk, which falls back to writing the bytes.
    const blobBaseDir = adapter.getBaseDir?.();
    let copiedInsteadOfLinked = 0;

    /** Write one target's files into a freshly cleared directory. */
    const writeTarget = async (targetDir: string, files: OutputFile[]): Promise<number> => {
      // `force` covers the first build, where there is nothing to remove.
      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.mkdir(targetDir, { recursive: true });

      let written = 0;
      for (const file of files) {
        // Skip template files and development files (same as export)
        if (shouldExcludeFromExport(file.path)) {
          continue;
        }

        // A file path comes from whoever pushed the project, so joining it onto the output
        // directory is not enough on its own: `/assets/../../../x` resolves outside it and writes
        // wherever the server process can reach. Anything that would land outside is dropped
        // rather than written.
        const filePath = resolveWithin(targetDir, file.path);
        if (!filePath) {
          logger.warn(`[Static Builder] Skipped file with unsafe path: ${file.path.slice(0, 120)}`);
          continue;
        }

        // Create directory if needed
        await fs.mkdir(path.dirname(filePath), { recursive: true });

        // Text is transformed on the way out (asset paths rewritten, preview scripts stripped, SEO
        // injected), so it is written. Binary content passes through untouched, so it is linked to
        // the blob the project already holds: the deployment gets a directory entry rather than a
        // second copy of every image. Copying is the fallback when there is no store to link from.
        if (typeof file.content === 'string') {
          await fs.writeFile(filePath, file.content, 'utf-8');
        } else if (blobBaseDir) {
          const hash = putBlob(blobBaseDir, Buffer.from(file.content));
          if (!linkBlob(blobBaseDir, hash, filePath)) copiedInsteadOfLinked += 1;
        } else {
          await fs.writeFile(filePath, Buffer.from(file.content));
        }

        written++;
      }
      return written;
    };

    // The project is compiled once and rendered per target. Under construction needs nothing
    // compiled for its own output, so it only pays for a compile when a review build is wanted —
    // which also keeps a project that fails to compile publishable as "under construction".
    const build = deployment.underConstruction && !reviewEnabled
      ? null
      : await prepareBuild(adapter, deployment, deploymentId, project.settings?.runtime);

    // A review build is gated on a password and an expiry, so it lives outside the web root. When
    // review mode is off the directory goes, rather than being left serving a stale copy.
    const writeReviewBuild = async () => {
      if (build && reviewEnabled) {
        await writeTarget(reviewDir, build.transform(reviewTarget));
      } else {
        await fs.rm(reviewDir, { recursive: true, force: true });
      }
    };

    // Check if under construction - if so, replace entire deployment with construction page
    if (deployment.underConstruction) {
      // Clean existing output directory
      await fs.rm(outputDir, { recursive: true, force: true });

      // Create output directory
      await fs.mkdir(outputDir, { recursive: true });

      // Generate and write under construction page as index.html
      const constructionHtml = generateUnderConstructionHtml(deployment.name);
      await fs.writeFile(path.join(outputDir, 'index.html'), constructionHtml, 'utf-8');

      // The construction page replaces what the public sees, not what a reviewer does: a
      // pre-launch site is the case review mode exists for, so the review build is still the site.
      await writeReviewBuild();
      build?.cleanup();

      logger.info(`[Static Builder] Built under construction page for deployment ${deploymentId}`);

      return {
        success: true,
        deploymentId,
        projectId: deployment.projectId,
        filesWritten: 1,
        outputPath: `/deployments/${deploymentId}`,
      };
    }

    const { htmlFiles, baseUrl, publishSettings } = build!;

    let filesWritten = await writeTarget(outputDir, build!.transform(build!.publicTarget));
    await writeReviewBuild();

    // Generate and write sitemap.xml if htmlFiles exist
    if (htmlFiles.length > 0) {
      const sitemapContent = generateSitemap({ baseUrl, htmlFiles, publishSettings });
      await fs.writeFile(path.join(outputDir, 'sitemap.xml'), sitemapContent, 'utf-8');
      filesWritten++;
    }

    // Generate and write robots.txt
    const robotsContent = generateRobotsTxt({ baseUrl, publishSettings });
    await fs.writeFile(path.join(outputDir, 'robots.txt'), robotsContent, 'utf-8');
    filesWritten++;

    // Extract backend features from project → deployment runtime database
    const extractionResult = await extractBackendFeatures(deployment.projectId, deploymentId, workspaceId);
    if (extractionResult.errors.length > 0) {
      logger.warn('[Static Builder] Backend feature extraction warnings:', extractionResult.errors);
    }
    if (extractionResult.edgeFunctions > 0 || extractionResult.serverFunctions > 0 ||
        extractionResult.secrets > 0 || extractionResult.scheduledFunctions > 0) {
      logger.info(`[Static Builder] Backend features provisioned: ${extractionResult.edgeFunctions} edge functions, ${extractionResult.serverFunctions} server functions, ${extractionResult.secrets} secrets, ${extractionResult.scheduledFunctions} scheduled functions`);
    }

    // Update lastPublishedVersion after successful build
    if (adapter.updateDeployment) {
      await adapter.updateDeployment({
        ...deployment,
        lastPublishedVersion: deployment.settingsVersion,
        publishedAt: new Date(),
      });
    }

    // Clean up VirtualServer resources
    build!.cleanup();

    // The previous build's directory was cleared before this one was written, so blobs it alone
    // was keeping alive are now unreferenced. Sweeping here rather than on a timer keeps the
    // store bounded by what is actually published, and the sweep skips anything still linked, so
    // a deployment serving an older version of a replaced file is untouched.
    if (blobBaseDir && adapter.listReferencedBlobHashes) {
      const referenced = new Set(await adapter.listReferencedBlobHashes());
      const removed = collectBlobs(blobBaseDir, referenced);
      if (removed > 0) {
        logger.debug(`[Static Builder] Removed ${removed} unreferenced blob(s)`);
      }
      if (copiedInsteadOfLinked > 0) {
        logger.warn(
          `[Static Builder] Copied ${copiedInsteadOfLinked} file(s) instead of linking them. ` +
          'The deployment output and the data directory are on different filesystems, so each ' +
          'published copy costs its own storage.'
        );
      }
    }

    logger.info(`[Static Builder] Build complete: ${filesWritten} files written to /deployments/${deploymentId}`);

    return {
      success: true,
      deploymentId,
      projectId: deployment.projectId,
      filesWritten,
      outputPath: `/deployments/${deploymentId}`,
    };
  } catch (error) {
    logger.error('[Static Builder] Build failed:', error);
    return {
      success: false,
      deploymentId: deploymentId || '',
      projectId: '',
      filesWritten: 0,
      outputPath: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Clean up static files for a deployment
 */
export async function cleanStaticDeployment(deploymentId: string): Promise<boolean> {
  try {
    // Both copies of the site go: the review build is a full second copy of the same pages, and
    // leaving it behind would keep a commentable version of an unpublished site fetchable.
    await fs.rm(deploymentStaticDir(deploymentId), { recursive: true, force: true });
    await fs.rm(deploymentReviewDir(deploymentId), { recursive: true, force: true });
    return true;
  } catch (error) {
    logger.error('[Static Builder] Error cleaning deployment:', error);
    return false;
  }
}

/**
 * Check if a file should be excluded from published deployment output
 */
function shouldExcludeFromExport(filePath: string): boolean {
  // Exclude template files
  if (filePath.endsWith('.hbs') || filePath.endsWith('.handlebars')) {
    return true;
  }

  // Exclude templates directory
  if (filePath.startsWith('/templates/')) {
    return true;
  }

  // Exclude data.json file (since it's compiled into HTML)
  if (filePath === '/data.json') {
    return true;
  }

  // Exclude TypeScript/JSX/SFC source files (compiled into bundle.js)
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ||
      filePath.endsWith('.svelte') || filePath.endsWith('.vue')) {
    return true;
  }

  // Exclude CSS source files under src/ (compiled into bundle.css by esbuild)
  if (filePath.startsWith('/src/') && filePath.endsWith('.css')) {
    return true;
  }

  // Exclude dot-prefixed files and directories (e.g. .PROMPT.md, .DESIGN.md, .skills/)
  const firstSegment = filePath.split('/').filter(Boolean)[0];
  if (firstSegment && firstSegment.startsWith('.')) {
    return true;
  }

  return false;
}

/**
 * Generate under construction HTML page
 */
function generateUnderConstructionHtml(projectName?: string): string {
  const escapedName = projectName ? escapeHtml(projectName) : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Under Construction${projectName ? ` - ${escapedName}` : ''}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Helvetica Neue', sans-serif;
      background: #0a0a0a;
      color: #ffffff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      animation: fadeIn 0.6s ease-in;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .container {
      text-align: center;
      max-width: 600px;
    }

    .logo-container {
      margin-bottom: 40px;
      animation: float 3s ease-in-out infinite;
    }

    @keyframes float {
      0%, 100% { transform: translateY(0px); }
      50% { transform: translateY(-10px); }
    }

    .logo {
      width: 120px;
      height: 120px;
      margin: 0 auto;
    }

    h1 {
      font-size: 36px;
      font-weight: 600;
      margin-bottom: 16px;
      letter-spacing: -0.5px;
    }

    .project-name {
      font-size: 20px;
      font-weight: 500;
      margin-bottom: 24px;
      color: #a1a1aa;
    }

    .message {
      font-size: 16px;
      line-height: 1.6;
      color: #71717a;
      margin-bottom: 12px;
    }

    .footer {
      margin-top: 60px;
      padding-top: 24px;
      border-top: 1px solid #27272a;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      font-size: 14px;
      color: #52525b;
    }

    .footer-logo {
      width: 20px;
      height: 20px;
      opacity: 0.8;
    }

    @media (max-width: 600px) {
      .logo {
        width: 80px;
        height: 80px;
      }
      h1 { font-size: 28px; }
      .project-name { font-size: 18px; }
      .message { font-size: 15px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo-container">
      <svg class="logo" version="1.0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" preserveAspectRatio="xMidYMid meet">
        <rect x="0" y="0" width="256" height="256" rx="20" ry="20" fill="#000000"/>
        <g transform="translate(0,256) scale(0.0476,-0.0476)" fill="#ffffff" stroke="none">
          <path d="M725 4825 c-50 -18 -100 -71 -114 -122 -15 -54 -15 -1573 0 -1628 16 -55 44 -92 89 -115 38 -19 62 -20 855 -20 781 0 817 1 853 19 46 23 67 46 87 94 13 32 15 138 15 830 0 566 -3 804 -11 828 -16 45 -55 87 -104 110 -38 18 -82 19 -835 18 -659 0 -802 -2 -835 -14z m1351 -371 c15 -11 37 -33 48 -48 21 -27 21 -38 21 -520 0 -547 3 -523 -68 -566 -31 -19 -54 -20 -521 -20 -483 0 -489 0 -524 22 -20 12 -42 38 -53 62 -17 38 -19 74 -19 504 0 496 1 503 51 548 46 41 66 43 561 41 464 -2 477 -3 504 -23z"/>
          <path d="M3058 4830 c-44 -13 -87 -49 -108 -90 -19 -37 -20 -61 -20 -471 0 -428 0 -432 22 -471 13 -22 41 -51 64 -64 41 -24 41 -24 685 -24 645 0 645 0 689 -22 63 -33 80 -71 80 -183 0 -101 -15 -144 -63 -179 -28 -21 -41 -21 -695 -26 -666 -5 -667 -5 -702 -27 -109 -68 -106 -247 5 -310 40 -23 40 -23 858 -23 664 0 824 3 850 14 43 17 95 78 102 118 3 18 5 225 3 459 -3 426 -3 426 -31 462 -58 76 -15 71 -757 77 -620 5 -667 6 -692 23 -44 30 -58 74 -58 179 0 116 16 153 80 186 44 22 44 22 693 22 710 0 678 -3 731 60 80 96 41 240 -79 287 -35 14 -1612 17 -1657 3z"/>
          <path d="M702 2509 c-48 -24 -75 -57 -91 -114 -9 -29 -11 -253 -9 -840 3 -779 4 -801 23 -834 11 -19 37 -48 58 -65 39 -31 39 -31 380 -31 342 0 342 0 399 28 31 15 63 39 73 53 16 25 16 25 62 -16 77 -67 104 -71 470 -68 320 3 320 3 360 30 24 16 49 44 62 70 21 44 21 49 21 854 0 773 -1 811 -19 851 -35 76 -135 120 -215 93 -41 -13 -90 -51 -109 -84 -9 -16 -13 -187 -17 -688 -5 -654 -5 -667 -26 -694 -43 -58 -68 -69 -169 -72 -82 -3 -99 -1 -133 18 -22 12 -49 39 -61 60 -21 37 -21 45 -21 664 0 439 -3 641 -11 673 -32 123 -190 174 -285 91 -73 -64 -69 -20 -70 -743 0 -721 3 -687 -66 -737 -28 -20 -47 -23 -133 -26 -91 -3 -103 -2 -134 20 -19 13 -44 36 -55 51 -21 28 -21 38 -26 695 -4 481 -8 673 -17 687 -50 87 -152 118 -241 74z"/>
          <path d="M3047 2515 c-47 -16 -81 -46 -101 -90 -14 -28 -16 -95 -16 -463 0 -281 4 -440 11 -459 15 -40 48 -73 94 -94 38 -17 79 -19 685 -19 626 0 646 -1 678 -20 58 -35 72 -72 72 -185 0 -110 -14 -147 -67 -182 -25 -17 -73 -18 -698 -23 -672 -5 -672 -5 -708 -33 -20 -15 -44 -42 -53 -60 -21 -39 -21 -125 -1 -163 20 -38 65 -80 100 -93 19 -8 289 -11 833 -11 701 0 809 2 841 15 48 20 71 41 94 88 19 35 19 60 17 480 -3 444 -3 444 -30 479 -54 71 -23 68 -740 68 -612 0 -645 1 -685 20 -67 30 -83 66 -83 183 0 116 14 156 68 189 35 21 35 21 691 22 606 1 658 2 688 19 137 74 130 264 -12 328 -38 18 -85 19 -840 18 -652 0 -807 -2 -838 -14z"/>
        </g>
      </svg>
    </div>

    <h1>Under Construction</h1>
    ${projectName ? `<div class="project-name">${escapedName}</div>` : ''}
    <p class="message">This site is currently being updated and improved.</p>
    <p class="message">Please check back soon!</p>

    <div class="footer">
      <span>Powered by</span>
      <svg class="footer-logo" version="1.0" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" preserveAspectRatio="xMidYMid meet">
        <rect x="0" y="0" width="256" height="256" rx="20" ry="20" fill="#52525b"/>
        <g transform="translate(0,256) scale(0.0476,-0.0476)" fill="#ffffff" stroke="none">
          <path d="M725 4825 c-50 -18 -100 -71 -114 -122 -15 -54 -15 -1573 0 -1628 16 -55 44 -92 89 -115 38 -19 62 -20 855 -20 781 0 817 1 853 19 46 23 67 46 87 94 13 32 15 138 15 830 0 566 -3 804 -11 828 -16 45 -55 87 -104 110 -38 18 -82 19 -835 18 -659 0 -802 -2 -835 -14z m1351 -371 c15 -11 37 -33 48 -48 21 -27 21 -38 21 -520 0 -547 3 -523 -68 -566 -31 -19 -54 -20 -521 -20 -483 0 -489 0 -524 22 -20 12 -42 38 -53 62 -17 38 -19 74 -19 504 0 496 1 503 51 548 46 41 66 43 561 41 464 -2 477 -3 504 -23z"/>
          <path d="M3058 4830 c-44 -13 -87 -49 -108 -90 -19 -37 -20 -61 -20 -471 0 -428 0 -432 22 -471 13 -22 41 -51 64 -64 41 -24 41 -24 685 -24 645 0 645 0 689 -22 63 -33 80 -71 80 -183 0 -101 -15 -144 -63 -179 -28 -21 -41 -21 -695 -26 -666 -5 -667 -5 -702 -27 -109 -68 -106 -247 5 -310 40 -23 40 -23 858 -23 664 0 824 3 850 14 43 17 95 78 102 118 3 18 5 225 3 459 -3 426 -3 426 -31 462 -58 76 -15 71 -757 77 -620 5 -667 6 -692 23 -44 30 -58 74 -58 179 0 116 16 153 80 186 44 22 44 22 693 22 710 0 678 -3 731 60 80 96 41 240 -79 287 -35 14 -1612 17 -1657 3z"/>
          <path d="M702 2509 c-48 -24 -75 -57 -91 -114 -9 -29 -11 -253 -9 -840 3 -779 4 -801 23 -834 11 -19 37 -48 58 -65 39 -31 39 -31 380 -31 342 0 342 0 399 28 31 15 63 39 73 53 16 25 16 25 62 -16 77 -67 104 -71 470 -68 320 3 320 3 360 30 24 16 49 44 62 70 21 44 21 49 21 854 0 773 -1 811 -19 851 -35 76 -135 120 -215 93 -41 -13 -90 -51 -109 -84 -9 -16 -13 -187 -17 -688 -5 -654 -5 -667 -26 -694 -43 -58 -68 -69 -169 -72 -82 -3 -99 -1 -133 18 -22 12 -49 39 -61 60 -21 37 -21 45 -21 664 0 439 -3 641 -11 673 -32 123 -190 174 -285 91 -73 -64 -69 -20 -70 -743 0 -721 3 -687 -66 -737 -28 -20 -47 -23 -133 -26 -91 -3 -103 -2 -134 20 -19 13 -44 36 -55 51 -21 28 -21 38 -26 695 -4 481 -8 673 -17 687 -50 87 -152 118 -241 74z"/>
          <path d="M3047 2515 c-47 -16 -81 -46 -101 -90 -14 -28 -16 -95 -16 -463 0 -281 4 -440 11 -459 15 -40 48 -73 94 -94 38 -17 79 -19 685 -19 626 0 646 -1 678 -20 58 -35 72 -72 72 -185 0 -110 -14 -147 -67 -182 -25 -17 -73 -18 -698 -23 -672 -5 -672 -5 -708 -33 -20 -15 -44 -42 -53 -60 -21 -39 -21 -125 -1 -163 20 -38 65 -80 100 -93 19 -8 289 -11 833 -11 701 0 809 2 841 15 48 20 71 41 94 88 19 35 19 60 17 480 -3 444 -3 444 -30 479 -54 71 -23 68 -740 68 -612 0 -645 1 -685 20 -67 30 -83 66 -83 183 0 116 14 156 68 189 35 21 35 21 691 22 606 1 658 2 688 19 137 74 130 264 -12 328 -38 18 -85 19 -840 18 -652 0 -807 -2 -838 -14z"/>
        </g>
      </svg>
      <span>OSW Studio</span>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

