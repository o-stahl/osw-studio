// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The host's half of a preview screenshot: the frame paints itself and sends back a bitmap
 * (`requestFrameCapture`, covered in lib/preview/__tests__/frame-capture.test.ts); this scales it
 * and encodes it. The result is stored with the project, so its size matters: an image wider than
 * what was painted is a blurred one, a large one is retried at lower quality, and the bitmap's
 * memory is given back whatever happens.
 */

const mocks = vi.hoisted(() => ({ requestFrameCapture: vi.fn() }));
vi.mock('@/lib/preview/frame-capture', () => ({ requestFrameCapture: mocks.requestFrameCapture }));
vi.mock('@/lib/utils', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { captureIframeScreenshot } from '../screenshot';

/** Above the 250 KB the result aims for, once base64 is decoded. */
const LARGE = 'data:image/jpeg;base64,' + 'A'.repeat(400 * 1024);
const SMALL = 'data:image/jpeg;base64,AAAA';

let canvas: { width: number; height: number; getContext: ReturnType<typeof vi.fn>; toDataURL: ReturnType<typeof vi.fn> };
let drawImage: ReturnType<typeof vi.fn>;
const iframe = {} as HTMLIFrameElement;

function bitmap(width: number, height: number) {
  return { width, height, close: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  drawImage = vi.fn();
  canvas = { width: 0, height: 0, getContext: vi.fn(() => ({ drawImage })), toDataURL: vi.fn(() => SMALL) };
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
    tag === 'canvas' ? canvas : create(tag)) as typeof document.createElement);
});

describe('captureIframeScreenshot', () => {
  it('asks the frame for the page it was told to paint', async () => {
    mocks.requestFrameCapture.mockResolvedValue(bitmap(1280, 720));
    await captureIframeScreenshot(iframe, 1024, 600, 640, 0.8, false, true, 1000);
    expect(mocks.requestFrameCapture).toHaveBeenCalledWith(
      iframe,
      { captureWidth: 1024, captureHeight: 600, fullPage: false, waitForContent: true, minWaitDelay: 1000 },
      // The resource wait and the painting each get their own allowance.
      1000 + 8000 + 15000,
    );
  });

  it('scales the painted page to the output width, keeping its shape', async () => {
    const painted = bitmap(1280, 2000);
    mocks.requestFrameCapture.mockResolvedValue(painted);

    expect(await captureIframeScreenshot(iframe, 1280, 720, 640)).toBe(SMALL);

    expect([canvas.width, canvas.height]).toEqual([640, 1000]);
    expect(drawImage).toHaveBeenCalledWith(painted, 0, 0, 640, 1000);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.8);
  });

  it('never makes the image wider than what was painted', async () => {
    mocks.requestFrameCapture.mockResolvedValue(bitmap(400, 300));
    await captureIframeScreenshot(iframe, 1280, 720, 640);
    expect([canvas.width, canvas.height]).toEqual([400, 300]);
  });

  it('tries once more at lower quality when the image is too large', async () => {
    mocks.requestFrameCapture.mockResolvedValue(bitmap(1280, 720));
    canvas.toDataURL.mockImplementation((_type: string, quality: number) => (quality === 0.6 ? SMALL : LARGE));

    expect(await captureIframeScreenshot(iframe, 1280, 720, 640, 0.8)).toBe(SMALL);
    expect(canvas.toDataURL.mock.calls).toEqual([['image/jpeg', 0.8], ['image/jpeg', 0.6]]);
  });

  it('keeps the first encoding when it is small enough', async () => {
    mocks.requestFrameCapture.mockResolvedValue(bitmap(1280, 720));
    await captureIframeScreenshot(iframe, 1280, 720, 640, 0.8);
    expect(canvas.toDataURL).toHaveBeenCalledTimes(1);
  });

  it('gives the bitmap back once done with it, whether or not encoding worked', async () => {
    const ok = bitmap(1280, 720);
    mocks.requestFrameCapture.mockResolvedValue(ok);
    await captureIframeScreenshot(iframe);
    expect(ok.close).toHaveBeenCalledTimes(1);

    const failed = bitmap(1280, 720);
    mocks.requestFrameCapture.mockResolvedValue(failed);
    canvas.toDataURL.mockImplementation(() => { throw new Error('tainted'); });
    expect(await captureIframeScreenshot(iframe)).toBeNull();
    expect(failed.close).toHaveBeenCalledTimes(1);
  });

  it('returns nothing when the frame could not paint itself', async () => {
    mocks.requestFrameCapture.mockRejectedValue(new Error('capture timed out'));
    expect(await captureIframeScreenshot(iframe)).toBeNull();
  });
});
