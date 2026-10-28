import { describe, expect, it } from 'vitest';

import {
  VOICE_SAMPLE_RATE,
  isFillerOnly,
  lacksSpeech,
  splitAtPauses,
} from '../../../src/main/lib/voice-audio';

const RATE = VOICE_SAMPLE_RATE;

function tone(seconds: number, amplitude = 0.2): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++)
    out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('splitAtPauses', () => {
  it('returns short audio as a single chunk', () => {
    const audio = tone(12);
    expect(splitAtPauses(audio)).toEqual([audio]);
  });

  it('keeps every chunk under 30 seconds and loses no samples', () => {
    const audio = tone(400);
    const chunks = splitAtPauses(audio);
    expect(chunks.length).toBeGreaterThan(13);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(30 * RATE);
    expect(chunks.reduce((sum, c) => sum + c.length, 0)).toBe(audio.length);
  });

  it('returns views of the recording instead of copies', () => {
    const audio = tone(100);
    for (const chunk of splitAtPauses(audio)) expect(chunk.buffer).toBe(audio.buffer);
  });

  it('cuts inside the pause nearest the chunk limit instead of mid-speech', () => {
    // Speech 0-24 s, pause 24-24.5 s, speech 24.5-40 s.
    const audio = concat(tone(24), new Float32Array(0.5 * RATE), tone(16));
    const [first, second] = splitAtPauses(audio);
    expect(first.length / RATE).toBeGreaterThanOrEqual(24);
    expect(first.length / RATE).toBeLessThanOrEqual(24.5);
    expect(first.length + second.length).toBe(audio.length);
  });
});

describe('lacksSpeech', () => {
  it('flags clips shorter than half a second', () => {
    expect(lacksSpeech(tone(0.4))).toBe(true);
  });

  it('flags near-silent clips', () => {
    expect(lacksSpeech(tone(2, 0.002))).toBe(true);
  });

  it('accepts audible clips, even when most of the clip is silent', () => {
    expect(lacksSpeech(concat(new Float32Array(3 * RATE), tone(0.3, 0.05)))).toBe(false);
  });
});

describe('isFillerOnly', () => {
  it.each(['Mm.', 'Hmm.', 'mhm', 'Uh.', 'Um,', 'Uhm?'])('treats %j as filler', (text) => {
    expect(isFillerOnly(text)).toBe(true);
  });

  it.each(['No.', 'Yes.', 'Hmm, run the tests.', 'Oh.', ''])('keeps %j', (text) => {
    expect(isFillerOnly(text)).toBe(false);
  });
});
