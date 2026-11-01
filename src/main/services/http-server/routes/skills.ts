import { readFileSync } from 'fs';
import { join } from 'path';

import { getKomlaBasePath } from '../../paths';
import { writeNotFound } from '../http-io';

import type http from 'http';

const SKILL_FILE_ALIASES: Readonly<Record<string, string>> = {
  // `komla skill komla` prints the Komla skill, for agents that install it themselves.
  'komla.md': 'komla/SKILL.md',
};

// Serves the loose skill instruction files from <komlaDir>/skills/ so agents
// can fetch them over loopback HTTP. Agents reliably fetch URLs but may fail
// to read absolute paths outside their workspace sandbox (e.g. Gemini CLI).
export function handleSkillFileRequest(url: string, res: http.ServerResponse): void {
  let name: string;
  try {
    name = decodeURIComponent((url.split('?')[0] ?? '').slice('/skills/'.length));
  } catch {
    // Malformed percent-encoding — treat as not found rather than letting the
    // URIError escape the request handler as an uncaught exception.
    writeNotFound(res);
    return;
  }
  // Flat markdown filename only — the regex rejects path separators, so there
  // is no way to traverse out of the skills directory.
  if (!/^[a-zA-Z0-9._-]+\.md$/.test(name)) {
    writeNotFound(res);
    return;
  }
  const filename = SKILL_FILE_ALIASES[name] ?? name;
  try {
    const content = readFileSync(join(getKomlaBasePath(), 'skills', filename), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    res.end(content);
  } catch {
    writeNotFound(res);
  }
}
