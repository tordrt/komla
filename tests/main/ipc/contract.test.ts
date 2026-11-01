import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ipcContract } from '../../../src/shared/ipc/contract';

const CONTRACT_DIR = join(__dirname, '../../../src/shared/ipc/contract');
const contractFiles = readdirSync(CONTRACT_DIR).filter((file) => file.endsWith('.contract.ts'));

async function loadDomainContracts(): Promise<Record<string, unknown>[]> {
  return Promise.all(
    contractFiles.map(async (file) => {
      const module = (await import(join(CONTRACT_DIR, file))) as Record<string, object>;
      return Object.values(module)[0] as Record<string, unknown>;
    })
  );
}

describe('IPC contract', () => {
  it('merges every domain, with no channel defined twice', async () => {
    const channels = (await loadDomainContracts()).flatMap((domain) => Object.keys(domain));

    expect(new Set(channels).size).toBe(channels.length);
    expect(Object.keys(ipcContract).sort()).toEqual([...channels].sort());
  });

  it('gives every channel a schema that parses an argument list', () => {
    for (const [channel, definition] of Object.entries(ipcContract)) {
      expect(definition.args, channel).toBeInstanceOf(z.ZodType);
      expect(['invoke', 'send', 'sync'], channel).toContain(definition.kind);
    }
  });

  // The preload is sandboxed and zod isn't bundled into it, so a runtime import of a schema
  // would stop it loading, and every window with it.
  it('stays out of the preload at runtime', () => {
    const preload = readFileSync(join(__dirname, '../../../src/preload/index.ts'), 'utf8');
    const runtimeImports = [...preload.matchAll(/^import (?!type )[\s\S]*?from '([^']+)';$/gm)].map(
      (match) => match[1]
    );

    expect(runtimeImports.sort()).toEqual(['../shared/constants/ipc-channels', 'electron']);
  });
});
