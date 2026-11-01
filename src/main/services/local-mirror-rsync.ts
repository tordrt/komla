import { spawn } from 'child_process';

/**
 * What the percent on an rsync progress line measures: the whole transfer, or just the current
 * file, in which case only the count of files says how far the sync has come.
 */
type RsyncProgressMode = 'overall' | 'per-file';

/**
 * The progress options to try, best first. `--info=progress2` needs rsync 3.1. The rsync 2.6.9 and
 * openrsync that macOS ships have only `--progress`, and an rsync with neither still syncs, without
 * a percent.
 */
const RSYNC_PROGRESS_OPTIONS: ReadonlyArray<{
  arg: string;
  name: string;
  mode: RsyncProgressMode;
}> = [
  { arg: '--info=progress2', name: 'info', mode: 'overall' },
  { arg: '--progress', name: 'progress', mode: 'per-file' },
];

// `--progress` also prints file names. One that matches this could only misreport the percent.
const PROGRESS_LINE =
  /^\s*\S+\s+(\d{1,3})%.*?(?:\((?:xfr|xfer)#(\d+), to-(?:chk|check)=(\d+)\/(\d+)\))?\s*$/;
const MAX_PENDING_CHARS = 4096;
const MAX_STDERR_CHARS = 64 * 1024;

/**
 * Turns rsync's progress output into a percent for the whole sync, calling `onPercent` each time
 * it rises. That caps a sync at 100 reports, however many files it has.
 *
 * rsync counts only transferred bytes against the size of the whole tree. That is right while most
 * files need transferring, as in a first sync, where a count of files would say 99% with one large
 * file to go. Once most of the entries checked were already up to date, bytes stay near 0%, so the
 * count of files can take over. With only `--progress`, the count of files is all there is.
 */
export function createRsyncProgressParser(
  mode: RsyncProgressMode,
  onPercent: (percent: number) => void
): (chunk: string) => void {
  let pending = '';
  let reported = -1;
  let previousCount: number | undefined;
  let countsUp: boolean | undefined;

  const filesChecked = (transferred: number, count: number, total: number): number | undefined => {
    if (mode === 'overall') {
      const checked = total - count;
      // The count of checked entries includes folders, which a first sync can have plenty of.
      return count === 0 || transferred * 4 < checked ? checked : undefined;
    }
    // Older rsync counts files left to check. openrsync prints the same label with the index of the
    // file it finished, which rises instead, and only a second line tells them apart.
    if (previousCount === undefined || count === previousCount) {
      previousCount = count;
      return undefined;
    }
    countsUp ??= count > previousCount;
    previousCount = count;
    return countsUp ? count + 1 : total - count;
  };

  const readLine = (line: string): void => {
    const match = PROGRESS_LINE.exec(line);
    if (!match) return;
    let percent = mode === 'overall' ? Number(match[1]) : -1;
    if (match[2] !== undefined && match[3] !== undefined && match[4] !== undefined) {
      const total = Number(match[4]);
      const checked = filesChecked(Number(match[2]), Number(match[3]), total);
      if (checked !== undefined && total > 0) {
        percent = Math.max(percent, Math.floor((checked / total) * 100));
      }
    }
    percent = Math.min(percent, 100);
    if (percent > reported) {
      reported = percent;
      onPercent(percent);
    }
  };

  return (chunk) => {
    const lines = `${pending}${chunk}`.split(/[\r\n]/);
    pending = (lines.pop() ?? '').slice(-MAX_PENDING_CHARS);
    lines.forEach(readLine);
    // rsync starts each update with a carriage return and doesn't end it, so the latest is still
    // pending. Read now, a line cut short can't overstate: it just has less to report.
    readLine(pending);
  };
}

/** Whether rsync failed because it doesn't have the option called `name`. */
export function isRsyncOptionRejected(
  failure: { exitCode: number | null; stderr: string },
  name: string
): boolean {
  // rsync and openrsync both exit 1, for a syntax or usage error, before transferring anything. Any
  // other exit may come after a transfer, which trying again would repeat.
  if (failure.exitCode !== 1) return false;
  // Loose on purpose: the wording varies by rsync and C library, and missing a rejection would fail
  // every sync on that computer, while a false match only costs a retry without the option.
  const mentionsName = new RegExp(`\\b${name}\\b`, 'i');
  return failure.stderr
    .split('\n')
    .some((line) => /\boption\b/i.test(line) && mentionsName.test(line));
}

class RsyncFailedError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string
  ) {
    super(message);
  }
}

/**
 * Runs rsync, passing its stdout to `onOutput` and keeping none of it: progress writes a line for
 * every file, which would add up over a large tree.
 */
export function runRsync(
  args: string[],
  options: { timeout: number; env?: NodeJS.ProcessEnv },
  onOutput: (chunk: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { timeout, ...spawnOptions } = options;
    const child = spawn('rsync', args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
    // Not on 'close', which waits for rsync to exit and for whatever holds its pipes, such as a stuck
    // ssh it started. That would leave the sync running forever, with no error to show or retry from.
    const timer = setTimeout(() => {
      child.kill();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(
        new RsyncFailedError(`rsync did not finish within ${timeout / 1000} seconds`, null, '')
      );
    }, timeout);
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onOutput);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new RsyncFailedError(`Command failed: rsync ${args.join(' ')}\n${stderr}`, code, stderr)
      );
    });
  });
}

interface RsyncPull {
  commonArgs: string[];
  /** The source for rsync with `-s`, which sends it to the remote unquoted. */
  remotePath: string;
  /** The source for rsync without `-s`, where the remote shell reads it. */
  legacyRemotePath: string;
  localPath: string;
  timeout: number;
}

function runRsyncPull(
  pull: RsyncPull,
  legacyQuoting: boolean,
  progress: (typeof RSYNC_PROGRESS_OPTIONS)[number] | undefined,
  onPercent: (percent: number) => void
): Promise<void> {
  const parseProgress = progress && createRsyncProgressParser(progress.mode, onPercent);
  return runRsync(
    [
      '-a',
      ...(legacyQuoting ? [] : ['-s']),
      ...(progress ? [progress.arg] : []),
      ...pull.commonArgs,
      legacyQuoting ? pull.legacyRemotePath : pull.remotePath,
      pull.localPath,
    ],
    {
      timeout: pull.timeout,
      ...(legacyQuoting && {
        env: { ...process.env, RSYNC_OLD_ARGS: '1', RSYNC_PROTECT_ARGS: '0' },
      }),
    },
    (chunk) => parseProgress?.(chunk)
  );
}

/**
 * Runs an rsync pull with the best options this rsync has, reporting progress to `onPercent`.
 * rsync rejects an option it doesn't have before transferring anything, so each rejection drops
 * that option and starts again.
 */
export async function syncWithSupportedOptions(
  pull: RsyncPull,
  onPercent: (percent: number) => void
): Promise<void> {
  let legacyQuoting = false;
  let progressIndex = 0;
  while (true) {
    const progress = RSYNC_PROGRESS_OPTIONS[progressIndex];
    try {
      await runRsyncPull(pull, legacyQuoting, progress, onPercent);
      return;
    } catch (error) {
      if (!(error instanceof RsyncFailedError)) throw error;
      if (!legacyQuoting && /(?:invalid option -- s|-s: unknown option)/i.test(error.stderr)) {
        legacyQuoting = true;
      } else if (progress && isRsyncOptionRejected(error, progress.name)) {
        progressIndex += 1;
      } else {
        throw error;
      }
    }
  }
}
