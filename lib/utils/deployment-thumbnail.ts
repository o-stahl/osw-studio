/**
 * Screenshots of a published page, for deployment thumbnails and the heatmap.
 *
 * The page runs code the studio does not control, so it is not loaded in a frame the studio can read,
 * whether the site shares the studio's origin or lives elsewhere (lib/web/site-origin.ts).
 * Instead the page's HTML comes from the build (`/api/deployment-pages/{id}`), gets a `<base>` at
 * the site's own URL so its assets load from there, and is rendered in a sandboxed shell, the same
 * as the editor preview (lib/preview/preview-shell.ts). The frame paints itself on request.
 *
 * Returns a JPEG data URL, or null. The caller persists it.
 */

import { captureIframeScreenshot } from './screenshot';
import { apiFetch } from '@/lib/api/backend-status';
import { prependToHead, previewBridgeScript } from '@/lib/preview/preview-bridge';
import { loadIntoShell } from '@/lib/preview/preview-shell';

export interface DeploymentCaptureOptions {
  /** The page as a visitor addresses it. Defaults to the site's home page. */
  pagePath?: string;
  captureWidth?: number;
  captureHeight?: number;
  outputWidth?: number;
  quality?: number;
  fullPage?: boolean;
}

const DEFAULTS = {
  pagePath: '/',
  captureWidth: 1280,
  captureHeight: 720,
  outputWidth: 640,
  quality: 0.8,
  fullPage: false,
};

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** The page's HTML with a `<base>` at its public URL and the preview bridge, first in `<head>`. */
export function pageForCapture(html: string, url: string): string {
  return prependToHead(html, `<base href="${escapeAttribute(url)}">${previewBridgeScript(0)}`);
}

export async function captureDeploymentPage(
  deploymentId: string,
  options: DeploymentCaptureOptions = {}
): Promise<string | null> {
  const opts = { ...DEFAULTS, ...options };
  let page: { html: string; url: string };
  try {
    const res = await apiFetch(`/api/deployment-pages/${encodeURIComponent(deploymentId)}?path=${encodeURIComponent(opts.pagePath)}`);
    if (!res.ok) return null;
    page = await res.json();
  } catch {
    return null;
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.position = 'fixed';
  iframe.style.top = '-10000px';
  iframe.style.left = '-10000px';
  iframe.style.width = `${opts.captureWidth}px`;
  iframe.style.height = `${opts.captureHeight}px`;
  iframe.style.border = 'none';
  document.body.appendChild(iframe);

  try {
    await loadIntoShell(iframe, pageForCapture(page.html, page.url), [], 15000);
    return await captureIframeScreenshot(
      iframe,
      opts.captureWidth,
      opts.captureHeight,
      opts.outputWidth,
      opts.quality,
      opts.fullPage,
      true,
      2500
    );
  } catch {
    return null;
  } finally {
    iframe.remove();
  }
}
