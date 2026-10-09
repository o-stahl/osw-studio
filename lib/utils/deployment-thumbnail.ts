/**
 * Deployment Thumbnail Capture Utility
 * Captures a screenshot of a published deployment via a hidden iframe.
 * Returns a base64 data URL -- caller is responsible for persisting.
 */

import { captureIframeScreenshot } from './screenshot';

export interface DeploymentCaptureOptions {
  captureWidth?: number;
  captureHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
  quality?: number;
  timeout?: number;
}

const DEFAULTS: Required<DeploymentCaptureOptions> = {
  captureWidth: 1280,
  captureHeight: 720,
  outputWidth: 640,
  outputHeight: 360,
  quality: 0.8,
  timeout: 15000,
};

/**
 * Capture a screenshot of a published deployment URL.
 * @returns base64 data URL, or null on failure
 */
export async function captureDeploymentScreenshot(
  deploymentUrl: string,
  options: DeploymentCaptureOptions = {}
): Promise<string | null> {
  const opts = { ...DEFAULTS, ...options };

  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.top = '-10000px';
    iframe.style.left = '-10000px';
    iframe.style.width = `${opts.captureWidth}px`;
    iframe.style.height = `${opts.captureHeight}px`;
    iframe.style.border = 'none';
    iframe.src = deploymentUrl;

    let timeoutId: number | null = null;
    let resolved = false;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (iframe.parentElement) document.body.removeChild(iframe);
    };

    const done = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    timeoutId = window.setTimeout(() => done(null), opts.timeout);

    iframe.onload = async () => {
      try {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        timeoutId = window.setTimeout(() => done(null), 12000);

        const screenshot = await captureIframeScreenshot(
          iframe,
          opts.captureWidth,
          opts.captureHeight,
          opts.outputWidth,
          opts.outputHeight,
          opts.quality,
          false,
          true,
          2500
        );

        done(screenshot);
      } catch {
        done(null);
      }
    };

    iframe.onerror = () => done(null);
    document.body.appendChild(iframe);
  });
}
