import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

// Terminal Execution State is stored as three Terminal fields that only
// src/shared/lib/terminal-execution-state.ts may read. Everyone else asks its questions.
// The exceptions are the field declarations, the workspaces.json format, and the
// lifecycle's own checks that nothing changed while it waited on the host.
const ALLOWED: Record<string, number> = {
  'shared/lib/terminal-execution-state.ts': 26,
  'shared/types/terminal.ts': 3,
  'main/services/workspace.service.ts': 3,
  'main/services/managed-remote-terminal-lifecycle/lifecycle.ts': 5,
};

// Vitest runs with cwd at the repo root.
const SOURCE_FILES = readdirSync('src', { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.tsx?$/.test(file))
  .map((file) => file.split('\\').join('/'));

function countIn(file: string, pattern: RegExp): number {
  return readFileSync(join('src', file), 'utf8').match(pattern)?.length ?? 0;
}

describe('Terminal Execution State ownership', () => {
  it('keeps reads of the stored fields inside the module', () => {
    const counts: Record<string, number> = {};
    for (const file of SOURCE_FILES) {
      const count = countIn(file, /\bremoteSession(?:Active|Resumable|OnHost)\b/g);
      if (count > 0) counts[file] = count;
    }
    expect(counts).toEqual(ALLOWED);
  });

  it('lets only the lifecycle registry write its state', () => {
    const writers = SOURCE_FILES.filter(
      (file) =>
        file !== 'shared/lib/terminal-execution-state.ts' && countIn(file, /kind: 'managed',\s+attachment:/g) > 0
    );
    expect(writers).toEqual(['main/services/managed-remote-terminal-lifecycle/registry.ts']);
  });
});
