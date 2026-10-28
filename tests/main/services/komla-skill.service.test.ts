import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ home: '', data: '' }));

vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  homedir: () => dirs.home,
}));

vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: () => dirs.data,
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { komlaSkillService } from '../../../src/main/services/komla-skill.service';

const BUNDLED = readFileSync(join(process.cwd(), 'resources', 'skills', 'komla', 'SKILL.md'), 'utf-8');

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe('komlaSkillService', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'komla-skill-'));
    dirs.home = join(root, 'home');
    dirs.data = join(root, 'data');
    write(join(dirs.data, 'skills', 'komla', 'SKILL.md'), BUNDLED);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const claude = () => join(dirs.home, '.claude', 'skills', 'komla', 'SKILL.md');
  const agents = () => join(dirs.home, '.agents', 'skills', 'komla', 'SKILL.md');
  const antigravity = () => join(dirs.home, '.gemini', 'config', 'skills', 'komla', 'SKILL.md');

  it('adds and removes the skill in the folders Claude Code and other agents read', () => {
    expect(komlaSkillService.getStatus()).toEqual({
      isConfigured: false,
      paths: [claude(), agents()],
    });

    komlaSkillService.enable();

    expect(readFileSync(claude(), 'utf-8')).toBe(BUNDLED);
    expect(readFileSync(agents(), 'utf-8')).toBe(BUNDLED);
    expect(existsSync(join(dirs.home, '.gemini'))).toBe(false);
    expect(komlaSkillService.getStatus().isConfigured).toBe(true);

    komlaSkillService.disable();

    expect(existsSync(dirname(claude()))).toBe(false);
    expect(existsSync(dirname(agents()))).toBe(false);
    expect(komlaSkillService.getStatus().isConfigured).toBe(false);
  });

  it("adds it to Antigravity CLI's folder where ~/.gemini exists", () => {
    mkdirSync(join(dirs.home, '.gemini'), { recursive: true });

    expect(komlaSkillService.getStatus().paths).toEqual([claude(), agents(), antigravity()]);
    komlaSkillService.enable();
    expect(readFileSync(antigravity(), 'utf-8')).toBe(BUNDLED);

    komlaSkillService.disable();
    expect(existsSync(dirname(antigravity()))).toBe(false);
  });

  it("leaves a skill folder alone that isn't Komla's", () => {
    write(claude(), '---\nname: my-komla-notes\ndescription: Mine\n---\n');

    expect(komlaSkillService.getStatus().isConfigured).toBe(false);
    komlaSkillService.disable();

    expect(existsSync(claude())).toBe(true);
  });

  it('while on, brings every copy up to date and fills in missing ones', () => {
    write(claude(), '---\nname: komla\ndescription: An older Komla skill\n---\n');
    mkdirSync(join(dirs.home, '.gemini'), { recursive: true });

    komlaSkillService.refreshInstalled();

    expect(readFileSync(claude(), 'utf-8')).toBe(BUNDLED);
    expect(readFileSync(agents(), 'utf-8')).toBe(BUNDLED);
    expect(readFileSync(antigravity(), 'utf-8')).toBe(BUNDLED);
  });

  it('installs nothing on its own while off', () => {
    komlaSkillService.refreshInstalled();

    expect(existsSync(join(dirs.home, '.claude'))).toBe(false);
    expect(existsSync(join(dirs.home, '.agents'))).toBe(false);
  });

  it("refreshes around a user's own skill named komla", () => {
    const mine = '---\nname: my-komla-notes\ndescription: Mine\n---\n';
    write(claude(), mine);
    write(agents(), '---\nname: komla\ndescription: An older Komla skill\n---\n');

    komlaSkillService.refreshInstalled();

    expect(readFileSync(claude(), 'utf-8')).toBe(mine);
    expect(readFileSync(agents(), 'utf-8')).toBe(BUNDLED);
  });
});
