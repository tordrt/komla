import { execFile } from 'child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from 'electron';

import { refusingExecFile } from '../../helpers/windows-refusal';

vi.mock('child_process', async (importOriginal) => {
  const childProcess = await importOriginal<typeof import('child_process')>();
  return { ...childProcess, execFile: vi.fn(childProcess.execFile) };
});

vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>();
  return { ...fs, copyFileSync: vi.fn(fs.copyFileSync) };
});

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: vi.fn(() => '/mock/app'), getPath: () => '/mock/home' },
}));

import {
  addKomlaCliToEnv,
  komlaNodeCmd,
  getKomlaCliPath,
  installKomlaCli,
  isKomlaCliBlocked,
  probeKomlaCli,
  resolveKomlaArtifactRoot,
  resolveKomlaBinaryTarget,
} from '../../../src/main/lib/komla-cli';

describe('Komla CLI installation helpers', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  async function prepareInstallation() {
    const directory = await mkdtemp(join(tmpdir(), 'komla-cli-install-'));
    temporaryDirectories.push(directory);
    vi.mocked(app.getAppPath).mockReturnValue(directory);
    vi.stubEnv('KOMLA_DATA_DIR', join(directory, 'data'));
    vi.stubEnv('KOMLA_CLI', '');
    const target = resolveKomlaBinaryTarget(process.platform, process.arch)!;
    const source = join(
      directory,
      'native',
      'artifacts',
      target,
      process.platform === 'win32' ? 'komla.exe' : 'komla'
    );
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, 'first executable');
    return { source };
  }

  it('installs the executable once and reuses it on subsequent starts', async () => {
    await prepareInstallation();
    installKomlaCli();
    expect(readFileSync(getKomlaCliPath(), 'utf8')).toBe('first executable');
    expect(copyFileSync).toHaveBeenCalledTimes(1);

    vi.mocked(copyFileSync).mockClear();
    process.env.KOMLA_CLI = '';
    installKomlaCli();

    expect(copyFileSync).not.toHaveBeenCalled();
    expect(process.env.KOMLA_CLI).toBe(getKomlaCliPath());
  });

  it('refreshes a changed artifact even when its size is unchanged', async () => {
    const { source } = await prepareInstallation();
    installKomlaCli();
    writeFileSync(source, 'other executable');
    const changedTime = new Date(Date.now() + 2000);
    utimesSync(source, changedTime, changedTime);

    installKomlaCli();

    expect(readFileSync(getKomlaCliPath(), 'utf8')).toBe('other executable');
  });

  it('repairs a missing or modified installed executable', async () => {
    await prepareInstallation();
    installKomlaCli();
    rmSync(getKomlaCliPath());
    installKomlaCli();
    expect(readFileSync(getKomlaCliPath(), 'utf8')).toBe('first executable');

    writeFileSync(getKomlaCliPath(), 'broken');
    installKomlaCli();
    expect(readFileSync(getKomlaCliPath(), 'utf8')).toBe('first executable');
  });

  it('recovers from invalid installation metadata', async () => {
    await prepareInstallation();
    installKomlaCli();
    writeFileSync(`${getKomlaCliPath()}.install-state.json`, 'incomplete');
    vi.mocked(copyFileSync).mockClear();

    installKomlaCli();

    expect(copyFileSync).toHaveBeenCalledTimes(1);
    vi.mocked(copyFileSync).mockClear();
    installKomlaCli();
    expect(copyFileSync).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('repairs lost executable permissions', async () => {
    await prepareInstallation();
    installKomlaCli();
    chmodSync(getKomlaCliPath(), 0o644);

    installKomlaCli();

    expect(statSync(getKomlaCliPath()).mode & 0o111).toBe(0o111);
  });

  it.each(['UNKNOWN', 'EPERM'])(
    'finds the CLI blocked once Windows refuses to start it (%s)',
    (code) => {
      vi.mocked(execFile).mockImplementationOnce(refusingExecFile(code));

      expect(probeKomlaCli('C:\\Users\\dev\\.komla\\bin\\komla.exe')).toBe(true);
      expect(isKomlaCliBlocked()).toBe(true);

      vi.mocked(execFile).mockImplementationOnce((() => ({})) as unknown as typeof execFile);
      expect(probeKomlaCli('C:\\Users\\dev\\.komla\\bin\\komla.exe')).toBe(false);
      expect(isKomlaCliBlocked()).toBe(false);
    }
  );

  it.skipIf(process.platform === 'win32')(
    'does not take a failure Windows policy did not cause for a block',
    async () => {
      vi.mocked(execFile).mockImplementationOnce(refusingExecFile());
      expect(probeKomlaCli('C:\\Users\\dev\\.komla\\bin\\komla.exe')).toBe(true);

      // An antivirus scan holding the newly copied file.
      vi.mocked(execFile).mockImplementationOnce(refusingExecFile('EBUSY'));
      expect(probeKomlaCli('C:\\Users\\dev\\.komla\\bin\\komla.exe')).toBe(false);

      const directory = await mkdtemp(join(tmpdir(), 'komla-cli-probe-'));
      temporaryDirectories.push(directory);
      const cliPath = join(directory, 'komla');
      writeFileSync(cliPath, '#!/bin/sh\nexit 1\n', { mode: 0o644 });
      expect(probeKomlaCli(cliPath)).toBe(false);
      chmodSync(cliPath, 0o755);
      expect(probeKomlaCli(cliPath)).toBe(false);
      expect(probeKomlaCli(join(directory, 'missing'))).toBe(false);
    }
  );

  it('names Komla in komla-node.cmd in a form cmd reads in any code page', () => {
    const env = {
      LOCALAPPDATA: 'C:\\Users\\Jöran\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\Jöran',
    };
    expect(komlaNodeCmd('C:\\Program Files\\Komla\\Komla.exe', env)).toBe(
      '@set ELECTRON_RUN_AS_NODE=1\r\n@"C:\\Program Files\\Komla\\Komla.exe" %*\r\n'
    );
    expect(komlaNodeCmd('c:\\users\\jöran\\AppData\\Local\\Programs\\komla\\Komla.exe', env)).toBe(
      '@set ELECTRON_RUN_AS_NODE=1\r\n@"%LOCALAPPDATA%\\Programs\\komla\\Komla.exe" %*\r\n'
    );
    expect(komlaNodeCmd('C:\\Users\\Jöran\\Apps\\Komla\\Komla.exe', env)).toBe(
      '@set ELECTRON_RUN_AS_NODE=1\r\n@"%USERPROFILE%\\Apps\\Komla\\Komla.exe" %*\r\n'
    );
  });

  it.skipIf(process.platform === 'win32')(
    'counts a CLI that starts but is slow to answer as runnable',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'komla-cli-probe-'));
      temporaryDirectories.push(directory);
      const cliPath = join(directory, 'komla');
      writeFileSync(cliPath, '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });

      expect(probeKomlaCli(cliPath, 100)).toBe(false);
    }
  );

  it('translates the installed CLI and PATH for WSL terminals', () => {
    const env: NodeJS.ProcessEnv = {
      Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
      PATH: '/usr/local/bin:/usr/bin:/bin',
    };
    addKomlaCliToEnv(env, 'C:\\Users\\dev\\.komla\\bin\\komla.exe', {
      cliExists: () => true,
      wslPathTranslator: (value) =>
        value
          .replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`)
          .replace(/\\/g, '/'),
    });

    expect(env.KOMLA_CLI).toBe('/mnt/c/Users/dev/.komla/bin/komla');
    expect(env.PATH).toBe(
      '/mnt/c/Users/dev/.komla/bin:/usr/local/bin:/usr/bin:/bin:/mnt/c/Windows/System32:/mnt/c/Program Files/Git/cmd'
    );
    expect(env.Path).toBeUndefined();
  });

  it('uses the Remote Companion supported-target mapping', () => {
    expect(resolveKomlaBinaryTarget('Linux', 'amd64')).toBe('x86_64-unknown-linux-musl');
    expect(resolveKomlaBinaryTarget('linux', 'x64')).toBe('x86_64-unknown-linux-musl');
    expect(resolveKomlaBinaryTarget('darwin', 'x64')).toBe('x86_64-apple-darwin');
    expect(resolveKomlaBinaryTarget('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
    expect(resolveKomlaBinaryTarget('Darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(resolveKomlaBinaryTarget('Windows_NT', 'x86_64')).toBe('x86_64-pc-windows-msvc');
  });

  it('resolves development artifacts from the main bundle instead of the process cwd', () => {
    expect(
      resolveKomlaArtifactRoot({
        isPackaged: false,
        resourcesPath: join('packaged', 'resources'),
        appPath: 'repo',
      })
    ).toBe(join('repo', 'native', 'artifacts'));
  });

  it('resolves packaged artifacts from the application resources', () => {
    expect(
      resolveKomlaArtifactRoot({
        isPackaged: true,
        resourcesPath: join('packaged', 'resources'),
        appPath: 'repo',
      })
    ).toBe(join('packaged', 'resources', 'native'));
  });

  it('adds an installed executable to managed terminal environments', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'komla-cli-test-'));
    temporaryDirectories.push(directory);
    const cliPath = join(directory, 'bin', 'komla');
    mkdirSync(join(directory, 'bin'));
    writeFileSync(cliPath, '#!/bin/sh\n');
    chmodSync(cliPath, 0o755);
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const env: NodeJS.ProcessEnv = { [pathKey]: ['system-bin', 'user-bin'].join(delimiter) };

    addKomlaCliToEnv(env, cliPath);

    expect(env.KOMLA_CLI).toBe(cliPath);
    expect(env[pathKey]?.split(delimiter)[0]).toBe(dirname(cliPath));
  });

  it('leaves the environment unchanged when the artifact is absent', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin' };

    addKomlaCliToEnv(env, '/does/not/exist/komla');

    expect(env).toEqual({ PATH: '/usr/bin:/bin' });
  });
});
