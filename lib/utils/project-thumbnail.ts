/**
 * Project Thumbnail Capture Utility
 * Compiles a project via VirtualServer, renders in a hidden iframe,
 * and captures a screenshot. Returns base64 data URL.
 */

import { vfs } from '@/lib/vfs';
import { VirtualServer } from '@/lib/preview/virtual-server';
import { captureIframeScreenshot } from './screenshot';
import { injectVfsBlobMap } from '@/lib/preview/inject-vfs-blob-map';
import { previewBridgeScript } from '@/lib/preview/preview-bridge';

export async function captureProjectScreenshot(projectId: string): Promise<string | null> {
  await vfs.init();

  const project = await vfs.getProject(projectId);
  const server = new VirtualServer(vfs, projectId, { runtime: project?.settings?.runtime });
  let compiled;
  try {
    compiled = await server.compileProject();
  } catch {
    server.cleanupBlobUrls();
    return null;
  }

  const indexFile = compiled.files.find(f => f.path === '/index.html');
  if (!indexFile) {
    server.cleanupBlobUrls();
    return null;
  }

  let html = typeof indexFile.content === 'string'
    ? indexFile.content
    : new TextDecoder().decode(indexFile.content as ArrayBuffer);

  // Replace CSS href with blob URLs
  html = html.replace(/href="([^"]+\.css)"/g, (match, href) => {
    if (href.startsWith('http') || href.startsWith('//')) return match;
    const path = href.startsWith('/') ? href : '/' + href;
    const blobUrl = compiled.blobUrls.get(path);
    return blobUrl ? `href="${blobUrl}"` : match;
  });

  // Replace JS src with blob URLs
  html = html.replace(/src="([^"]+\.js)"/g, (match, src) => {
    if (src.startsWith('http') || src.startsWith('//')) return match;
    const path = src.startsWith('/') ? src : '/' + src;
    const blobUrl = compiled.blobUrls.get(path);
    return blobUrl ? `src="${blobUrl}"` : match;
  });

  // Replace image src with blob URLs
  html = html.replace(/src="([^"]+\.(png|jpg|jpeg|gif|svg|webp))"/gi, (match, imgPath) => {
    const path = imgPath.startsWith('/') ? imgPath : '/' + imgPath;
    const blobUrl = compiled.blobUrls.get(path);
    return blobUrl ? `src="${blobUrl}"` : match;
  });

  // The rewrites above cover the references present in the markup; this covers the ones the page
  // asks for while it renders.
  html = injectVfsBlobMap(html, compiled.blobUrls);
  // The frame paints itself on request (`captureIframeScreenshot`), through the same bridge the
  // live preview carries.
  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (head) => head + previewBridgeScript(0))
    : previewBridgeScript(0) + html;

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.top = '-10000px';
  iframe.style.left = '-10000px';
  iframe.style.width = '1280px';
  iframe.style.height = '720px';
  iframe.style.border = 'none';

  document.body.appendChild(iframe);

  try {
    await new Promise<void>((resolve) => {
      iframe.onload = () => resolve();
      iframe.srcdoc = html;
    });

    // Let the page render
    await new Promise(r => setTimeout(r, 1500));

    return await captureIframeScreenshot(iframe, 1280, 720, 640, 360, 0.8, false);
  } finally {
    if (iframe.parentElement) document.body.removeChild(iframe);
    server.cleanupBlobUrls();
  }
}
