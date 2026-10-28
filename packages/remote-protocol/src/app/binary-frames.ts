// Binary payloads for the two frames that carry terminal bytes, sent instead of their JSON form
// once both peers list the binary-frames capability. A keystroke's echo then takes tens of bytes on
// the wire instead of hundreds, and output no longer pays for JSON escaping and base64.
//
//   terminal output: [ 0x01 | flags (bit 0: more) | generation u32 | seq u64 | id length u8 | id | data ]
//   terminal input:  [ 0x02 | id length u8 | id | data ]
//
// Integers are big-endian. `id` is the terminal id in UTF-8; `data` is UTF-8 and runs to the end.

const TERMINAL_OUTPUT = 0x01;
const TERMINAL_INPUT = 0x02;
const MORE = 0x01;
const MAX_ID_BYTES = 128;
// Like the JSON frames' ids.
const isId = (id: string | null): id is string => !!id && id.length <= 128;

export interface BinaryTerminalOutput {
  type: 'app:terminal:data';
  terminalId: string;
  generation: number;
  seq: number;
  data: string;
  more?: true;
}

export interface BinaryTerminalInput {
  type: 'app:terminal:input';
  terminalId: string;
  data: string;
}

export type BinaryAppFrame = BinaryTerminalOutput | BinaryTerminalInput;

const encoder = new TextEncoder();

/** Bytes a binary terminal output frame adds around its data for this terminal. */
export function binaryTerminalOutputOverhead(terminalId: string): number {
  return 1 + 1 + 4 + 8 + 1 + encoder.encode(terminalId).length;
}

function encodeId(terminalId: string): Uint8Array {
  const id = encoder.encode(terminalId);
  if (id.length === 0 || id.length > MAX_ID_BYTES) {
    throw new RangeError(`terminal id must be 1-${MAX_ID_BYTES} bytes`);
  }
  return id;
}

export function encodeBinaryTerminalOutput(frame: Omit<BinaryTerminalOutput, 'type'>): Uint8Array {
  const id = encodeId(frame.terminalId);
  const data = encoder.encode(frame.data);
  const out = new Uint8Array(15 + id.length + data.length);
  const view = new DataView(out.buffer);
  out[0] = TERMINAL_OUTPUT;
  out[1] = frame.more ? MORE : 0;
  view.setUint32(2, frame.generation);
  view.setBigUint64(6, BigInt(frame.seq));
  out[14] = id.length;
  out.set(id, 15);
  out.set(data, 15 + id.length);
  return out;
}

export function encodeBinaryTerminalInput(frame: Omit<BinaryTerminalInput, 'type'>): Uint8Array {
  const id = encodeId(frame.terminalId);
  const data = encoder.encode(frame.data);
  const out = new Uint8Array(2 + id.length + data.length);
  out[0] = TERMINAL_INPUT;
  out[1] = id.length;
  out.set(id, 2);
  out.set(data, 2 + id.length);
  return out;
}

/** Null for anything malformed: an unknown kind, a bad id, or invalid UTF-8. */
export function decodeBinaryAppFrame(bytes: Uint8Array): BinaryAppFrame | null {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (from: number, to: number): string | null => {
    try {
      return decoder.decode(bytes.subarray(from, to));
    } catch {
      return null;
    }
  };
  if (bytes[0] === TERMINAL_OUTPUT && bytes.length >= 15) {
    const flags = bytes[1]!;
    const idEnd = 15 + bytes[14]!;
    const seq = view.getBigUint64(6);
    if (flags & ~MORE || idEnd > bytes.length || seq > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    const generation = view.getUint32(2);
    const terminalId = text(15, idEnd);
    const data = text(idEnd, bytes.length);
    if (generation < 1 || !isId(terminalId) || data === null) {
      return null;
    }
    return {
      type: 'app:terminal:data',
      terminalId,
      generation,
      seq: Number(seq),
      data,
      ...(flags & MORE ? { more: true as const } : {}),
    };
  }
  if (bytes[0] === TERMINAL_INPUT && bytes.length >= 2) {
    const idEnd = 2 + bytes[1]!;
    if (idEnd > bytes.length) return null;
    const terminalId = text(2, idEnd);
    const data = text(idEnd, bytes.length);
    if (!isId(terminalId) || data === null) return null;
    return { type: 'app:terminal:input', terminalId, data };
  }
  return null;
}
