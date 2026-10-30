import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

import type { z } from 'zod';

/**
 * Reads a settings file Komla follows, writing its empty form first when it doesn't exist, so
 * agents and people find it beside the other settings.
 */
export function readSettingsFile(path: string, emptyContent: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, emptyContent, 'utf-8');
  }
  return readFileSync(path, 'utf-8');
}

/**
 * Reads a settings file's JSON against its schema, with `raw`, the JSON as the file has it; a
 * problem names what is wrong with it.
 */
export function parseSettingsFile<Schema extends z.ZodType>(
  fileName: string,
  content: string,
  schema: Schema
): { value: z.infer<Schema>; raw: unknown } | { problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(content.replace(/^﻿/, ''));
  } catch (error) {
    return {
      problem: `${fileName} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return { problem: `${fileName} ${path}${issue.message}` };
  }
  return { value: parsed.data, raw };
}
