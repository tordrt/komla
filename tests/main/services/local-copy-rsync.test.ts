import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRsyncProgressParser,
  isRsyncOptionRejected,
  runRsync,
} from '../../../src/main/services/local-copy-rsync';

function percentsFrom(mode: 'overall' | 'per-file', output: string | string[]): number[] {
  const percents: number[] = [];
  const parse = createRsyncProgressParser(mode, (percent) => percents.push(percent));
  for (const chunk of Array.isArray(output) ? output : [output]) parse(chunk);
  return percents;
}

describe('createRsyncProgressParser', () => {
  describe('with overall progress (rsync 3.1+)', () => {
    it('follows the bytes of a first sync, captured from rsync 3.5', () => {
      expect(
        percentsFrom(
          'overall',
          '\r              0   0%    0.00kB/s    0:00:00  ' +
            '\r      3,000,000  12%    9.17MB/s    0:00:00 (xfr#1, to-chk=38/40)' +
            '\r      8,490,368  35%    7.82MB/s    0:00:01  ' +
            '\r     24,000,026  99%    7.90MB/s    0:00:02 (xfr#17, to-chk=0/40)\r'
        )
      ).toEqual([0, 12, 35, 100]);
    });

    it('follows the files of a sync that changes little, where bytes stay at 0%', () => {
      expect(
        percentsFrom(
          'overall',
          '\r              0   0%    0.00kB/s    0:00:00  ' +
            '\r             10   0%    9.77kB/s    0:00:00 (xfr#1, to-chk=7/40)' +
            '\r             10   0%    9.77kB/s    0:00:00 (xfr#1, to-chk=0/40)\r'
        )
      ).toEqual([0, 82, 100]);
    });

    // Counting files here would show 99% for the whole of the large file.
    it('follows the bytes while large files remain after many small ones', () => {
      expect(
        percentsFrom(
          'overall',
          '\r     50,000,000   1%    9.17MB/s    0:00:00 (xfr#5000, to-chk=1/5400)' +
            '\r  2,500,000,000  50%    9.17MB/s    0:04:00  ' +
            '\r  5,000,000,000 100%    9.17MB/s    0:08:00 (xfr#5001, to-chk=0/5400)\r'
        )
      ).toEqual([1, 50, 100]);
    });

    // Captured from rsync 3.5: 300 pairs of folders holding three small files each, then a large
    // file. Entries checked are mostly folders here, none of them transferred.
    it('follows the bytes of a first sync through many folders', () => {
      expect(
        percentsFrom(
          'overall',
          '\r        396,000   0%    9.17MB/s    0:00:00 (xfr#198, to-chk=937/1503)\r'
        )
      ).toEqual([0]);
    });

    it('finishes a sync that had nothing to transfer', () => {
      expect(
        percentsFrom('overall', '\r              0   0%    0.00kB/s    0:00:00 (xfr#0, to-chk=0/40)\r')
      ).toEqual([100]);
    });

    it('reads localized thousands separators', () => {
      expect(percentsFrom('overall', '\r      3.000.000  12%    9.17MB/s    0:00:00  \r')).toEqual([
        12,
      ]);
    });

    it('reads a line split across chunks', () => {
      expect(percentsFrom('overall', ['\r      3,000', ',000  12%    9.17MB/s    0:00:00  \r'])).toEqual(
        [12]
      );
    });

    // rsync starts each update with a carriage return and ends it with nothing, so waiting for the
    // next one would hide the latest for as long as the next takes.
    it('reports an update before the next one arrives', () => {
      expect(percentsFrom('overall', '\r      3,000,000  12%    9.17MB/s    0:00:00  ')).toEqual([12]);
    });

    it('reads the files of an update whose line has yet to end', () => {
      expect(
        percentsFrom('overall', [
          '\r             10   0%    9.77kB/s    0:00:00 (xfr#1, to-chk=7/',
          '40)',
        ])
      ).toEqual([0, 82]);
    });

    it('never moves backward or repeats a percent', () => {
      expect(
        percentsFrom(
          'overall',
          '\r      50  50%    9.17MB/s    0:00:00  \r      50  50%    9.17MB/s    0:00:00  ' +
            '\r      40  40%    9.17MB/s    0:00:00  \r'
        )
      ).toEqual([50]);
    });

    it('ignores output that is not progress', () => {
      expect(percentsFrom('overall', 'receiving file list ... 40 files to consider\n')).toEqual([]);
    });
  });

  describe('with per-file progress (rsync before 3.1, openrsync)', () => {
    const line = (remaining: number) =>
      `     3000000 100%  158.95MB/s    0:00:00 (xfer#1, to-check=${remaining}/40)\n`;

    it('ignores the percent of each file, which says nothing about the sync', () => {
      expect(
        percentsFrom('per-file', 'f1.bin\n           0   0%    0.00kB/s    0:00:00\r' + line(38))
      ).toEqual([]);
    });

    it('counts down the files left to check, as rsync 2.6.9 does', () => {
      expect(percentsFrom('per-file', line(38) + line(37) + line(20) + line(0))).toEqual([
        7, 50, 100,
      ]);
    });

    // Apple's openrsync prints the index of the file it just finished as "to-check". Reading that
    // as files remaining would report about 100% from the first file on.
    it('counts up when the number rises, as openrsync does', () => {
      expect(percentsFrom('per-file', line(0) + line(1) + line(19) + line(39))).toEqual([
        5, 50, 100,
      ]);
    });

    it('waits for a second file to tell which way the number runs', () => {
      expect(percentsFrom('per-file', line(0))).toEqual([]);
    });

    it('does not take a file name for progress', () => {
      expect(percentsFrom('per-file', 'notes (xfer#1, to-check=0/40)\nmore (xfer#2, to-check=1/40)\n')).toEqual(
        []
      );
    });
  });

  it('survives a list with no entries', () => {
    expect(percentsFrom('overall', '\r 0 0% 0.00kB/s 0:00:00 (xfr#0, to-chk=0/0)\r')).toEqual([0]);
  });
});

describe('isRsyncOptionRejected', () => {
  it.each([
    // rsync 2.6.9, captured from a real build.
    ['info', 'rsync: --info=progress2: unknown option\nrsync error: syntax or usage error (code 1)'],
    // getopt_long wordings, the ones openrsync gets from the C library.
    ['info', "rsync: unrecognized option `--info=progress2'"],
    ['info', "rsync: unrecognized option '--info=progress2'"],
    ['info', 'rsync: unknown option -- info=progress2'],
    ['progress', "rsync: unrecognized option `--progress'"],
  ])('recognizes the rejection of --%s in: %s', (option, stderr) => {
    expect(isRsyncOptionRejected({ exitCode: 1, stderr }, option)).toBe(true);
  });

  it.each([
    'ssh: connect to host example.com port 22: Connection refused',
    'rsync: connection unexpectedly closed (0 bytes received so far) [Receiver]',
    "rsync: unrecognized option '--something-else'",
    'rsync: information is missing',
  ])('does not take another failure for a rejection: %s', (stderr) => {
    expect(isRsyncOptionRejected({ exitCode: 1, stderr }, 'info')).toBe(false);
  });

  // A sync that gets this far has transferred files, which a retry would transfer again.
  it('does not take a file name in a later failure for a rejection', () => {
    expect(
      isRsyncOptionRejected(
        {
          exitCode: 23,
          stderr: 'rsync: send_files failed to open "docs/option/info.md": Permission denied',
        },
        'info'
      )
    ).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('runRsync', () => {
  let binDir: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (binDir) rmSync(binDir, { recursive: true, force: true });
    binDir = undefined;
  });

  function stubRsync(script: string): void {
    binDir = mkdtempSync(join(tmpdir(), 'komla-rsync-test-'));
    const file = join(binDir, 'rsync');
    writeFileSync(file, `#!/bin/sh\n${script}\n`);
    chmodSync(file, 0o755);
    vi.stubEnv('PATH', `${binDir}${delimiter}${process.env.PATH}`);
  }

  // A stuck ssh that rsync started outlives rsync and holds its output open. Like real rsync, the
  // stub traps the signal and exits with a code, so nothing here can rely on seeing it die by signal.
  it('gives up at its timeout even when a child process holds its output open', async () => {
    stubRsync("trap 'exit 20' TERM\nsleep 4 &\nwait");
    const started = Date.now();

    await expect(runRsync(['x'], { timeout: 200 }, () => undefined)).rejects.toThrow(
      'rsync did not finish within 0.2 seconds'
    );

    expect(Date.now() - started).toBeLessThan(3000);
  });

  // rsync stuck on a hung disk won't exit for any signal, and the sync still has to end.
  it('gives up at its timeout even when rsync does not exit', async () => {
    stubRsync("trap '' TERM\nsleep 2\nsleep 2");
    const started = Date.now();

    await expect(runRsync(['x'], { timeout: 200 }, () => undefined)).rejects.toThrow(
      'did not finish'
    );

    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('passes output on, and reports how a failure exited and what it said', async () => {
    stubRsync('echo progress\necho problem >&2\nexit 23');
    const output: string[] = [];

    await expect(
      runRsync(['x'], { timeout: 5000 }, (chunk) => output.push(chunk))
    ).rejects.toMatchObject({ exitCode: 23, stderr: 'problem\n' });

    expect(output.join('')).toBe('progress\n');
  });

  it('reads all of the output of a sync that succeeds', async () => {
    stubRsync('echo first\necho second\nexit 0');
    const output: string[] = [];

    await runRsync(['x'], { timeout: 5000 }, (chunk) => output.push(chunk));

    expect(output.join('')).toBe('first\nsecond\n');
  });
});
