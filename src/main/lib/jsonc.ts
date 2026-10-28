/**
 * Parse JSONC (JSON with Comments) by stripping single-line (//) and
 * multi-line comments before passing to JSON.parse. Respects strings —
 * comment-like sequences inside quoted values are left alone.
 */
export function parseJsonc<T = unknown>(text: string): T {
  let result = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] === '"') {
      const end = scanStringEnd(text, i);
      result += text.slice(i, end);
      i = end;
      continue;
    }

    if (text[i] === '/' && text[i + 1] === '/') {
      i = scanLineCommentEnd(text, i);
      continue;
    }

    if (text[i] === '/' && text[i + 1] === '*') {
      i = scanBlockCommentEnd(text, i);
      continue;
    }

    result += text[i];
    i++;
  }

  return JSON.parse(result) as T;
}

function scanStringEnd(text: string, start: number): number {
  let i = start + 1; // skip opening quote
  while (i < text.length && text[i] !== '"') {
    if (text[i] === '\\') i++; // skip escaped char
    i++;
  }
  return i + 1; // skip closing quote
}

function scanLineCommentEnd(text: string, start: number): number {
  let i = start + 2;
  while (i < text.length && text[i] !== '\n') i++;
  return i;
}

function scanBlockCommentEnd(text: string, start: number): number {
  let i = start + 2;
  while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
  return i + 2; // skip closing */
}
