import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

// Workspace Provision State is stored as four Workspace fields that only
// src/shared/lib/workspace-provision-state.ts may read or write. Everyone else asks its
// questions and assigns what it encodes. The exceptions are the field declarations: on
// Workspace, in the workspaces.json format, and in the part of a workspace an operation sees.
const ALLOWED: Record<string, number> = {
  'shared/types/workspace.ts': 4,
  'main/services/workspace/persisted-workspace.ts': 2,
  'main/services/komla-operation/operation.ts': 1,
};

// Vitest runs with cwd at the repo root.
const SOURCE_FILES = readdirSync('src', { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.tsx?$/.test(file))
  .map((file) => file.split('\\').join('/'));

// `provisioning` is also an ordinary word, so only count it as a stored field: a property
// read (not `deps.provisioning.finish()`), a key set to a boolean, or a field declaration.
const STORED_FIELDS =
  /\bprovision(?:Status|Error|ErrorReason)\b|\.provisioning\b(?!\s*\.)|\bprovisioning\??: (?:true|false|boolean)\b/g;

function countIn(file: string): number {
  return readFileSync(join('src', file), 'utf8').match(STORED_FIELDS)?.length ?? 0;
}

describe('Workspace Provision State ownership', () => {
  it('keeps the stored fields inside the module', () => {
    const counts: Record<string, number> = {};
    for (const file of SOURCE_FILES) {
      const count = countIn(file);
      if (count > 0) counts[file] = count;
    }
    const { 'shared/lib/workspace-provision-state.ts': module, ...others } = counts;
    expect(module).toBeGreaterThan(0);
    expect(others).toEqual(ALLOWED);
  });
});
