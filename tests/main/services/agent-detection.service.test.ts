import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn, mockBuildTerminalEnv, mockGetShell, mockIsWslMode } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockBuildTerminalEnv: vi.fn(),
  mockGetShell: vi.fn(() => '/bin/zsh'),
  mockIsWslMode: vi.fn(() => false),
}));

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: mockSpawn,
}));
vi.mock('../../../src/main/lib/shell', () => ({
  buildTerminalEnv: mockBuildTerminalEnv,
  getShell: mockGetShell,
}));
vi.mock('../../../src/main/lib/wsl', () => ({
  isWslMode: mockIsWslMode,
  getWslShellArgs: (distro?: string) => (distro ? ['-d', distro] : []),
}));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: () => ({ wslDistro: 'Ubuntu' }) },
}));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  buildProbeScript,
  detectInstalledAgents,
  findOnPath,
  isLookalike,
  parseProbeOutput,
  templateExecutable,
} from '../../../src/main/services/agent-detection.service';

const templates = [
  { name: 'Claude Code', openCommand: 'claude {{launchMode}}' },
  { name: 'Codex', openCommand: 'codex {{launchMode}}' },
  { name: 'Hermes Agent', openCommand: 'hermes chat {{launchMode}}' },
  { name: 'Shell Only', openCommand: '' },
  { name: 'Custom', openCommand: '' },
];

// Answers the probe shell with the given output, like a shell that resolved those commands.
function shellPrints(stdout: string, exitCode = 0) {
  mockSpawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter() });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(stdout));
      child.emit('close', exitCode, null);
    });
    return child;
  });
}

describe('templateExecutable', () => {
  it('takes the program a template launches', () => {
    expect(templateExecutable('claude {{launchMode}}')).toBe('claude');
    expect(templateExecutable('  hermes chat {{launchMode}}')).toBe('hermes');
    expect(templateExecutable('kiro-cli chat')).toBe('kiro-cli');
  });

  it('leaves out templates without a program, or one unsafe in a shell script', () => {
    expect(templateExecutable('')).toBeNull();
    expect(templateExecutable('claude;rm -rf ~')).toBeNull();
    expect(templateExecutable('$(whoami)')).toBeNull();
    expect(templateExecutable('{{launchMode}}')).toBeNull();
  });
});

describe('parseProbeOutput', () => {
  it('finds the markers among whatever rc files print', () => {
    const stdout = [
      'Welcome back!',
      '\u001b[1m__komla_agent_found__ claude',
      '__komla_agent_found__ codex',
      '__komla_agent_found__ unrequested',
    ].join('\n');

    expect(parseProbeOutput(stdout, ['claude', 'codex', 'hermes'])).toEqual(
      new Set(['claude', 'codex'])
    );
  });

  it('leaves out a goose that is the database migration tool', () => {
    const stdout = [
      '__komla_agent_found__ claude',
      '__komla_agent_found__ goose',
      'goose version: v3.28.0',
    ].join('\n');

    expect(parseProbeOutput(stdout, ['claude', 'goose'])).toEqual(new Set(['claude']));
  });
});

describe('isLookalike', () => {
  it("tells pressly/goose from Block's goose by its version output", () => {
    expect(isLookalike('goose', 'goose version: v3.28.0\n')).toBe(true);
    expect(isLookalike('goose', ' 1.54.0\n')).toBe(false);
    expect(isLookalike('claude', 'goose version: v3.28.0\n')).toBe(false);
  });

  it('tells the AWS Copilot CLI and the Amp text editor from the agents', () => {
    expect(isLookalike('copilot', 'copilot version: v1.34.0\n')).toBe(true);
    expect(
      isLookalike(
        'copilot',
        "GitHub Copilot CLI 1.0.98.\nRun 'copilot update' to check for updates.\n"
      )
    ).toBe(false);
    // The editor has no --version, and fails to open a terminal from the probe.
    expect(isLookalike('amp', 'error: Failed to initialize terminal\ncaused by: …\n')).toBe(true);
    expect(isLookalike('amp', '0.0.1792094445-g3475f5 (released 2026-10-15T20:00:45.000Z)\n')).toBe(
      false
    );
    // Without a shell, Windows can't run npm's shims, so an agent that printed nothing stays.
    expect(isLookalike('amp', '')).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('buildProbeScript in real shells', () => {
  let binDir: string;

  function fakeExecutable(name: string, script: string) {
    const fake = join(binDir, name);
    writeFileSync(fake, `#!/bin/sh\n${script}\n`);
    chmodSync(fake, 0o755);
  }

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), 'komla-agent-probe-'));
    fakeExecutable('claude', 'exit 0');
  });

  afterEach(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it.each(['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh', '/usr/bin/fish'].filter(existsSync))(
    'prints a marker only for the executables %s resolves',
    (shell) => {
      const script = buildProbeScript(['codex', 'claude', 'not-an-agent-xyz']);
      const stdout = execFileSync(shell, ['-c', script], {
        env: { PATH: `${binDir}:/usr/bin:/bin` },
        encoding: 'utf8',
      });

      expect(parseProbeOutput(stdout, ['codex', 'claude', 'not-an-agent-xyz'])).toEqual(
        new Set(['claude'])
      );
    }
  );

  it.each(['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh', '/usr/bin/fish'].filter(existsSync))(
    "finds Block's goose but not the migration tool in %s",
    (shell) => {
      const run = () =>
        execFileSync(shell, ['-c', buildProbeScript(['goose', 'claude'])], {
          env: { PATH: `${binDir}:/usr/bin:/bin` },
          encoding: 'utf8',
        });

      fakeExecutable('goose', 'echo " 1.54.0"');
      expect(parseProbeOutput(run(), ['goose', 'claude'])).toEqual(new Set(['goose', 'claude']));

      fakeExecutable('goose', 'echo "goose version: v3.28.0"');
      expect(parseProbeOutput(run(), ['goose', 'claude'])).toEqual(new Set(['claude']));
    }
  );

  it.each(['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh', '/usr/bin/fish'].filter(existsSync))(
    'finds Amp and GitHub Copilot CLI but not the programs that share their names in %s',
    (shell) => {
      const executables = ['amp', 'copilot'];
      const run = () =>
        execFileSync(shell, ['-c', buildProbeScript(executables)], {
          env: { PATH: `${binDir}:/usr/bin:/bin` },
          encoding: 'utf8',
        });

      fakeExecutable('amp', 'echo "0.0.1792094445-g3475f5 (released 2026-10-15T20:00:45.000Z)"');
      fakeExecutable('copilot', 'echo "GitHub Copilot CLI 1.0.98."');
      expect(parseProbeOutput(run(), executables)).toEqual(new Set(['amp', 'copilot']));

      fakeExecutable('amp', 'echo "error: Failed to initialize terminal" >&2; exit 1');
      fakeExecutable('copilot', 'echo "copilot version: v1.34.0"');
      expect(parseProbeOutput(run(), executables)).toEqual(new Set());
    }
  );

  it('leaves out the Windows programs a WSL distro sees on the Windows drives', () => {
    // WSL adds the Windows PATH to the distro's, so npm's shims for Windows resolve there.
    const onWindowsDrive = (script: string) =>
      execFileSync(
        '/bin/bash',
        [
          '-c',
          `command() { if [ "$2" = codex ]; then echo /mnt/c/Users/me/AppData/Roaming/npm/codex; else builtin command "$@"; fi; }; ${script}`,
        ],
        { env: { PATH: `${binDir}:/usr/bin:/bin` }, encoding: 'utf8' }
      );

    expect(
      parseProbeOutput(onWindowsDrive(buildProbeScript(['claude', 'codex'])), ['claude', 'codex'])
    ).toEqual(new Set(['claude', 'codex']));
    expect(
      parseProbeOutput(
        onWindowsDrive(buildProbeScript(['claude', 'codex'], { skipWindowsDrives: true })),
        ['claude', 'codex']
      )
    ).toEqual(new Set(['claude']));
  });
});

describe('findOnPath', () => {
  it('looks in each PATH directory', () => {
    const files = new Set(['/home/me/.local/bin/claude', '/usr/bin/codex']);

    const found = findOnPath(['claude', 'codex', 'amp'], '/usr/bin:/home/me/.local/bin', {
      platform: 'linux',
      isExecutable: (filePath) => files.has(filePath),
    });

    expect(found).toEqual(new Set(['claude', 'codex']));
  });

  it('tries each PATHEXT extension on Windows', () => {
    const files = new Set(['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.CMD']);

    const found = findOnPath(
      ['claude', 'codex'],
      'C:\\Windows\\system32;C:\\Users\\me\\AppData\\Roaming\\npm',
      {
        platform: 'win32',
        pathExt: '.COM;.EXE;.BAT;.CMD',
        isExecutable: (filePath) => files.has(filePath),
      }
    );

    expect(found).toEqual(new Set(['claude']));
  });
});

describe('detectInstalledAgents', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetShell.mockReturnValue('/bin/zsh');
    mockIsWslMode.mockReturnValue(false);
    mockBuildTerminalEnv.mockReturnValue({ PATH: '' });
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('names the templates whose CLI the login shell finds, in template order', async () => {
    shellPrints('__komla_agent_found__ hermes\n__komla_agent_found__ claude\n');

    await expect(detectInstalledAgents(templates)).resolves.toEqual([
      'Claude Code',
      'Hermes Agent',
    ]);
    expect(mockSpawn).toHaveBeenCalledWith(
      '/bin/zsh',
      ['-ilc', buildProbeScript(['claude', 'codex', 'hermes'])],
      expect.any(Object)
    );
  });

  it('runs the shell in its own session with no input, so it cannot read or stop on the terminal', async () => {
    shellPrints('');

    await detectInstalledAgents(templates);

    expect(mockSpawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    );
  });

  it('keeps the agents found before the shell failed', async () => {
    shellPrints('__komla_agent_found__ codex\n', 1);

    await expect(detectInstalledAgents(templates)).resolves.toEqual(['Codex']);
  });

  // Runs the Unix branch against a real directory: its executable bit and a PATH split on ':',
  // which a Windows temp dir's drive letter breaks.
  it.skipIf(originalPlatform === 'win32')("also counts agents on Komla's own PATH", async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'komla-agent-path-'));
    try {
      writeFileSync(join(binDir, 'codex'), '#!/bin/sh\n');
      chmodSync(join(binDir, 'codex'), 0o755);
      mockBuildTerminalEnv.mockReturnValue({ PATH: binDir });
      shellPrints('');

      await expect(detectInstalledAgents(templates)).resolves.toEqual(['Codex']);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('asks the WSL distro instead of the Windows PATH in WSL mode', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockIsWslMode.mockReturnValue(true);
    mockBuildTerminalEnv.mockReturnValue({ Path: 'C:\\Users\\me\\AppData\\Roaming\\npm' });
    shellPrints('__komla_agent_found__ claude\n');

    await expect(detectInstalledAgents(templates)).resolves.toEqual(['Claude Code']);
    expect(mockSpawn).toHaveBeenCalledWith(
      'wsl.exe',
      [
        '-d',
        'Ubuntu',
        '--',
        'bash',
        '-lic',
        buildProbeScript(['claude', 'codex', 'hermes'], { skipWindowsDrives: true }),
      ],
      expect.objectContaining({ detached: false })
    );
  });

  it('counts a goose on PATH only once the shell has checked it', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'komla-agent-path-'));
    try {
      writeFileSync(join(binDir, 'goose'), '#!/bin/sh\n');
      chmodSync(join(binDir, 'goose'), 0o755);
      mockBuildTerminalEnv.mockReturnValue({ PATH: binDir });
      shellPrints('__komla_agent_found__ goose\ngoose version: v3.28.0\n');

      await expect(
        detectInstalledAgents([{ name: 'Goose', openCommand: 'goose session' }])
      ).resolves.toEqual([]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('runs no shell when there is nothing to look for', async () => {
    await expect(detectInstalledAgents([{ name: 'Custom', openCommand: '' }])).resolves.toEqual([]);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')(
  'detectInstalledAgents with a shell that hangs',
  () => {
    const realSetTimeout = globalThis.setTimeout;
    let dir: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      mockIsWslMode.mockReturnValue(false);
      mockBuildTerminalEnv.mockReturnValue({ PATH: '/usr/bin:/bin' });
      const { spawn } = await vi.importActual<typeof import('child_process')>('child_process');
      mockSpawn.mockImplementation(spawn);
      dir = mkdtempSync(join(tmpdir(), 'komla-agent-hang-'));
      // Like an interactive shell whose rc file blocks: it ignores SIGTERM, and so does what it starts.
      const shell = join(dir, 'shell');
      writeFileSync(
        shell,
        `#!/bin/sh\ntrap '' TERM\necho __komla_agent_found__ claude\nsleep 30 &\necho $! > ${join(dir, 'child.pid')}\nwait\n`
      );
      chmodSync(shell, 0o755);
      mockGetShell.mockReturnValue(shell);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    afterEach(() => {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    });

    it('gives up at the timeout, keeping what it found, and kills everything the shell started', async () => {
      const detected = detectInstalledAgents(templates);
      await vi.waitFor(() => expect(existsSync(join(dir, 'child.pid'))).toBe(true), {
        interval: 20,
        timeout: 5_000,
      });
      const childPid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'));
      // Lets Node read what the shell printed before the timeout fires.
      await new Promise((resolve) => realSetTimeout(resolve, 100));

      await vi.advanceTimersByTimeAsync(10_000);
      vi.useRealTimers();

      await expect(detected).resolves.toEqual(['Claude Code']);
      await vi.waitFor(() => expect(() => process.kill(childPid, 0)).toThrow(), { timeout: 2_000 });
    });
  }
);
