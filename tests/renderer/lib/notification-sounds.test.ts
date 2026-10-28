import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  IMPLEMENTED_PRESET_IDS,
  NOTIFICATION_SOUND_COOLDOWN_MS,
  SOUND_PRESETS,
  cacheCustomSound,
  playNotificationSound,
  previewNotificationSound,
  type NotificationSoundsConfig,
} from '../../../src/renderer/lib/notification-sounds';

describe('notification-sounds registry', () => {
  test('every SOUND_PRESETS id has a synthesis implementation', () => {
    const implemented = new Set<string>(IMPLEMENTED_PRESET_IDS);
    const missing = SOUND_PRESETS.filter((p) => !implemented.has(p.id)).map((p) => p.id);
    expect(missing).toEqual([]);
  });

  test('every implemented preset id is listed in SOUND_PRESETS', () => {
    const listed = new Set<string>(SOUND_PRESETS.map((p) => p.id));
    const orphaned = IMPLEMENTED_PRESET_IDS.filter((id) => !listed.has(id));
    expect(orphaned).toEqual([]);
  });

  test('SOUND_PRESETS ids are unique', () => {
    const ids = SOUND_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('SOUND_PRESETS labels are unique', () => {
    const labels = SOUND_PRESETS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test('gentle preset is always implemented (playback fallback target)', () => {
    expect(IMPLEMENTED_PRESET_IDS).toContain('gentle');
    expect(SOUND_PRESETS.some((p) => p.id === 'gentle')).toBe(true);
  });
});

// Exercises the actual Web Audio graph wiring for every preset against a
// minimal AudioContext stub. Catches broken oscillator/filter/envelope
// scheduling that the registry tests cannot — e.g. a typo'd OscillatorType
// or a missing connect() target.
describe('notification-sounds synthesis', () => {
  beforeAll(() => {
    const param = () => ({
      value: 0,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    });
    vi.stubGlobal('AudioContext', function MockAudioContext() {
      return {
        currentTime: 0,
        sampleRate: 44100,
        destination: {},
        createGain: () => ({ gain: param(), connect: vi.fn() }),
        createOscillator: () => ({
          type: 'sine',
          frequency: param(),
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        }),
        createBiquadFilter: () => ({
          type: 'lowpass',
          frequency: param(),
          Q: param(),
          connect: vi.fn(),
        }),
        createStereoPanner: () => ({ pan: param(), connect: vi.fn() }),
        createConvolver: () => ({ buffer: null, connect: vi.fn() }),
        createBufferSource: () => ({
          buffer: null,
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        }),
        createBuffer: (_channels: number, length: number) => ({
          getChannelData: () => new Float32Array(length),
        }),
      };
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  test.each(SOUND_PRESETS.map((p) => p.id))('preset %s synthesizes without throwing', (id) => {
    expect(() => previewNotificationSound(id, 0.5)).not.toThrow();
  });

  test('out-of-range volume is clamped, not thrown', () => {
    expect(() => previewNotificationSound('gentle', -5)).not.toThrow();
    expect(() => previewNotificationSound('gentle', 99)).not.toThrow();
  });

  test('unknown preset id falls back to gentle without throwing', () => {
    expect(() => previewNotificationSound('not-a-real-preset', 0.5)).not.toThrow();
  });
});

describe('playNotificationSound coalescing', () => {
  const config: NotificationSoundsConfig = {
    enabled: true,
    volume: 0.5,
    turnComplete: true,
    turnCompleteSound: 'custom:done.mp3',
    inputRequired: true,
    inputRequiredSound: 'custom:input.mp3',
  };
  let played: string[];
  let clock = Date.now();

  beforeAll(() => {
    // Custom sounds are played via Audio from the data URL cache.
    // Windows share one origin, so localStorage is shared between renderers.
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      api: {
        getSoundDataUrl: async (name: string) => (name === 'missing.mp3' ? null : `data:${name}`),
      },
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    vi.stubGlobal(
      'Audio',
      class {
        volume = 1;
        constructor(private readonly src: string) {}
        play() {
          played.push(this.src);
          return Promise.resolve();
        }
      }
    );
  });

  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    await cacheCustomSound('done.mp3');
    await cacheCustomSound('input.mp3');
    played = [];
    // Each test starts well past the previous test's cooldown.
    clock += NOTIFICATION_SOUND_COOLDOWN_MS * 10;
    vi.useFakeTimers({ now: clock });
  });

  test('plays at most one sound per cooldown window', () => {
    playNotificationSound('turn-complete', config);
    playNotificationSound('turn-complete', config);
    vi.advanceTimersByTime(NOTIFICATION_SOUND_COOLDOWN_MS - 1);
    playNotificationSound('turn-complete', config);
    expect(played).toEqual(['data:done.mp3']);

    vi.advanceTimersByTime(1);
    playNotificationSound('turn-complete', config);
    expect(played).toEqual(['data:done.mp3', 'data:done.mp3']);
  });

  test('input-required takes precedence over a recent turn-complete once', () => {
    playNotificationSound('turn-complete', config);
    playNotificationSound('input-required', config);
    playNotificationSound('input-required', config);
    playNotificationSound('turn-complete', config);
    expect(played).toEqual(['data:done.mp3', 'data:input.mp3']);
  });

  test('shares the cooldown with other windows', async () => {
    playNotificationSound('turn-complete', config);
    vi.resetModules();
    const otherWindow = await import('../../../src/renderer/lib/notification-sounds');
    await otherWindow.cacheCustomSound('done.mp3');
    otherWindow.playNotificationSound('turn-complete', config);
    expect(played).toEqual(['data:done.mp3']);
  });

  test('a backwards clock jump does not suppress later sounds', () => {
    playNotificationSound('turn-complete', config);
    vi.setSystemTime(Date.now() - 60_000);
    playNotificationSound('turn-complete', config);
    expect(played).toEqual(['data:done.mp3', 'data:done.mp3']);
  });

  test('a sound that could not play does not start the cooldown', async () => {
    await cacheCustomSound('missing.mp3');
    playNotificationSound('turn-complete', { ...config, turnCompleteSound: 'custom:missing.mp3' });
    playNotificationSound('turn-complete', config);
    expect(played).toEqual(['data:done.mp3']);
  });

  test('disabled kinds do not start the cooldown', () => {
    playNotificationSound('idle', config);
    playNotificationSound('turn-complete', config);
    expect(played).toEqual(['data:done.mp3']);
  });
});
