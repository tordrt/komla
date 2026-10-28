import { describe, expect, it } from 'vitest';

import { OutputTailBuffer } from '../../../src/main/lib/output-tail-buffer';

describe('OutputTailBuffer', () => {
  it('returns everything appended while under the limit', () => {
    const buffer = new OutputTailBuffer(10);
    buffer.append('abc');
    buffer.append('def');
    expect(buffer.toString()).toBe('abcdef');
  });

  it('keeps exactly the last limit characters, matching a sliced string', () => {
    const limit = 50;
    const buffer = new OutputTailBuffer(limit);
    let expected = '';
    for (let i = 0; i < 200; i++) {
      const chunk = `chunk-${i};`.repeat((i % 7) + 1);
      buffer.append(chunk);
      expected = (expected + chunk).slice(-limit);
      expect(buffer.toString()).toBe(expected);
    }
  });

  it('keeps the tail of a single chunk larger than the limit', () => {
    const buffer = new OutputTailBuffer(4);
    buffer.append('0123456789');
    expect(buffer.toString()).toBe('6789');
  });

  it('bounds retained memory to about the limit plus one chunk', () => {
    const buffer = new OutputTailBuffer(100);
    for (let i = 0; i < 1000; i++) buffer.append('x'.repeat(30));
    expect(buffer.retainedLength).toBeLessThan(100 + 30);
  });

  it('releases dropped chunks immediately instead of holding them until compaction', () => {
    const buffer = new OutputTailBuffer(100);
    for (let i = 0; i < 10; i++) buffer.append('x'.repeat(150));
    // Inspect the backing array: dropped chunks must not stay referenced.
    const chunks = (buffer as unknown as { chunks: string[] }).chunks;
    const held = chunks.reduce((total, chunk) => total + chunk.length, 0);
    expect(held).toBe(150);
  });
});
