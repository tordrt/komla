// Mic capture for remote voice dictation. Ported from the desktop renderer's
// audio-capture: each capture owns its own AudioContext, accumulates 16 kHz
// mono Float32 PCM via an AudioWorklet, and exposes a level meter for UI.

import captureProcessorUrl from './capture-processor.worklet.js?url';

const TARGET_SAMPLE_RATE = 16000;
const WORKLET_PROCESSOR_NAME = 'komla-capture-processor';

const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    sampleRate: { ideal: TARGET_SAMPLE_RATE },
  },
};

export interface AudioCaptureHandle {
  /** Stop recording and return the complete PCM buffer (16kHz mono Float32) */
  stop: () => Float32Array;
  /** Get the current audio level (0-1 RMS) for UI visualization */
  getLevel: () => number;
  /** Cancel recording and discard audio */
  cancel: () => void;
}

export async function startAudioCapture(): Promise<AudioCaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);

  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let audioContext: AudioContext | undefined;
  try {
    audioContext = new AudioContext();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    await audioContext.audioWorklet.addModule(captureProcessorUrl);

    source = audioContext.createMediaStreamSource(stream);
    node = new AudioWorkletNode(audioContext, WORKLET_PROCESSOR_NAME);
    source.connect(node);
    // Keep the graph alive; our worklet emits no output, so this is silent.
    node.connect(audioContext.destination);
  } catch (err) {
    node?.disconnect();
    source?.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    if (audioContext) {
      void audioContext.close().catch(() => {});
    }
    throw err;
  }

  const sourceNode = source;
  const workletNode = node;
  const ctx = audioContext;
  const chunks: Float32Array[] = [];
  let currentLevel = 0;
  let cancelled = false;
  let cleanedUp = false;

  workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (cancelled) return;
    const frame = event.data;
    chunks.push(frame);

    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      sum += frame[i]! * frame[i]!;
    }
    currentLevel = Math.sqrt(sum / frame.length);
  };

  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    workletNode.port.onmessage = null;
    workletNode.port.close();
    workletNode.disconnect();
    sourceNode.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    void ctx.close().catch(() => {});
  }

  function downsample(buffer: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return buffer;
    const ratio = fromRate / toRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const lower = Math.floor(srcIndex);
      const upper = Math.min(lower + 1, buffer.length - 1);
      const frac = srcIndex - lower;
      result[i] = buffer[lower]! * (1 - frac) + buffer[upper]! * frac;
    }
    return result;
  }

  return {
    stop: () => {
      const capturedSampleRate = ctx.sampleRate;
      cleanup();

      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const fullBuffer = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        fullBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      return downsample(fullBuffer, capturedSampleRate, TARGET_SAMPLE_RATE);
    },

    getLevel: () => currentLevel,

    cancel: () => {
      cancelled = true;
      chunks.length = 0;
      cleanup();
    },
  };
}

/** Encode 16 kHz mono Float32 PCM as little-endian Int16 bytes for transport. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}
