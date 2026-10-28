import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const preCommit = resolve('scripts/git-hooks/pre-commit');
const formatHook = resolve('scripts/format-edited-file.cjs');
const require = createRequire(import.meta.url);
const { installGitHooks } = require('../../../scripts/install-git-hooks.cjs') as {
  installGitHooks: (root: string) => void;
};
const { formatEditedFile } = require('../../../scripts/format-edited-file.cjs') as {
  formatEditedFile: (input: unknown, cwd: string) => string | null;
};

const FORMATTED = "export const a = 'a';\n";
const UNFORMATTED = 'export const a = "a"\n';

let repo: string;
const savedEnv = {
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};
// The repo's own global or system git config must not reach the test repos.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv }).trim();
}

function write(path: string, content: string): void {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function linkOxfmt(root = repo): void {
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(resolve('node_modules/.bin/oxfmt'), join(root, 'node_modules/.bin/oxfmt'));
  symlinkSync(resolve('node_modules/oxfmt'), join(root, 'node_modules/oxfmt'));
}

function read(path: string): string {
  return readFileSync(join(repo, path), 'utf8');
}

function edited(filePath: string): { tool_input: { file_path: string } } {
  return { tool_input: { file_path: filePath } };
}

function runPreCommit(): { status: number | null; output: string } {
  const result = spawnSync('sh', [preCommit], { cwd: repo, encoding: 'utf8', env: gitEnv });
  return { status: result.status, output: result.stdout + result.stderr };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'komla-format-hooks-'));
  git('init', '-q');
  copyFileSync(resolve('.oxfmtrc.json'), join(repo, '.oxfmtrc.json'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('pre-commit hook', () => {
  it('rejects a staged src/ file that is not formatted', () => {
    linkOxfmt();
    write('src/a.ts', UNFORMATTED);
    git('add', 'src/a.ts');

    const { status, output } = runPreCommit();

    expect(status).toBe(1);
    expect(output).toContain('src/a.ts');
    expect(output).toContain('npm run format');
  });

  it('accepts staged src/ files that are formatted', () => {
    linkOxfmt();
    write('src/a.ts', FORMATTED);
    write('src/nested/b.tsx', FORMATTED);
    git('add', 'src');

    expect(runPreCommit().status).toBe(0);
  });

  it('ignores files outside src/ and types the formatter does not check', () => {
    linkOxfmt();
    write('tests/a.ts', UNFORMATTED);
    write('src/notes.md', 'not   formatted\n');
    git('add', '.');

    expect(runPreCommit().status).toBe(0);
  });

  it('ignores unformatted src/ files that are not staged', () => {
    linkOxfmt();
    write('src/a.ts', FORMATTED);
    git('add', 'src/a.ts');
    write('src/b.ts', UNFORMATTED);

    expect(runPreCommit().status).toBe(0);
  });

  it('rejects unformatted staged contents when the file on disk is formatted', () => {
    linkOxfmt();
    write('src/a.ts', UNFORMATTED);
    git('add', 'src/a.ts');
    write('src/a.ts', FORMATTED);

    expect(runPreCommit().status).toBe(1);
  });

  it('accepts formatted staged contents when the file on disk is not', () => {
    linkOxfmt();
    write('src/a.ts', FORMATTED);
    git('add', 'src/a.ts');
    write('src/a.ts', UNFORMATTED);

    expect(runPreCommit().status).toBe(0);
  });

  it('checks a staged file that was deleted from disk afterwards', () => {
    linkOxfmt();
    write('src/a.ts', UNFORMATTED);
    git('add', 'src/a.ts');
    rmSync(join(repo, 'src/a.ts'));

    expect(runPreCommit().status).toBe(1);
  });

  it('checks the staged line endings whatever core.autocrlf says', () => {
    linkOxfmt();
    git('config', 'core.autocrlf', 'true');
    write('src/a.ts', FORMATTED);
    git('add', 'src/a.ts');

    expect(runPreCommit().status).toBe(0);
  });

  it('handles paths git would quote', () => {
    linkOxfmt();
    write('src/é and space.ts', FORMATTED);
    git('add', 'src');

    expect(runPreCommit().status).toBe(0);
  });

  it('allows a commit that deletes an unformatted file', () => {
    linkOxfmt();
    write('src/a.ts', UNFORMATTED);
    git('add', 'src/a.ts');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', 'a');
    git('rm', '-q', 'src/a.ts');

    expect(runPreCommit().status).toBe(0);
  });

  it('allows the commit when dependencies are not installed, and says so', () => {
    write('src/a.ts', UNFORMATTED);
    git('add', 'src/a.ts');

    const { status, output } = runPreCommit();

    expect(status).toBe(0);
    expect(output).toContain('skipped the format check');
  });
});

describe('installGitHooks', () => {
  beforeEach(() => {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("points git at the repo's hooks", () => {
    installGitHooks(repo);

    expect(git('config', 'core.hooksPath')).toBe('scripts/git-hooks');
  });

  it('keeps a hooks path someone already chose', () => {
    git('config', 'core.hooksPath', '.githooks');

    installGitHooks(repo);

    expect(git('config', 'core.hooksPath')).toBe('.githooks');
  });

  it('keeps hooks someone installed in .git/hooks working', () => {
    writeFileSync(join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\n');

    installGitHooks(repo);

    expect(() => git('config', 'core.hooksPath')).toThrow();
  });

  it('does nothing outside a git repository', () => {
    rmSync(join(repo, '.git'), { recursive: true });

    expect(() => installGitHooks(repo)).not.toThrow();
  });
});

describe('Claude Code format hook', () => {
  it('formats an edited src/ file', () => {
    linkOxfmt();
    write('src/a.ts', UNFORMATTED);

    // The filesystem root holding the repo: on Windows, '/' is the current drive's root.
    expect(formatEditedFile(edited(join(repo, 'src/a.ts')), parse(repo).root)).toBeNull();
    expect(read('src/a.ts')).toBe(FORMATTED);
  });

  it('resolves a relative path from the project directory', () => {
    linkOxfmt();
    write('src/main/a.ts', UNFORMATTED);

    expect(formatEditedFile(edited('src/main/a.ts'), repo)).toBeNull();
    expect(read('src/main/a.ts')).toBe(FORMATTED);
  });

  it("formats a nested worktree's file with that worktree's formatter", () => {
    const nested = join(repo, '.claude/worktrees/x');
    mkdirSync(nested, { recursive: true });
    copyFileSync(resolve('.oxfmtrc.json'), join(nested, '.oxfmtrc.json'));
    linkOxfmt(nested);
    write('.claude/worktrees/x/src/a.ts', UNFORMATTED);

    expect(formatEditedFile(edited(join(nested, 'src/a.ts')), repo)).toBeNull();
    expect(read('.claude/worktrees/x/src/a.ts')).toBe(FORMATTED);
  });

  it('leaves files outside src/ and other file types alone', () => {
    linkOxfmt();
    write('tests/a.ts', UNFORMATTED);
    write('src/notes.md', UNFORMATTED);

    expect(formatEditedFile(edited(join(repo, 'tests/a.ts')), repo)).toBeNull();
    expect(formatEditedFile(edited(join(repo, 'src/notes.md')), repo)).toBeNull();
    expect(formatEditedFile({ tool_input: {} }, repo)).toBeNull();
    expect(read('tests/a.ts')).toBe(UNFORMATTED);
  });

  it('formats a file reached through a symlink to the project', () => {
    linkOxfmt();
    write('src/a.ts', UNFORMATTED);
    const link = `${repo}-link`;
    symlinkSync(repo, link);
    try {
      expect(formatEditedFile(edited(join(repo, 'src/a.ts')), link)).toBeNull();
    } finally {
      rmSync(link);
    }
    expect(read('src/a.ts')).toBe(FORMATTED);
  });

  it('leaves files outside the project alone', () => {
    linkOxfmt();
    write('src/a.ts', UNFORMATTED);

    expect(formatEditedFile(edited(join(repo, 'src/a.ts')), join(repo, 'src/other'))).toBeNull();
    expect(read('src/a.ts')).toBe(UNFORMATTED);
  });

  it('tells the agent when dependencies are not installed', () => {
    write('src/a.ts', UNFORMATTED);

    expect(formatEditedFile(edited(join(repo, 'src/a.ts')), repo)).toContain('npm run format');
  });

  it("tells the agent when the formatter can't parse the file", () => {
    linkOxfmt();
    write('src/a.ts', 'export const = ;\n');

    expect(formatEditedFile(edited(join(repo, 'src/a.ts')), repo)).toContain(
      `oxfmt couldn't format ${join('src', 'a.ts')}`
    );
  });

  it('exits 2 with the message so Claude Code shows it to the agent', () => {
    write('src/a.ts', UNFORMATTED);

    const result = spawnSync(process.execPath, [formatHook], {
      input: JSON.stringify(edited('src/a.ts')),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`Couldn't format ${join('src', 'a.ts')}`);
  });

  it('exits 0 after formatting', () => {
    linkOxfmt();
    write('src/a.ts', UNFORMATTED);

    const result = spawnSync(process.execPath, [formatHook], {
      input: JSON.stringify(edited('src/a.ts')),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    });

    expect(result.status).toBe(0);
    expect(read('src/a.ts')).toBe(FORMATTED);
  });

  it('runs from the command in .claude/settings.json', () => {
    const settings = JSON.parse(readFileSync(resolve('.claude/settings.json'), 'utf8')) as {
      hooks: { PostToolUse: { hooks: { command: string }[] }[] };
    };
    const command = settings.hooks.PostToolUse[0].hooks[0].command;
    mkdirSync(join(repo, 'scripts'));
    copyFileSync(formatHook, join(repo, 'scripts/format-edited-file.cjs'));
    linkOxfmt();
    write('src/a.ts', UNFORMATTED);

    const result = spawnSync('bash', ['-c', command], {
      input: JSON.stringify(edited(join(repo, 'src/a.ts'))),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    });

    expect(result.status).toBe(0);
    expect(read('src/a.ts')).toBe(FORMATTED);
  });
});
