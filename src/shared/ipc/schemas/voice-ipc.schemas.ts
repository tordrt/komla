import { z } from 'zod';

import { idSchema } from './primitives';

// Whole 32-bit samples. Checked by tag, as instanceof fails for a buffer from another realm.
const sampleBufferSchema = z.custom<ArrayBuffer>(
  (value) =>
    Object.prototype.toString.call(value) === '[object ArrayBuffer]' &&
    (value as ArrayBuffer).byteLength % Float32Array.BYTES_PER_ELEMENT === 0,
  { message: 'must be an ArrayBuffer of 32-bit samples' }
);

export const voiceModelIdArgsSchema = z.tuple([idSchema]);
export const voiceModelDeleteArgsSchema = z.tuple([idSchema.optional()]);
export const voiceTranscribeArgsSchema = z.tuple([
  z.strictObject({ samples: sampleBufferSchema, requestId: idSchema.optional() }),
]);
export const voiceTranscribeCancelArgsSchema = z.tuple([idSchema]);
export const voiceRecordingStateArgsSchema = z.tuple([z.boolean()]);
