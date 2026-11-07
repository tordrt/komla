import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addToShellHistoryCommand } from '../../../src/main/lib/shell-history';

function findShell(name: string): string | null {
  if (process.platform === 'win32') return null;
  const result = spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

const bash = findShell('bash');
const zsh = findShell('zsh');

// What a user's rc file would have set up before Komla's startup script runs.
const SHELLS = [
  {
    name: 'bash',
    path: bash,
    args: ['--norc', '--noprofile', '-i', '-c'],
    setup: (file: string) => `HISTFILE='${file}'`,
    noSaving: ['unset HISTFILE', 'set +o history', 'HISTFILESIZE=0'],
  },
  {
    name: 'zsh',
    path: zsh,
    args: ['-f', '-i', '-c'],
    setup: (file: string) => `HISTFILE='${file}'; SAVEHIST=100`,
    noSaving: ['unset HISTFILE', 'SAVEHIST=0'],
  },
];

describe('addToShellHistoryCommand', () => {
  let dir: string;
  let historyFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'komla-shell-history-'));
    historyFile = join(dir, 'history');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (shell: (typeof SHELLS)[number], script: string) =>
    spawnSync(shell.path!, [...shell.args, script], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: dir, TERM: 'dumb' },
    });

  for (const shell of SHELLS) {
    describe(shell.name, () => {
      it.skipIf(!shell.path)('saves the command to the history file exactly as typed', () => {
        const command = `npm run dev:fresh -- --name "it's" 'a\\nb'`;
        const record = addToShellHistoryCommand(shell.path!, command)!;

        const result = run(shell, `${shell.setup(historyFile)}; ${record}`);

        expect(result.status).toBe(0);
        expect(readFileSync(historyFile, 'utf8')).toBe(`${command}\n`);
      });

      for (const noSaving of shell.noSaving) {
        it.skipIf(!shell.path)(`leaves the history alone after \`${noSaving}\``, () => {
          const record = addToShellHistoryCommand(shell.path!, 'npm test')!;

          const result = run(
            shell,
            `${shell.setup(historyFile)}; ${noSaving}; ${record}; echo next`
          );

          expect(existsSync(historyFile)).toBe(false);
          expect(result.stdout).toBe('next\n');
          expect(result.stderr).not.toMatch(/history|fc|print/);
        });
      }
    });
  }

  it('skips shells whose history it does not know', () => {
    expect(addToShellHistoryCommand('/usr/local/bin/fish', 'npm test')).toBeNull();
    expect(addToShellHistoryCommand('/bin/sh', 'npm test')).toBeNull();
  });
});
