'use client';

/**
 * useAudioRecorder — microphone capture for the chat input.
 *
 * Records via MediaRecorder, exposes a live AnalyserNode (for the spectrogram),
 * and on stop decodes the clip and re-encodes it to a 16 kHz mono WAV that the
 * `input_audio` content block / audio-capable models accept.
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { encodeWavBase64 } from './wav';

export interface RecordedAudio {
  data: string; // base64 WAV (no data: prefix)
  format: 'wav';
  durationMs: number;
}

type AudioContextCtor = typeof AudioContext;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext ||
    null
  );
}

type RecorderError = 'unsupported' | 'noMicrophone' | 'blocked' | 'processFailed';

export function useAudioRecorder() {
  const [isRecording, setIsRecording] = useState(false);
  // A code, not text: the chat panel words it under `chat.recording`.
  const [error, setError] = useState<RecorderError | null>(null);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const startedAtRef = useRef(0);

  const cleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    ctxRef.current?.close().catch(() => {});
    ctxRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    setAnalyser(null);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    const AC = getAudioContextCtor();
    if (!navigator.mediaDevices?.getUserMedia || !AC || typeof MediaRecorder === 'undefined') {
      setError('unsupported');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const ctx = new AC();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      source.connect(an);
      setAnalyser(an);

      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      setError(
        name === 'NotFoundError' || name === 'DevicesNotFoundError'
          ? 'noMicrophone'
          : 'blocked',
      );
      cleanup();
    }
  }, [cleanup]);

  const stop = useCallback((): Promise<RecordedAudio | null> => {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        cleanup();
        setIsRecording(false);
        resolve(null);
        return;
      }
      const mimeType = recorder.mimeType || 'audio/webm';
      recorder.onstop = async () => {
        const durationMs = Date.now() - startedAtRef.current;
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const AC = getAudioContextCtor();
        let decodeCtx: AudioContext | null = null;
        try {
          if (!AC || blob.size === 0) throw new Error('empty');
          const arrayBuf = await blob.arrayBuffer();
          decodeCtx = new AC();
          const audioBuf = await decodeCtx.decodeAudioData(arrayBuf);
          const data = encodeWavBase64(audioBuf);
          resolve({ data, format: 'wav', durationMs });
        } catch {
          setError('processFailed');
          resolve(null);
        } finally {
          decodeCtx?.close().catch(() => {});
          cleanup();
          setIsRecording(false);
        }
      };
      recorder.stop();
    });
  }, [cleanup]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.stop();
    }
    cleanup();
    setIsRecording(false);
    setError(null);
  }, [cleanup]);

  useEffect(() => () => cleanup(), [cleanup]);

  return { isRecording, error, analyser, start, stop, cancel };
}
