import { z } from 'zod';

import { PROMPT_DRAFT_MAX_LENGTH } from '../../types/prompt-draft-window';

import { idSchema } from './primitives';

const textSchema = z.string().max(PROMPT_DRAFT_MAX_LENGTH);
const offsetSchema = z.number().int().min(0).max(PROMPT_DRAFT_MAX_LENGTH);

const draftSchema = z
  .object({ text: textSchema, selectionStart: offsetSchema, selectionEnd: offsetSchema })
  .strip();

const lengthSchema = z.number().finite().min(-100_000).max(100_000);
const sizeSchema = z.number().finite().positive().max(100_000);

export const promptDraftPopOutArgsSchema = z.tuple([
  draftSchema,
  z.object({ x: lengthSchema, y: lengthSchema, width: sizeSchema, height: sizeSchema }).strip(),
]);

export const promptDraftContextArgsSchema = z.tuple([
  z
    .object({
      theme: z.object({ className: z.string().max(1_000), style: z.string().max(50_000) }).strip(),
      workspaceId: idSchema.nullable(),
      viewedFileName: z.string().max(1_000).nullable(),
    })
    .strip(),
]);

export const promptDraftReferenceArgsSchema = z.tuple([z.string().max(10_000).nullable()]);

export const promptDraftNoteSavedArgsSchema = z.tuple([z.boolean()]);

export const promptDraftWindowDraftArgsSchema = z.tuple([draftSchema]);

export const promptDraftWindowSaveAsNoteArgsSchema = z.tuple([textSchema]);

export const promptDraftWindowCloseArgsSchema = z.tuple([
  z.object({ copied: z.boolean() }).strip(),
]);
