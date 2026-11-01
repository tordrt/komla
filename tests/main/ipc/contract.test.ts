import { readdirSync, readFileSync } from 'fs';
import { join, sep } from 'path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { IPC } from '../../../src/shared/constants/ipc-channels';
import { ipcContract } from '../../../src/shared/ipc/contract';

const SRC_DIR = join(__dirname, '../../../src');
const CONTRACT_DIR = join(SRC_DIR, 'shared/ipc/contract');
const contractFiles = readdirSync(CONTRACT_DIR).filter((file) => file.endsWith('.contract.ts'));

async function loadDomainContracts(): Promise<Record<string, unknown>[]> {
  return Promise.all(
    contractFiles.map(async (file) => {
      const module = (await import(join(CONTRACT_DIR, file))) as Record<string, object>;
      return Object.values(module)[0] as Record<string, unknown>;
    })
  );
}

function readMainSources(): { file: string; source: string }[] {
  return readdirSync(join(SRC_DIR, 'main'), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.type-test.ts'))
    .map((file) => ({
      file: file.split(sep).join('/'),
      source: readFileSync(join(SRC_DIR, 'main', file), 'utf8'),
    }));
}

/** The channels a source passes to any of these functions, as `name(IPC.CHANNEL`. */
function channelsPassedTo(source: string, functions: string[]): string[] {
  const pattern = new RegExp(`\\b(?:${functions.join('|')})\\(\\s*IPC\\.(\\w+)`, 'g');
  return [...source.matchAll(pattern)].map((match) => IPC[match[1] as keyof typeof IPC]);
}

function contractChannels(...kinds: string[]): string[] {
  return Object.entries(ipcContract)
    .filter(([, definition]) => kinds.includes(definition.kind))
    .map(([channel]) => channel)
    .sort();
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

  it('gives every channel exactly one handler in main, of its kind', () => {
    const sources = readMainSources().map(({ source }) => source);
    const registered = (...functions: string[]): string[] =>
      sources.flatMap((source) => channelsPassedTo(source, functions)).sort();

    expect(registered('handleIpc')).toEqual(contractChannels('invoke'));
    expect(registered('onIpc')).toEqual(contractChannels('send'));
    expect(registered('onIpcSync')).toEqual(contractChannels('sync'));
  });

  it('gives every channel a caller in the preload', () => {
    const preload = readFileSync(join(SRC_DIR, 'preload/index.ts'), 'utf8');
    const called = new Set(
      channelsPassedTo(preload, ['ipcRenderer\\.invoke', 'ipcRenderer\\.send', 'ipcRenderer\\.sendSync'])
    );

    expect(contractChannels('invoke', 'send', 'sync').filter((c) => !called.has(c))).toEqual([]);
  });

  // ipcMain.handle takes any channel and any handler, so going around the contract would compile.
  it('is the only way to register a renderer-to-main channel', () => {
    const rawRegistrations = readMainSources()
      .filter(({ source }) => /\bipcMain\.(?:handle|handleOnce|on|once)\(/.test(source))
      .map(({ file }) => file)
      .sort();

    expect(rawRegistrations).toEqual(['ipc/validation/ipc-validators.ts']);
  });
});
