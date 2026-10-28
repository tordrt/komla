import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExistsSync = vi.fn();
const mockExecFileSync = vi.fn();

vi.mock('fs', () => ({
  existsSync: (path: string) => mockExistsSync(path),
}));

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../../../src/main/lib/wsl', () => ({
  isWslMode: vi.fn(() => false),
  getWslShell: vi.fn(() => 'wsl.exe'),
  getWslShellArgs: vi.fn(() => []),
  windowsPathToWsl: vi.fn((path: string) => path),
}));

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Windows matches process.env keys case-insensitively, so `process.env.Path = x` there only
// changes whichever PATH key the host has. Replace every variant so the inherited key is `Path`.
function setInheritedPath(value: string): () => void {
  const saved = Object.entries(process.env).filter(([key]) => key.toLowerCase() === 'path');
  for (const [key] of saved) delete process.env[key];
  process.env.Path = value;
  return () => {
    delete process.env.Path;
    for (const [key, savedValue] of saved) process.env[key] = savedValue;
  };
}

describe('shell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockExistsSync.mockImplementation((path: string) => path === '/bin/zsh');
    // Default: execFileSync throws (simulates commands not found)
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
  });

  describe('getShellArgs', () => {
    it('should return login shell flag on Unix', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      try {
        const { getShellArgs } = await import('../../../src/main/lib/shell');
        expect(getShellArgs()).toEqual(['-l', '-o', 'nopromptsp']);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should return PowerShell flags on Windows (non-WSL)', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        const { getShellArgs } = await import('../../../src/main/lib/shell');
        expect(getShellArgs()).toEqual(['-ExecutionPolicy', 'Bypass', '-NoLogo']);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should return WSL args on Windows in WSL mode', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        const wslModule = await import('../../../src/main/lib/wsl');
        vi.mocked(wslModule.isWslMode).mockReturnValue(true);
        vi.mocked(wslModule.getWslShellArgs).mockReturnValue(['-d', 'Ubuntu']);

        const { getShellArgs } = await import('../../../src/main/lib/shell');
        expect(getShellArgs('Ubuntu')).toEqual(['-d', 'Ubuntu']);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        const wslModule = await import('../../../src/main/lib/wsl');
        vi.mocked(wslModule.isWslMode).mockReturnValue(false);
      }
    });
  });

  describe('getShell', () => {
    it('should return SHELL env var when it exists', async () => {
      const originalPlatform = process.platform;
      const originalShell = process.env.SHELL;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      process.env.SHELL = '/usr/local/bin/fish';
      mockExistsSync.mockImplementation((path: string) => path === '/usr/local/bin/fish');

      try {
        const { getShell } = await import('../../../src/main/lib/shell');
        expect(getShell()).toBe('/usr/local/bin/fish');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        process.env.SHELL = originalShell;
      }
    });

    it('should fall back to /bin/zsh then /bin/bash then /bin/sh', async () => {
      const originalPlatform = process.platform;
      const originalShell = process.env.SHELL;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      delete process.env.SHELL;
      mockExistsSync.mockImplementation((path: string) => path === '/bin/bash');

      try {
        const { getShell } = await import('../../../src/main/lib/shell');
        expect(getShell()).toBe('/bin/bash');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        process.env.SHELL = originalShell;
      }
    });

    it('should return /bin/sh as last resort', async () => {
      const originalPlatform = process.platform;
      const originalShell = process.env.SHELL;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      delete process.env.SHELL;
      mockExistsSync.mockReturnValue(false);

      try {
        const { getShell } = await import('../../../src/main/lib/shell');
        expect(getShell()).toBe('/bin/sh');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        process.env.SHELL = originalShell;
      }
    });
  });

  describe('buildTerminalEnv', () => {
    it('should set basic terminal environment variables', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      try {
        const { buildTerminalEnv } = await import('../../../src/main/lib/shell');
        const env = buildTerminalEnv();

        expect(env.TERM).toBe('xterm-256color');
        expect(env.COLORTERM).toBe('truecolor');
        expect(env.TERM_PROGRAM).toBe('Komla');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should clean up stale host terminal metadata', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      process.env.TERM_SESSION_ID = 'some-session-id';
      process.env.TERM_PROGRAM_VERSION = '1.0';
      process.env.NODE_ENV = 'development';

      try {
        const { buildTerminalEnv } = await import('../../../src/main/lib/shell');
        const env = buildTerminalEnv();

        expect(env.TERM_SESSION_ID).toBeUndefined();
        expect(env.TERM_PROGRAM_VERSION).toBeUndefined();
        expect(env.NODE_ENV).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        delete process.env.TERM_SESSION_ID;
        delete process.env.TERM_PROGRAM_VERSION;
        delete process.env.NODE_ENV;
      }
    });

    it('should drop how a Claude Code session that started Komla runs', async () => {
      const inherited = {
        CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
        CLAUDE_JOB_DIR: process.env.CLAUDE_JOB_DIR,
      };
      process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
      process.env.CLAUDE_JOB_DIR = '/home/u/.claude/jobs/69f07811';

      try {
        const { buildTerminalEnv } = await import('../../../src/main/lib/shell');
        const env = buildTerminalEnv();

        expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
        expect(env.CLAUDE_JOB_DIR).toBeUndefined();
      } finally {
        for (const [name, value] of Object.entries(inherited)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });

    it('should refresh PATH from Windows registry on win32', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      // Simulate reg query responses for system and user PATH
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'reg' && typeof args[1] === 'string' && args[1].includes('HKLM')) {
          return Buffer.from('    Path    REG_EXPAND_SZ    C:\\Windows\\system32;C:\\Windows');
        }
        if (cmd === 'reg' && typeof args[1] === 'string' && args[1].includes('HKCU')) {
          return Buffer.from(
            '    Path    REG_EXPAND_SZ    C:\\Users\\test\\AppData\\Local\\Programs\\kimi'
          );
        }
        throw new Error('not found');
      });

      try {
        const { buildTerminalEnv } = await import('../../../src/main/lib/shell');
        const env = buildTerminalEnv();

        expect(env.Path).toBe(
          'C:\\Windows\\system32;C:\\Windows;C:\\Users\\test\\AppData\\Local\\Programs\\kimi'
        );
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });

    it('should expand %VAR% references in Windows registry PATH', async () => {
      const originalPlatform = process.platform;
      const originalSystemRoot = process.env.SystemRoot;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env.SystemRoot = 'C:\\Windows';

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'reg' && typeof args[1] === 'string' && args[1].includes('HKLM')) {
          return Buffer.from('    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;%SystemRoot%');
        }
        if (cmd === 'reg' && typeof args[1] === 'string' && args[1].includes('HKCU')) {
          throw new Error('not found');
        }
        throw new Error('not found');
      });

      try {
        const { buildTerminalEnv } = await import('../../../src/main/lib/shell');
        const env = buildTerminalEnv();

        expect(env.Path).toBe('C:\\Windows\\system32;C:\\Windows');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        process.env.SystemRoot = originalSystemRoot;
      }
    });

    it('should fall back to process.env PATH when registry query fails on Windows', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const restorePath = setInheritedPath('C:\\FallbackPath');

      mockExecFileSync.mockImplementation(() => {
        throw new Error('reg not found');
      });

      try {
        const { buildTerminalEnv } = await import('../../../src/main/lib/shell');
        const env = buildTerminalEnv();

        // Should still have a Path (inherited from process.env)
        expect(env.Path).toBe('C:\\FallbackPath');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        restorePath();
      }
    });

    it('should fall back to inherited PATH when system PATH query fails but user succeeds', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const restorePath = setInheritedPath('C:\\InheritedPath');

      // HKLM fails, HKCU succeeds — should NOT use partial result
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'reg' && typeof args[1] === 'string' && args[1].includes('HKLM')) {
          throw new Error('access denied');
        }
        if (cmd === 'reg' && typeof args[1] === 'string' && args[1].includes('HKCU')) {
          return Buffer.from('    Path    REG_SZ    C:\\Users\\test\\Tools');
        }
        throw new Error('not found');
      });

      try {
        const { buildTerminalEnv } = await import('../../../src/main/lib/shell');
        const env = buildTerminalEnv();

        // Must keep inherited PATH — partial registry result is unsafe
        expect(env.Path).toBe('C:\\InheritedPath');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        restorePath();
      }
    });

    it('should remove stale PATH key variants when refreshing on Windows', async () => {
      const originalPlatform = process.platform;
      const originalPATH = process.env.PATH;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      // Simulate an uppercase PATH key in the inherited env
      process.env.PATH = 'C:\\StalePath';

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'reg' && typeof args[1] === 'string' && args[1].includes('HKLM')) {
          return Buffer.from('    Path    REG_SZ    C:\\FreshPath');
        }
        throw new Error('not found');
      });

      try {
        const { buildTerminalEnv } = await import('../../../src/main/lib/shell');
        const env = buildTerminalEnv();

        // Fresh value should be present under canonical key
        expect(env.Path).toBe('C:\\FreshPath');
        // No stale uppercase variant should remain
        const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
        expect(pathKeys).toEqual(['Path']);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        process.env.PATH = originalPATH;
      }
    });

    it('should skip PATH refresh on Windows in WSL mode', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        const wslModule = await import('../../../src/main/lib/wsl');
        vi.mocked(wslModule.isWslMode).mockReturnValue(true);

        const { buildTerminalEnv } = await import('../../../src/main/lib/shell');
        buildTerminalEnv();

        // reg should not be called when in WSL mode
        expect(mockExecFileSync).not.toHaveBeenCalledWith(
          'reg',
          expect.anything(),
          expect.anything()
        );
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        const wslModule = await import('../../../src/main/lib/wsl');
        vi.mocked(wslModule.isWslMode).mockReturnValue(false);
      }
    });

    it('should not refresh PATH on non-Windows platforms', async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      try {
        const { buildTerminalEnv } = await import('../../../src/main/lib/shell');
        buildTerminalEnv();

        // reg should never be called on non-Windows
        expect(mockExecFileSync).not.toHaveBeenCalledWith(
          'reg',
          expect.anything(),
          expect.anything()
        );
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      }
    });
  });
});
