import { z } from 'zod';

import { NOTE_NAME_PATTERN, NOTES_SCOPE_PATTERN } from '../../lib/notes';

import { safeStringSchema } from './primitives';

const scopeIdSchema = z.string().regex(NOTES_SCOPE_PATTERN, 'must be a workspace id');
const noteNameSchema = z.string().regex(NOTE_NAME_PATTERN, 'must be a note file name');
// Rich text is only offered up to 300 KB; leave room for notes edited as source.
const noteContentSchema = safeStringSchema.refine((value) => value.length <= 5_000_000, {
  message: 'note is too large',
});

export const notesScopeArgsSchema = z.tuple([scopeIdSchema]);
/** A workspace, and the text a new note starts with, such as a prompt draft saved as one. */
export const noteCreateArgsSchema = z.tuple([scopeIdSchema, noteContentSchema.optional()]);
export const noteArgsSchema = z.tuple([scopeIdSchema, noteNameSchema]);
export const noteDeleteArgsSchema = z.tuple([scopeIdSchema, noteNameSchema, z.boolean()]);
export const noteWriteArgsSchema = z.tuple([scopeIdSchema, noteNameSchema, noteContentSchema]);
