import type { WorkspaceAttentionKind } from '../../shared/types/workspace';

// ---------------------------------------------------------------------------
// Audio context singleton
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;
let roomNode: ConvolverNode | null = null;

function ctx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

// ---------------------------------------------------------------------------
// Synthesis building blocks
// ---------------------------------------------------------------------------

/**
 * Shared small-room reverb. The impulse response is darkened stereo noise
 * with a fast decay, so tails stay short and soft rather than hissy.
 */
function room(audio: AudioContext): ConvolverNode {
  if (roomNode) return roomNode;
  const length = Math.ceil(audio.sampleRate * 1.2);
  const ir = audio.createBuffer(2, length, audio.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < length; i++) {
      lp += (Math.random() * 2 - 1 - lp) * 0.3;
      data[i] = lp * Math.pow(1 - i / length, 4);
    }
  }
  roomNode = audio.createConvolver();
  roomNode.buffer = ir;
  roomNode.connect(audio.destination);
  return roomNode;
}

/** Master gain for one sound: dry to the speakers, plus a send to the room. */
function output(audio: AudioContext, gain: number, wet: number): GainNode {
  const master = audio.createGain();
  master.gain.value = gain;
  master.connect(audio.destination);
  const send = audio.createGain();
  send.gain.value = wet;
  master.connect(send);
  send.connect(room(audio));
  return master;
}

/** Stereo position for one note, -1 (left) to 1 (right). */
function panned(audio: AudioContext, pan: number, dest: AudioNode): AudioNode {
  const p = audio.createStereoPanner();
  p.pan.value = pan;
  p.connect(dest);
  return p;
}

/** Quick gain envelope — attack/release in seconds. */
function envelope(
  audio: AudioContext,
  t: number,
  attack: number,
  hold: number,
  release: number
): GainNode {
  const g = audio.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(1, t + attack);
  g.gain.setValueAtTime(1, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.001, t + attack + hold + release);
  return g;
}

/** Oscillator that plays between start..stop and connects to dest. */
function osc(
  audio: AudioContext,
  type: OscillatorType,
  freq: number,
  start: number,
  stop: number,
  dest: AudioNode
): OscillatorNode {
  const o = audio.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  o.connect(dest);
  o.start(start);
  o.stop(stop);
  return o;
}

/** Bandpass-filtered noise burst for percussive textures. */
function noiseBurst(
  audio: AudioContext,
  t: number,
  duration: number,
  freq: number,
  q: number,
  dest: AudioNode
): void {
  const bufferSize = Math.ceil(audio.sampleRate * duration);
  const buffer = audio.createBuffer(1, bufferSize, audio.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const src = audio.createBufferSource();
  src.buffer = buffer;

  const bp = audio.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;

  const env = envelope(audio, t, 0.002, duration * 0.2, duration * 0.8);

  src.connect(bp);
  bp.connect(env);
  env.connect(dest);
  src.start(t);
  src.stop(t + duration);
}

/** One vibration mode of a struck object: frequency ratio, level and decay time. */
interface Mode {
  ratio: number;
  gain: number;
  decay: number;
}

/**
 * Strike a resonant object: each mode rings as a sine with its own decay.
 * Real bars and bells have inharmonic modes that fade faster the higher they
 * are, which is what makes them sound struck rather than electronic.
 */
function strike(
  audio: AudioContext,
  start: number,
  freq: number,
  modes: readonly Mode[],
  dest: AudioNode,
  attack = 0.002
): void {
  for (const m of modes) {
    const g = audio.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(m.gain, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + attack + m.decay);
    g.connect(dest);
    osc(audio, 'sine', freq * m.ratio, start, start + attack + m.decay + 0.02, g);
  }
}

/** Plucked string (Karplus-Strong): a noise burst circulating through a damped delay line. */
function pluckString(
  audio: AudioContext,
  start: number,
  freq: number,
  duration: number,
  dest: AudioNode
): void {
  const sr = audio.sampleRate;
  const length = Math.ceil(sr * duration);
  const buffer = audio.createBuffer(1, length, sr);
  const data = buffer.getChannelData(0);
  // The two-point average adds half a sample of delay; take it off the period.
  const period = Math.max(2, Math.round(sr / freq - 0.5));
  const line = new Float32Array(period);
  let lp = 0;
  for (let i = 0; i < period; i++) {
    lp += (Math.random() * 2 - 1 - lp) * 0.5; // softened excitation, like a fingertip
    line[i] = lp;
  }
  for (let i = 0; i < length; i++) {
    const j = i % period;
    const v = line[j];
    data[i] = v * (1 - i / length); // fade out so the buffer ends silent
    line[j] = 0.996 * 0.5 * (v + line[(j + 1) % period]);
  }
  const src = audio.createBufferSource();
  src.buffer = buffer;
  src.connect(dest);
  src.start(start);
}

/** Electric piano voice: a two-operator FM tone whose brightness fades as it rings. */
function epiano(
  audio: AudioContext,
  start: number,
  freq: number,
  decay: number,
  dest: AudioNode
): void {
  const stop = start + decay + 0.05;
  const amp = audio.createGain();
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(1, start + 0.004);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + decay);
  amp.connect(dest);
  const carrier = osc(audio, 'sine', freq, start, stop, amp);

  const depth = audio.createGain();
  depth.gain.setValueAtTime(freq * 1.6, start);
  depth.gain.exponentialRampToValueAtTime(freq * 0.08, start + decay * 0.5);
  depth.connect(carrier.frequency);
  osc(audio, 'sine', freq, start, stop, depth);
}

/** Sine whose pitch glides from one frequency to another — droplets and pops. */
function glide(
  audio: AudioContext,
  start: number,
  from: number,
  to: number,
  sweep: number,
  decay: number,
  dest: AudioNode
): void {
  const env = envelope(audio, start, 0.002, 0.005, decay);
  env.connect(dest);
  const o = audio.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(from, start);
  o.frequency.exponentialRampToValueAtTime(to, start + sweep);
  o.connect(env);
  o.start(start);
  o.stop(start + 0.007 + decay);
}

// Mode tables. Ratios follow measured instruments: a marimba bar is tuned to
// 1:4:10, a kalimba tine rings near 1:5.9, a free bar (tubular chime) at
// 1:2.76:5.40:8.93, and a wine glass near 1:2.32:4.25.
const MARIMBA: readonly Mode[] = [
  { ratio: 1, gain: 1, decay: 0.5 },
  { ratio: 3.99, gain: 0.22, decay: 0.12 },
  { ratio: 9.9, gain: 0.06, decay: 0.04 },
];
const KALIMBA: readonly Mode[] = [
  { ratio: 1, gain: 1, decay: 0.75 },
  { ratio: 5.93, gain: 0.1, decay: 0.09 },
];
const BELL: readonly Mode[] = [
  { ratio: 1, gain: 1, decay: 1.3 },
  { ratio: 2, gain: 0.32, decay: 0.8 },
  { ratio: 3.01, gain: 0.16, decay: 0.5 },
  { ratio: 4.17, gain: 0.08, decay: 0.3 },
  { ratio: 5.43, gain: 0.04, decay: 0.18 },
];
const CHIME: readonly Mode[] = [
  { ratio: 1, gain: 1, decay: 1.4 },
  { ratio: 2.76, gain: 0.3, decay: 0.7 },
  { ratio: 5.4, gain: 0.12, decay: 0.35 },
  { ratio: 8.93, gain: 0.05, decay: 0.15 },
];
const GLASS: readonly Mode[] = [
  { ratio: 1, gain: 1, decay: 1 },
  { ratio: 2.32, gain: 0.25, decay: 0.45 },
  { ratio: 4.25, gain: 0.1, decay: 0.22 },
];
const WOOD: readonly Mode[] = [
  { ratio: 1, gain: 1, decay: 0.06 },
  { ratio: 2.3, gain: 0.35, decay: 0.035 },
  { ratio: 4.1, gain: 0.15, decay: 0.02 },
];

// ---------------------------------------------------------------------------
// Sound presets
// ---------------------------------------------------------------------------

export type SoundPresetId =
  // Soft
  | 'gentle'
  | 'marimba'
  | 'pluck'
  | 'droplet'
  | 'pop'
  | 'knock'
  // Clear
  | 'bell'
  | 'chime'
  | 'glass'
  | 'keys'
  | 'ping';

export const SOUND_PRESETS: { id: SoundPresetId; label: string; group: string }[] = [
  // Soft — short and low-key, for frequent events
  { id: 'gentle', label: 'Gentle', group: 'Soft' },
  { id: 'marimba', label: 'Marimba', group: 'Soft' },
  { id: 'pluck', label: 'Pluck', group: 'Soft' },
  { id: 'droplet', label: 'Droplet', group: 'Soft' },
  { id: 'pop', label: 'Pop', group: 'Soft' },
  { id: 'knock', label: 'Knock', group: 'Soft' },
  // Clear — ringing tones that carry across a room
  { id: 'bell', label: 'Bell', group: 'Clear' },
  { id: 'chime', label: 'Chime', group: 'Clear' },
  { id: 'glass', label: 'Glass', group: 'Clear' },
  { id: 'keys', label: 'Keys', group: 'Clear' },
  { id: 'ping', label: 'Ping', group: 'Clear' },
];

// Each preset is a function(volume) that plays itself.
const presets: Record<SoundPresetId, (vol: number) => void> = {
  // --- Soft ---

  gentle(vol) {
    // Two kalimba tines falling a fourth — warm and unobtrusive
    const a = ctx();
    const t = a.currentTime;
    const master = output(a, vol * 0.35, 0.25);
    strike(a, t, 880, KALIMBA, panned(a, 0.15, master), 0.004); // A5
    strike(a, t + 0.12, 659, KALIMBA, panned(a, -0.15, master), 0.004); // E5
  },

  marimba(vol) {
    // Rising fifth on a wooden bar with a soft mallet tick
    const a = ctx();
    const t = a.currentTime;
    const master = output(a, vol * 0.4, 0.2);
    const note = (start: number, freq: number, pan: number) => {
      const dest = panned(a, pan, master);
      strike(a, start, freq, MARIMBA, dest);
      noiseBurst(a, start, 0.004, 2500, 1.5, dest);
    };
    note(t, 440, -0.15); // A4
    note(t + 0.11, 659, 0.15); // E5
  },

  pluck(vol) {
    // Two plucked nylon strings — like a short harp figure
    const a = ctx();
    const t = a.currentTime;
    const master = output(a, vol * 0.72, 0.25);
    const lp = a.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3500;
    lp.connect(master);
    pluckString(a, t, 392, 0.9, panned(a, -0.2, lp)); // G4
    pluckString(a, t + 0.1, 587, 0.9, panned(a, 0.2, lp)); // D5
  },

  droplet(vol) {
    // Water drop: a quick upward pitch blip, then a smaller echo
    const a = ctx();
    const t = a.currentTime;
    const master = output(a, vol * 0.63, 0.35);
    glide(a, t, 500, 1300, 0.05, 0.1, panned(a, -0.1, master));
    glide(a, t + 0.12, 700, 1700, 0.04, 0.08, panned(a, 0.2, master));
  },

  pop(vol) {
    // A single soft bubble pop
    const a = ctx();
    const t = a.currentTime;
    const master = output(a, vol * 0.6, 0.2);
    glide(a, t, 300, 900, 0.03, 0.07, master);
    noiseBurst(a, t, 0.006, 2000, 2, master);
  },

  knock(vol) {
    // Two knocks on a wooden block
    const a = ctx();
    const t = a.currentTime;
    const master = output(a, vol * 0.7, 0.2);
    const hit = (start: number) => {
      strike(a, start, 280, WOOD, master, 0.001);
      noiseBurst(a, start, 0.01, 1200, 1.5, master);
    };
    hit(t);
    hit(t + 0.12);
  },

  // --- Clear ---

  bell(vol) {
    // Classic ding-dong: a falling minor third on a bright bell
    const a = ctx();
    const t = a.currentTime;
    const master = output(a, vol * 0.26, 0.3);
    strike(a, t, 784, BELL, panned(a, 0.15, master)); // G5
    strike(a, t + 0.22, 659, BELL, panned(a, -0.15, master)); // E5
  },

  chime(vol) {
    // Three tubular chimes spread across the stereo field
    const a = ctx();
    const t = a.currentTime;
    const master = output(a, vol * 0.22, 0.35);
    strike(a, t, 880, CHIME, panned(a, -0.4, master)); // A5
    strike(a, t + 0.11, 1175, CHIME, panned(a, 0.4, master)); // D6
    strike(a, t + 0.24, 1319, CHIME, panned(a, 0, master)); // E6
  },

  glass(vol) {
    // A tapped wine glass with a higher sparkle behind it
    const a = ctx();
    const t = a.currentTime;
    const master = output(a, vol * 0.29, 0.3);
    strike(a, t, 1319, GLASS, panned(a, -0.1, master)); // E6
    strike(a, t + 0.09, 1976, GLASS, panned(a, 0.25, master)); // B6
    noiseBurst(a, t, 0.004, 6000, 2, master);
  },

  keys(vol) {
    // A rolled Fmaj7 chord on an electric piano
    const a = ctx();
    const t = a.currentTime;
    const master = output(a, vol * 0.26, 0.3);
    [349, 440, 523, 659].forEach((freq, i) => {
      epiano(a, t + i * 0.04, freq, 1.2, panned(a, -0.3 + i * 0.2, master));
    });
  },

  ping(vol) {
    // One pure ping ringing out into the room
    const a = ctx();
    const t = a.currentTime;
    const master = output(a, vol * 0.28, 0.5);
    strike(
      a,
      t,
      1568, // G6
      [
        { ratio: 1, gain: 1, decay: 0.9 },
        { ratio: 2, gain: 0.08, decay: 0.3 },
      ],
      master,
      0.004
    );
  },
};

/** Preset IDs that have a synthesis implementation. Exposed for registry tests. */
export const IMPLEMENTED_PRESET_IDS: readonly SoundPresetId[] = Object.keys(
  presets
) as SoundPresetId[];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface NotificationSoundsConfig {
  enabled: boolean;
  volume: number;
  turnComplete: boolean;
  turnCompleteSound: string;
  inputRequired: boolean;
  inputRequiredSound: string;
}

/** Used when the config has no notification sounds yet; matches main's default. */
export const DEFAULT_NOTIFICATION_SOUNDS: NotificationSoundsConfig = {
  enabled: true,
  volume: 0.5,
  turnComplete: true,
  turnCompleteSound: 'marimba',
  inputRequired: true,
  inputRequiredSound: 'bell',
};

const kindToConfig: Partial<
  Record<
    WorkspaceAttentionKind,
    { toggle: keyof NotificationSoundsConfig; sound: keyof NotificationSoundsConfig }
  >
> = {
  'turn-complete': { toggle: 'turnComplete', sound: 'turnCompleteSound' },
  'input-required': { toggle: 'inputRequired', sound: 'inputRequiredSound' },
};

export const CUSTOM_PREFIX = 'custom:';

// Cache data URLs for custom sounds so playback is synchronous
// (the user-gesture context required by audio.play() is lost if we await IPC).
const dataUrlCache = new Map<string, string>();

/** Pre-cache a custom sound's data URL. Safe to call multiple times. */
export async function cacheCustomSound(filename: string): Promise<void> {
  if (dataUrlCache.has(filename)) return;
  const url = await window.api.getSoundDataUrl(filename);
  if (url) dataUrlCache.set(filename, url);
}

/**
 * Play a sound by ID — either a built-in preset or a custom:filename reference.
 * Returns false when a custom sound is not cached and nothing played.
 */
function playSoundById(soundId: string, volume: number): boolean {
  const vol = Math.max(0, Math.min(1, volume));

  if (soundId.startsWith(CUSTOM_PREFIX)) {
    return playCustomSound(soundId.slice(CUSTOM_PREFIX.length), vol);
  }
  const play = presets[soundId as SoundPresetId] ?? presets.gentle;
  play(vol);
  return true;
}

/** Play a custom audio file from the data URL cache. */
function playCustomSound(filename: string, volume: number): boolean {
  const dataUrl = dataUrlCache.get(filename);
  if (!dataUrl) return false;
  const audio = new Audio(dataUrl);
  audio.volume = volume;
  audio.play().catch(() => {});
  return true;
}

/** Minimum gap between notification sounds so simultaneous completions play once. */
export const NOTIFICATION_SOUND_COOLDOWN_MS = 1500;

// Stored in localStorage, which all Komla windows share, so the cooldown is
// app-wide rather than per window.
const LAST_NOTIFICATION_SOUND_KEY = 'komla.lastNotificationSound';

interface LastNotificationSound {
  at: number;
  kind: WorkspaceAttentionKind;
}

function readLastNotificationSound(): LastNotificationSound | null {
  try {
    const raw = window.localStorage.getItem(LAST_NOTIFICATION_SOUND_KEY);
    return raw ? (JSON.parse(raw) as LastNotificationSound) : null;
  } catch {
    return null;
  }
}

function writeLastNotificationSound(value: LastNotificationSound): void {
  try {
    window.localStorage.setItem(LAST_NOTIFICATION_SOUND_KEY, JSON.stringify(value));
  } catch {
    // Without storage, sounds are simply not coalesced.
  }
}

/**
 * Play the configured notification sound for an attention event. Sounds are
 * coalesced to one per cooldown, except that input-required may interrupt a
 * recent non-input sound once.
 */
export function playNotificationSound(
  kind: WorkspaceAttentionKind,
  config: NotificationSoundsConfig
): void {
  if (!config.enabled) return;

  const mapping = kindToConfig[kind];
  if (!mapping || !config[mapping.toggle]) return;

  // Wall-clock time so windows can compare; a backwards jump (now < at) ends the cooldown.
  const now = Date.now();
  const last = readLastNotificationSound();
  if (
    last &&
    now >= last.at &&
    now - last.at < NOTIFICATION_SOUND_COOLDOWN_MS &&
    (kind !== 'input-required' || last.kind === 'input-required')
  ) {
    return;
  }

  const soundId = (config[mapping.sound] as string) || 'gentle';
  if (playSoundById(soundId, config.volume)) {
    writeLastNotificationSound({ at: now, kind });
  }
}

/** Play a preview of a sound (for the settings UI). */
export function previewNotificationSound(soundId: string, volume: number): void {
  playSoundById(soundId, volume);
}
