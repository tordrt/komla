// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Helpers ───────────────────────────────────────────────────────────────

function mockMediaStream(): MediaStream {
  const stop = vi.fn();
  return {
    getAudioTracks: () => [{ getSettings: () => ({ sampleRate: 48000 }), stop }],
    getTracks: () => [{ stop }],
  } as unknown as MediaStream;
}

function installGetUserMedia(stream: MediaStream): ReturnType<typeof vi.fn> {
  const gum = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: { getUserMedia: gum },
    configurable: true,
  });
  return gum;
}

interface MockWorkletNode {
  port: {
    onmessage: ((event: { data: Float32Array }) => void) | null;
    close: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface MockAudioContext {
  close: ReturnType<typeof vi.fn>;
}

interface AudioContextStub {
  addModule: ReturnType<typeof vi.fn>;
  /** The most recently constructed AudioWorkletNode (lets tests fire frames at it). */
  latestNode: () => MockWorkletNode | undefined;
  /** All AudioContext instances constructed since the stub was installed. */
  contexts: () => MockAudioContext[];
}

function stubAudioContext(overrides?: { addModule?: ReturnType<typeof vi.fn> }): AudioContextStub {
  const addModule = overrides?.addModule ?? vi.fn().mockResolvedValue(undefined);
  const mockSource = { connect: vi.fn(), disconnect: vi.fn() };
  let latestNode: MockWorkletNode | undefined;
  const contexts: MockAudioContext[] = [];
  // Use a real function (not arrow) so it can be called with `new`
  vi.stubGlobal('AudioContext', function MockAudioContext(options?: AudioContextOptions) {
    const ctx = {
      sampleRate: options?.sampleRate ?? 48000,
      state: 'running',
      resume: vi.fn(),
      audioWorklet: { addModule },
      createMediaStreamSource: vi.fn().mockReturnValue(mockSource),
      close: vi.fn().mockResolvedValue(undefined),
      destination: {},
    };
    contexts.push(ctx);
    return ctx;
  });
  vi.stubGlobal('AudioWorkletNode', function MockAudioWorkletNode() {
    latestNode = {
      port: { onmessage: null, close: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    return latestNode;
  });
  return { addModule, latestNode: () => latestNode, contexts: () => contexts };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('audio-capture', () => {
  let stream: MediaStream;

  beforeEach(() => {
    stream = mockMediaStream();
    installGetUserMedia(stream);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Reset module state between tests so module singletons don't leak
    vi.resetModules();
  });

  it('startAudioCapture builds a fresh AudioContext + worklet on each capture', async () => {
    // Each capture owns its own AudioContext so a stale cancelled attempt
    // can't close the live retry's context. cleanup() always calls close()
    // on its own context, never anything shared.
    const { addModule, contexts } = stubAudioContext();
    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');

    const first = await startAudioCapture();
    first.cancel();
    // Re-install getUserMedia to return a fresh stream for the second call
    installGetUserMedia(mockMediaStream());
    const second = await startAudioCapture();
    second.cancel();

    expect(addModule).toHaveBeenCalledTimes(2);
    expect(contexts().length).toBe(2);
  });

  it('cleanup closes the AudioContext and the worklet message port', async () => {
    const { contexts, latestNode } = stubAudioContext();
    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');

    const handle = await startAudioCapture();
    const node = latestNode();
    handle.cancel();

    expect(contexts()[0].close).toHaveBeenCalledTimes(1);
    expect(node!.port.close).toHaveBeenCalledTimes(1);
  });

  it('cleanup is idempotent — mixed cancel/stop closes resources only once', async () => {
    const { contexts } = stubAudioContext();
    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');

    const handle = await startAudioCapture();
    handle.cancel();
    // Both subsequent paths should be no-ops — guard against the unmount race
    // where stop() and cancel() can both run on the same handle.
    handle.stop();
    handle.cancel();

    expect(contexts()[0].close).toHaveBeenCalledTimes(1);
    expect(stream.getTracks()[0].stop).toHaveBeenCalledTimes(1);
  });

  it('accumulates frames posted from the worklet and returns concatenated audio at stop()', async () => {
    const { latestNode } = stubAudioContext();
    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');

    const handle = await startAudioCapture();
    const node = latestNode();
    expect(node).toBeDefined();
    expect(node!.port.onmessage).toBeTypeOf('function');

    // Fire two frames at the worklet's port.onmessage handler
    const frameA = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    const frameB = new Float32Array([0.25, -0.25, 0.25, -0.25]);
    node!.port.onmessage!({ data: frameA });

    // After the first frame, RMS = sqrt(mean(x^2)) = 0.5
    expect(handle.getLevel()).toBeCloseTo(0.5, 5);

    node!.port.onmessage!({ data: frameB });
    // After the second frame, RMS = 0.25
    expect(handle.getLevel()).toBeCloseTo(0.25, 5);

    // The context runs at 16 kHz, so the browser resamples and frames pass through as-is.
    expect(Array.from(handle.stop())).toEqual([...frameA, ...frameB]);
  });

  it('reports the level over every frame since the last read', async () => {
    const { latestNode } = stubAudioContext();
    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');
    const handle = await startAudioCapture();

    latestNode()!.port.onmessage!({ data: new Float32Array([0.5, -0.5]) });
    latestNode()!.port.onmessage!({ data: new Float32Array([0.25, -0.25]) });

    // Not just the latest frame's 0.25: the level meter reads every 50 ms.
    expect(handle.getLevel()).toBeCloseTo(Math.sqrt((0.25 + 0.0625) / 2), 5);
    // No new frames: the mic stalled, so the waveform drops to silence.
    expect(handle.getLevel()).toBe(0);
  });

  it('ignores frames that arrive after cancel()', async () => {
    const { latestNode } = stubAudioContext();
    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');

    const handle = await startAudioCapture();
    const node = latestNode();

    handle.cancel();

    // A late frame should be silently dropped — calling onmessage must not throw
    // and must not affect the level (which getLevel() returns from `currentLevel`).
    if (node?.port.onmessage) {
      node.port.onmessage({ data: new Float32Array([1, 1, 1, 1]) });
    }
    expect(handle.getLevel()).toBe(0);
  });

  it('stops the mic stream if worklet setup fails after getUserMedia succeeded', async () => {
    const failingAddModule = vi.fn().mockRejectedValue(new Error('addModule failed'));
    const { contexts } = stubAudioContext({ addModule: failingAddModule });

    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');

    await expect(startAudioCapture()).rejects.toThrow('addModule failed');

    // Critical: the mic indicator should not stay lit — tracks must be stopped
    // AND the context must be closed (a partially-attached source on a live
    // context can keep Chromium reporting the renderer as mic-active).
    expect(stream.getTracks()[0].stop).toHaveBeenCalled();
    expect(contexts()[0].close).toHaveBeenCalledTimes(1);
  });

  it('stops the mic stream if AudioContext construction itself throws', async () => {
    // Chromium caps concurrent AudioContexts at ~6; rapid start/cancel can
    // briefly hit the limit and throw from `new AudioContext()`. The mic
    // stream tracks must still stop or the OS mic indicator stays lit.
    vi.stubGlobal('AudioContext', function ThrowingAudioContext() {
      throw new Error('too many contexts');
    });

    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');

    await expect(startAudioCapture()).rejects.toThrow('too many contexts');
    expect(stream.getTracks()[0].stop).toHaveBeenCalled();
  });

  it('a retry after setup failure builds a fresh context', async () => {
    const failingAddModule = vi.fn().mockRejectedValue(new Error('addModule failed'));
    const { contexts } = stubAudioContext({ addModule: failingAddModule });

    const { startAudioCapture } = await import('../../../src/renderer/lib/audio-capture');

    await expect(startAudioCapture()).rejects.toThrow('addModule failed');

    // Re-stub with a working addModule and a fresh stream, then retry.
    installGetUserMedia(mockMediaStream());
    const { contexts: contexts2 } = stubAudioContext();
    expect(contexts2().length).toBe(0);
    const handle = await startAudioCapture();
    handle.cancel();
    expect(contexts2().length).toBe(1);
    // Sanity: the original failed-setup context remains unchanged at 1 close.
    expect(contexts()[0].close).toHaveBeenCalledTimes(1);
  });
});
