import { logger } from '@/lib/utils';
import { requestFrameCapture } from '@/lib/preview/frame-capture';

/**
 * Capture a preview frame as a JPEG data URL, or null.
 *
 * The frame paints itself (`requestFrameCapture`, `lib/preview/frame-capture.ts`): the host cannot
 * read a preview document, since project code runs there. What comes back is the painted page, which
 * is scaled here to `outputWidth` and encoded.
 */
export async function captureIframeScreenshot(
  iframe: HTMLIFrameElement,
  captureWidth: number = 1280,
  captureHeight: number = 720,
  // The output height follows the captured aspect ratio.
  outputWidth: number = 640,
  quality: number = 0.8,
  fullPage: boolean = true,
  waitForContent: boolean = false,
  minWaitDelay: number = 1500
): Promise<string | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    // Resource wait, loading the painter, and painting.
    const timeoutMs = (waitForContent ? minWaitDelay + 8000 : 0) + 15000;
    bitmap = await requestFrameCapture(
      iframe,
      { captureWidth, captureHeight, fullPage, waitForContent, minWaitDelay },
      timeoutMs,
    );

    // Never wider than what was painted: a narrow frame gives a narrow, sharp image, not a
    // stretched one.
    const targetWidth = Math.min(outputWidth, bitmap.width);
    const scaledHeight = Math.round(targetWidth * (bitmap.height / bitmap.width));

    const scaledCanvas = document.createElement('canvas');
    scaledCanvas.width = targetWidth;
    scaledCanvas.height = scaledHeight;
    const ctx = scaledCanvas.getContext('2d');
    if (!ctx) {
      logger.error('Failed to get canvas context');
      return null;
    }
    ctx.drawImage(bitmap, 0, 0, targetWidth, scaledHeight);

    const dataUrl = scaledCanvas.toDataURL('image/jpeg', quality);
    const sizeInKB = Math.ceil((dataUrl.length * 3) / 4) / 1024;
    if (sizeInKB <= 250) return dataUrl;

    logger.warn(`Screenshot too large: ${sizeInKB.toFixed(0)}KB, trying with lower quality`);
    const retryDataUrl = scaledCanvas.toDataURL('image/jpeg', 0.6);
    const retrySizeInKB = Math.ceil((retryDataUrl.length * 3) / 4) / 1024;
    if (retrySizeInKB > 250) {
      logger.warn(`Screenshot still too large: ${retrySizeInKB.toFixed(0)}KB`);
    }
    return retryDataUrl; // let the VFS handle its own size limit
  } catch (error) {
    logger.error('Failed to capture screenshot:', error);
    return null;
  } finally {
    bitmap?.close();
  }
}
