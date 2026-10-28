import { z } from 'zod';

export const nonEmptyStringSchema = z.string().trim().min(1);
export const idSchema = z.string().trim().min(1).max(256);
// Git's branch name rules that matter here: no revision syntax, ranges or leading dash.
export const BRANCH_NAME_PATTERN =
  /^(?![-/])(?!.*(?:\.\.|@\{|\/\/|\.lock$|\/$))[^\x00-\x20~^:?*[\\\x7f]+$/;

export const safeStringSchema = z.string().refine((value) => !value.includes('\0'), {
  message: 'must not contain null bytes',
});

export const safePathSchema = z
  .string()
  .max(4096)
  .transform((value) => value.trim())
  .refine((value) => !value.includes('\0'), { message: 'must not contain null bytes' })
  .refine((value) => value.length > 0, { message: 'path must not be empty' });

export const untrimmedSafePathSchema = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0'), { message: 'must not contain null bytes' })
  .refine((value) => value.trim().length > 0, { message: 'path must not be empty' });

export const optionalNullableStringSchema = z.string().optional().nullable();
export const optionalBooleanSchema = z.boolean().optional();

export const layoutHintSchema = z.enum(['tab', 'split-right', 'split-bottom']);

export const workspaceModeSchema = z.enum(['worktree', 'directory']);

export const terminalStatusSchema = z.enum(['starting', 'running', 'stopped']);

export const fileStatusSchema = z.enum(['added', 'modified', 'deleted', 'renamed', 'untracked']);
