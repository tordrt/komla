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

// ── Audio capture ───────────────────────────────────────────────────────
// Each capture owns its own AudioContext. Sharing the context across
// captures was unsafe: a stale cancelled attempt could close the live
// retry's context (cleanup() calls `audioContext.close()`).

export interface AudioCaptureHandle {
  /** Stop recording and return the complete PCM buffer (16kHz mono Float32) */
  stop: () => Float32Array;
  /** The audio level (0-1 RMS) since the last call, for UI visualization */
  getLevel: () => number;
  /** Cancel recording and discard audio */
  cancel: () => void;
}

export async function startAudioCapture(): Promise<AudioCaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);

  // Once we own the stream, stop its tracks if any subsequent setup throws —
  // otherwise the mic indicator stays lit until the page closes. The
  // AudioContext constructor itself can throw (Chromium caps concurrent
  // contexts at ~6), so it must run inside the try.
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let audioContext: AudioContext | undefined;
  try {
    // The browser resamples the mic to the context's rate, with proper filtering.
    audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    // Chromium suspends new AudioContexts by default (autoplay policy).
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    await audioContext.audioWorklet.addModule(captureProcessorUrl);

    source = audioContext.createMediaStreamSource(stream);
    node = new AudioWorkletNode(audioContext, WORKLET_PROCESSOR_NAME);
    source.connect(node);
    // Connect node to destination so the audio graph keeps the worklet alive.
    // Our worklet doesn't write to outputs, so this emits silence (no echo).
    node.connect(audioContext.destination);
  } catch (err) {
    node?.disconnect();
    source?.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    // Drop the context too so a partially-attached source can't keep Chromium
    // reporting the renderer as mic-active.
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
  let sumOfSquares = 0;
  let sampleCount = 0;
  let cancelled = false;
  let cleanedUp = false;

  workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (cancelled) return;
    const frame = event.data;
    chunks.push(frame);

    for (let i = 0; i < frame.length; i++) {
      sumOfSquares += frame[i] * frame[i];
    }
    sampleCount += frame.length;
  };

  function cleanup(): void {
    if (cleanedUp) return;
    cleanedUp = true;
    workletNode.port.onmessage = null;
    workletNode.port.close();
    workletNode.disconnect();
    sourceNode.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    // Fire-and-forget the close — it's async, but stop() must stay synchronous.
    void ctx.close().catch(() => {});
  }

  return {
    stop: () => {
      cleanup();

      // Concatenate all chunks
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const fullBuffer = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        fullBuffer.set(chunk, offset);
        offset += chunk.length;
      }
      return fullBuffer;
    },

    getLevel: () => {
      // RMS over every frame since the last call, not just the latest 8 ms.
      // No frames means the mic stalled, so show silence rather than the last word.
      currentLevel = sampleCount > 0 ? Math.sqrt(sumOfSquares / sampleCount) : 0;
      sumOfSquares = 0;
      sampleCount = 0;
      return currentLevel;
    },

    cancel: () => {
      cancelled = true;
      chunks.length = 0;
      cleanup();
    },
  };
}
