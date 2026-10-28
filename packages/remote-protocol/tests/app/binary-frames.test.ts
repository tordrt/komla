import { describe, expect, it } from 'vitest';

import {
  binaryTerminalOutputOverhead,
  decodeBinaryAppFrame,
  encodeBinaryTerminalInput,
  encodeBinaryTerminalOutput,
} from '../../src/app/binary-frames';

describe('binary terminal frames', () => {
  it('round-trips terminal output, including a split read', () => {
    const output = { terminalId: 'term-1', generation: 3, seq: 2 ** 40 + 5, data: '漢\x1b[31m😀' };

    expect(decodeBinaryAppFrame(encodeBinaryTerminalOutput(output))).toEqual({
      type: 'app:terminal:data',
      ...output,
    });
    expect(decodeBinaryAppFrame(encodeBinaryTerminalOutput({ ...output, more: true }))).toEqual({
      type: 'app:terminal:data',
      ...output,
      more: true,
    });
  });

  it('round-trips terminal input', () => {
    expect(
      decodeBinaryAppFrame(encodeBinaryTerminalInput({ terminalId: 'term-1', data: 'ls\r' }))
    ).toEqual({ type: 'app:terminal:input', terminalId: 'term-1', data: 'ls\r' });
  });

  it('keeps a keystroke echo to a few bytes around its data', () => {
    const id = '0c1f6a3e-2b47-4b8e-9d55-6f4e3a2b1c0d';
    const frame = encodeBinaryTerminalOutput({ terminalId: id, generation: 1, seq: 9, data: 'x' });

    expect(frame.length).toBe(binaryTerminalOutputOverhead(id) + 1);
    expect(frame.length).toBe(52);
  });

  it('rejects malformed frames', () => {
    const good = encodeBinaryTerminalOutput({ terminalId: 't', generation: 1, seq: 1, data: 'a' });
    const withFlags = good.slice();
    withFlags[1] = 0x80;
    const zeroGeneration = encodeBinaryTerminalOutput({
      terminalId: 't',
      generation: 1,
      seq: 1,
      data: 'a',
    });
    zeroGeneration.set([0, 0, 0, 0], 2);
    const badUtf8 = new Uint8Array([
      ...encodeBinaryTerminalInput({ terminalId: 't', data: '' }),
      0xff,
    ]);
    const shortId = encodeBinaryTerminalInput({ terminalId: 'abc', data: '' });
    shortId[1] = 10;

    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([0x03, 0]),
      good.slice(0, 10),
      withFlags,
      zeroGeneration,
      badUtf8,
      shortId,
      new Uint8Array([0x02, 0]),
    ]) {
      expect(decodeBinaryAppFrame(bytes)).toBeNull();
    }
    expect(() => encodeBinaryTerminalInput({ terminalId: '', data: '' })).toThrow();
  });
});
