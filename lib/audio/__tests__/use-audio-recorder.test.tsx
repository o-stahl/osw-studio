// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAudioRecorder } from '../use-audio-recorder';

/**
 * Why recording could not start, as the code the chat panel words: no microphone, access blocked,
 * or a browser that cannot record at all. The panel says something different for each.
 */

let container: HTMLDivElement;
let root: Root;
let recorder: ReturnType<typeof useAudioRecorder>;

function Probe() {
  recorder = useAudioRecorder();
  return null;
}

function denyWith(name: string) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => { throw new DOMException('no', name); }) },
  });
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('AudioContext', class {});
  vi.stubGlobal('MediaRecorder', class {});
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
});

describe('useAudioRecorder, when recording cannot start', () => {
  it.each(['NotFoundError', 'DevicesNotFoundError'])('reports no microphone for %s', async (name) => {
    denyWith(name);
    await act(async () => { await recorder.start(); });
    expect(recorder.error).toBe('noMicrophone');
    expect(recorder.isRecording).toBe(false);
  });

  it('reports access as blocked when permission is refused', async () => {
    denyWith('NotAllowedError');
    await act(async () => { await recorder.start(); });
    expect(recorder.error).toBe('blocked');
  });

  it('reports a browser that cannot record as unsupported', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    denyWith('NotAllowedError');
    await act(async () => { await recorder.start(); });
    expect(recorder.error).toBe('unsupported');
  });
});
