// Audio helpers shared by the voice transcription service and its worker.
// Every voice path (desktop mic, remote control) delivers 16 kHz mono
// Float32 PCM.

export const VOICE_SAMPLE_RATE = 16_000;

// Parakeet's encoder cannot attend past ~400 s of audio (onnxruntime aborts
// the whole process), and its memory grows with input length: ~1 GB at 30 s,
// ~3 GB at 5 min. Decoding in pieces keeps every recording near the
// short-clip footprint.
const MAX_CHUNK_SECONDS = 30;
// Cut at the quietest point in the last part of each chunk so splits land in
// a pause rather than mid-word.
const SPLIT_SEARCH_SECONDS = 10;
const SPLIT_WINDOW_SECONDS = 0.1;

// Accidental shortcut taps produce short or silent clips, which the model
// sometimes turns into a stray "Mm." or "No.".
const MIN_SPEECH_SECONDS = 0.5;
const SPEECH_WINDOW_SECONDS = 0.05;
const SILENCE_RMS = 0.003; // ≈ -50 dBFS
const FILLER_ONLY = /^(?:h*m+|m+h+m+|u+h+|u+h*m+|e+r+m*)[.,!?]*$/i;

function windowEnergy(samples: Float32Array, start: number, length: number): number {
  let sum = 0;
  for (let i = start; i < start + length; i++) sum += samples[i] * samples[i];
  return sum;
}

/** Split audio into chunks the recognizer can decode, cutting at pauses. */
export function splitAtPauses(
  samples: Float32Array,
  sampleRate: number = VOICE_SAMPLE_RATE
): Float32Array[] {
  const maxLength = Math.round(MAX_CHUNK_SECONDS * sampleRate);
  if (samples.length <= maxLength) return [samples];

  const searchLength = Math.round(SPLIT_SEARCH_SECONDS * sampleRate);
  const window = Math.round(SPLIT_WINDOW_SECONDS * sampleRate);
  const step = Math.max(1, Math.floor(window / 2));
  const chunks: Float32Array[] = [];
  let start = 0;
  while (samples.length - start > maxLength) {
    const searchEnd = start + maxLength;
    let quietestStart = searchEnd - window;
    let quietestEnergy = Infinity;
    for (let w = searchEnd - searchLength; w + window <= searchEnd; w += step) {
      const energy = windowEnergy(samples, w, window);
      if (energy < quietestEnergy) {
        quietestEnergy = energy;
        quietestStart = w;
      }
    }
    const cut = quietestStart + Math.floor(window / 2);
    chunks.push(samples.subarray(start, cut));
    start = cut;
  }
  chunks.push(samples.subarray(start));
  return chunks;
}

/** True when a clip is too short or too quiet to contain speech. */
export function lacksSpeech(
  samples: Float32Array,
  sampleRate: number = VOICE_SAMPLE_RATE
): boolean {
  if (samples.length < MIN_SPEECH_SECONDS * sampleRate) return true;
  const window = Math.round(SPEECH_WINDOW_SECONDS * sampleRate);
  const threshold = SILENCE_RMS * SILENCE_RMS * window;
  for (let w = 0; w + window <= samples.length; w += window) {
    if (windowEnergy(samples, w, window) >= threshold) return false;
  }
  return true;
}

/** True for transcripts that are only a hesitation sound such as "Mm." or "Uh.". */
export function isFillerOnly(text: string): boolean {
  return FILLER_ONLY.test(text.trim());
}
