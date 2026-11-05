import { execFile } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  SshPluginCopies,
  type SshPluginCopiesDependencies,
} from '../../../src/main/services/ssh-plugin-copies/ssh-plugin-copies';

import type { TarEntry } from '../../../src/main/lib/tar-archive';

const exec = promisify(execFile);

/** Makes a file look `minutes` old, as the host's `find -mmin` sees it. */
function age(path: string, minutes: number): void {
  const then = new Date(Date.now() - minutes * 60_000);
  utimesSync(path, then, then);
}
const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

/** Runs the scripts in a shell here, as an SSH host would, in a folder standing in for it. */
function setup(initial: { id: string; digest: string }[]) {
  const host = mkdtempSync(join(tmpdir(), 'komla-plugin-copies-'));
  const root = join(host, 'plugins', 'installation');
  let plugins = initial;
  let time = 1_000_000;
  let currentRoot = root;
  /** What a plugin in development has now, newer than the digest Komla runs it at. */
  const contentDigests: Record<string, string> = {};
  const files: Record<string, TarEntry[]> = {
    prs: [
      { kind: 'file', path: 'komla-plugin.json', content: Buffer.from('{}') },
      { kind: 'file', path: 'pr.sh', content: Buffer.from('echo PR'), executable: true },
    ],
    code: [{ kind: 'file', path: 'main.js', content: Buffer.from('export {}') }],
  };
  const run = vi.fn(async (_hostId: string, script: string) => {
    return (await exec('sh', ['-c', script])).stdout;
  });
  const upload = vi.fn(
    (_hostId: string, script: string, archive: Buffer) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile('sh', ['-c', script], (error, stdout) =>
          error ? reject(error) : resolve(stdout)
        );
        child.stdin!.end(archive);
      })
  );
  const dependencies: SshPluginCopiesDependencies = {
    plugins: () => plugins,
    files: vi.fn(async (id: string, digest: string) => ({
      entries: files[id] ?? [],
      digest: contentDigests[id] ?? digest,
    })),
    root: async () => currentRoot,
    run,
    upload,
    now: () => time,
  };
  return {
    host,
    root,
    copies: new SshPluginCopies(dependencies),
    dependencies,
    run,
    upload,
    setPlugins: (next: typeof plugins) => {
      plugins = next;
    },
    advance: (ms: number) => {
      time += ms;
    },
    moveRoot: (next: string) => {
      currentRoot = next;
    },
    contentDigests,
  };
}

// The scripts are for an SSH host's POSIX shell, which Windows has none of.
describe.skipIf(process.platform === 'win32')('SshPluginCopies', () => {
  let made: ReturnType<typeof setup>;

  beforeEach(() => {
    made = setup([{ id: 'prs', digest: digestA }]);
  });

  afterEach(() => {
    rmSync(made.host, { recursive: true, force: true });
  });

  it("copies a plugin's files to the host when a command first needs them, once", async () => {
    const { copies, root, upload } = made;

    const [folder, again] = await Promise.all([
      copies.folder('host-1', 'prs'),
      copies.folder('host-1', 'prs'),
    ]);

    expect(folder).toBe(join(root, 'prs', 'a'.repeat(16)));
    expect(again).toBe(folder);
    expect(readFileSync(join(folder!, 'pr.sh'), 'utf8')).toBe('echo PR');
    expect((await exec('sh', ['-c', `"${folder}/pr.sh"`])).stdout).toBe('PR\n');
    expect(upload).toHaveBeenCalledTimes(1);
    await copies.folder('host-1', 'prs');
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("doesn't copy a plugin that doesn't run", async () => {
    expect(await made.copies.folder('host-1', 'other')).toBeUndefined();
    expect(made.run).not.toHaveBeenCalled();
  });

  it('uses a copy already on the host, as after Komla restarts', async () => {
    await made.copies.folder('host-1', 'prs');
    const restarted = new SshPluginCopies(made.dependencies);

    expect(await restarted.folder('host-1', 'prs')).toBe(join(made.root, 'prs', 'a'.repeat(16)));
    expect(made.upload).toHaveBeenCalledTimes(1);
  });

  it("copies a plugin's new files to a folder of their own, beside the old one", async () => {
    const { copies, root, setPlugins } = made;
    const old = await copies.folder('host-1', 'prs');

    setPlugins([{ id: 'prs', digest: digestB }]);
    const next = await copies.folder('host-1', 'prs');

    expect(next).toBe(join(root, 'prs', 'b'.repeat(16)));
    // A command still running keeps its files, until a sync removes them.
    expect(existsSync(old!)).toBe(true);
  });

  it("doesn't let a copy that finishes late remove the one that runs now", async () => {
    const { copies, root, setPlugins, upload } = made;
    let finishOld: () => void = () => {};
    const realUpload = upload.getMockImplementation()!;
    upload.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        finishOld = resolve;
      });
      return realUpload(...args);
    });
    const old = copies.folder('host-1', 'prs');
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));

    setPlugins([{ id: 'prs', digest: digestB }]);
    const next = await copies.folder('host-1', 'prs');
    finishOld();
    await old;

    // It marks the one that runs now, which the next sync unmarks before it would go.
    expect(existsSync(next!)).toBe(true);
    expect(readdirSync(join(root, 'prs')).sort()).toEqual([
      '.komla-superseded.' + 'b'.repeat(16),
      'a'.repeat(16),
      'b'.repeat(16),
    ]);
    await copies.syncHost('host-1');
    expect(readdirSync(join(root, 'prs')).sort()).toEqual([
      '.komla-superseded.' + 'a'.repeat(16),
      'a'.repeat(16),
      'b'.repeat(16),
    ]);
  });

  it('waits a minute before trying a failed copy again', async () => {
    const { copies, upload, advance } = made;
    upload.mockRejectedValueOnce(new Error('No space left on device'));

    await expect(copies.folder('host-1', 'prs')).rejects.toThrow('No space left on device');
    await expect(copies.folder('host-1', 'prs')).rejects.toThrow('No space left on device');
    await copies.syncHost('host-1');
    expect(upload).toHaveBeenCalledTimes(1);

    advance(61_000);
    expect(await copies.folder('host-1', 'prs')).toBeDefined();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('starts again for a host Komla forgot, as after the host was edited', async () => {
    const { copies, host, upload, moveRoot } = made;
    await copies.folder('host-1', 'prs');

    moveRoot(join(host, 'elsewhere'));
    copies.forgetHost('host-1');
    const folder = await copies.folder('host-1', 'prs');

    expect(folder).toBe(join(host, 'elsewhere', 'prs', 'a'.repeat(16)));
    expect(existsSync(folder!)).toBe(true);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('names a copy by the files it holds, which a plugin in development may have newer', async () => {
    made.contentDigests.prs = 'd'.repeat(64);

    expect(await made.copies.folder('host-1', 'prs')).toBe(join(made.root, 'prs', 'd'.repeat(16)));
  });

  it('gives a command that names no folder the copy only once Komla knows it is there', async () => {
    const { copies, root, upload, setPlugins } = made;

    expect(copies.knownFolder('host-1', 'prs')).toBeUndefined();
    // It doesn't copy for such a command, which needn't wait or fail on a copy.
    expect(upload).not.toHaveBeenCalled();

    await copies.folder('host-1', 'prs');
    expect(copies.knownFolder('host-1', 'prs')).toBe(join(root, 'prs', 'a'.repeat(16)));

    setPlugins([{ id: 'prs', digest: digestB }]);
    expect(copies.knownFolder('host-1', 'prs')).toBeUndefined();
  });

  it('keeps nothing from a sync that was running when Komla forgot the host', async () => {
    const { copies, run, host, moveRoot, upload } = made;
    let finish: () => void = () => {};
    const realRun = run.getMockImplementation()!;
    run.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return realRun(...args);
    });
    const sync = copies.syncHost('host-1');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));

    moveRoot(join(host, 'elsewhere'));
    copies.forgetHost('host-1');
    finish();
    await sync;

    expect(copies.knownFolder('host-1', 'prs')).toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
    expect(await copies.folder('host-1', 'prs')).toBe(
      join(host, 'elsewhere', 'prs', 'a'.repeat(16))
    );
  });

  it('unmarks the copy that runs when a command checks it, on a host SSH Workspace Sync never reads', async () => {
    const { copies, root, advance } = made;
    const folder = await copies.folder('host-1', 'prs');
    // As a copy of an older revision that finished late would have marked it.
    const mark = join(root, 'prs', `.komla-superseded.${'a'.repeat(16)}`);
    writeFileSync(mark, '');

    advance(11 * 60_000);
    expect(await copies.folder('host-1', 'prs')).toBe(folder);

    expect(existsSync(mark)).toBe(false);
  });

  it('retires old revisions as it copies new ones, for a host SSH Workspace Sync never reads', async () => {
    const { copies, root, setPlugins } = made;
    const first = await copies.folder('host-1', 'prs');
    setPlugins([{ id: 'prs', digest: digestB }]);
    await copies.folder('host-1', 'prs');
    const mark = join(root, 'prs', `.komla-superseded.${'a'.repeat(16)}`);
    expect(existsSync(first!)).toBe(true);
    expect(existsSync(mark)).toBe(true);

    age(mark, 11);
    setPlugins([{ id: 'prs', digest: 'c'.repeat(64) }]);
    await copies.folder('host-1', 'prs');

    expect(readdirSync(join(root, 'prs')).sort()).toEqual([
      '.komla-superseded.' + 'b'.repeat(16),
      'b'.repeat(16),
      'c'.repeat(16),
    ]);
  });

  it('waits for a copy still being made before it counts a sync as done', async () => {
    const { copies, upload, advance } = made;
    let fail: (error: Error) => void = () => {};
    upload.mockImplementationOnce(
      () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject;
        })
    );
    const command = copies.folder('host-1', 'prs').catch(() => undefined);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));

    const sync = copies.syncHost('host-1');
    fail(new Error('No space left on device'));
    await Promise.all([command, sync]);

    // It tries again once it may, not ten minutes later.
    advance(61_000);
    await copies.syncHost('host-1');
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("checks again after a while that a copy is still there, as the host's files may go", async () => {
    const { copies, upload, advance } = made;
    const folder = await copies.folder('host-1', 'prs');
    rmSync(folder!, { recursive: true });

    advance(11 * 60_000);
    await copies.folder('host-1', 'prs');

    expect(upload).toHaveBeenCalledTimes(2);
    expect(existsSync(folder!)).toBe(true);
  });

  it("syncs a host to the plugins that run: copies the missing, removes others' after a while", async () => {
    const { copies, root, setPlugins, advance, run } = made;
    mkdirSync(join(root, 'gone', 'c'.repeat(16)), { recursive: true });
    mkdirSync(join(root, 'prs', 'c'.repeat(16)), { recursive: true });
    setPlugins([
      { id: 'prs', digest: digestA },
      { id: 'code', digest: digestB },
    ]);

    await copies.syncHost('host-1');

    expect(readFileSync(join(root, 'code', 'b'.repeat(16), 'main.js'), 'utf8')).toBe('export {}');
    // The prune just reported them missing, so the copies don't ask again.
    expect(run).toHaveBeenCalledTimes(1);
    // Left for commands still using them, marked.
    expect(existsSync(join(root, 'prs', 'c'.repeat(16)))).toBe(true);
    expect(existsSync(join(root, 'gone', 'c'.repeat(16)))).toBe(true);
    age(join(root, 'prs', `.komla-superseded.${'c'.repeat(16)}`), 11);
    age(join(root, 'gone', `.komla-superseded.${'c'.repeat(16)}`), 11);

    advance(11 * 60_000);
    await copies.syncHost('host-1');

    expect(readdirSync(root).sort()).toEqual(['code', 'prs']);
    expect(readdirSync(join(root, 'prs'))).toEqual(['a'.repeat(16)]);
  });

  it('keeps a revision that runs again, forgetting it was marked', async () => {
    const { copies, root, setPlugins, advance } = made;
    await copies.syncHost('host-1');
    setPlugins([{ id: 'prs', digest: digestB }]);
    await copies.syncHost('host-1');
    const mark = join(root, 'prs', `.komla-superseded.${'a'.repeat(16)}`);
    expect(existsSync(mark)).toBe(true);

    setPlugins([{ id: 'prs', digest: digestA }]);
    advance(1000);
    await copies.syncHost('host-1');

    expect(existsSync(mark)).toBe(false);
    expect(existsSync(join(root, 'prs', 'a'.repeat(16)))).toBe(true);
  });

  it('removes copies left half made by a connection that dropped, after an hour', async () => {
    const { copies, root } = made;
    const fresh = join(root, 'prs', '.komla.fresh');
    const abandoned = join(root, 'prs', '.komla.abandoned');
    mkdirSync(fresh, { recursive: true });
    mkdirSync(abandoned);
    age(abandoned, 61);

    await copies.syncHost('host-1');

    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(abandoned)).toBe(false);
  });

  it('asks the host again only once the plugins change or after a while', async () => {
    const { copies, run, setPlugins, advance } = made;
    await copies.syncHost('host-1');
    const calls = run.mock.calls.length;

    await copies.syncHost('host-1');
    expect(run).toHaveBeenCalledTimes(calls);

    setPlugins([{ id: 'prs', digest: digestB }]);
    await copies.syncHost('host-1');
    expect(run.mock.calls.length).toBeGreaterThan(calls);

    const after = run.mock.calls.length;
    advance(11 * 60_000);
    await copies.syncHost('host-1');
    expect(run.mock.calls.length).toBeGreaterThan(after);
  });

  it('copies again a copy the sync found gone, rather than trusting what it made before', async () => {
    const { copies, upload } = made;
    const folder = await copies.folder('host-1', 'prs');
    rmSync(folder!, { recursive: true });
    made.advance(11 * 60_000);

    await copies.syncHost('host-1');

    expect(upload).toHaveBeenCalledTimes(2);
    expect(existsSync(folder!)).toBe(true);
    expect(await copies.folder('host-1', 'prs')).toBe(folder);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('removes all its copies once no plugin runs', async () => {
    const { copies, root, setPlugins, advance } = made;
    await copies.folder('host-1', 'prs');

    setPlugins([]);
    await copies.syncHost('host-1');
    age(join(root, 'prs', `.komla-superseded.${'a'.repeat(16)}`), 11);
    advance(11 * 60_000);
    await copies.syncHost('host-1');

    expect(readdirSync(root)).toEqual([]);
  });

  it('reads a host without copies yet', async () => {
    made.setPlugins([]);
    await expect(made.copies.syncHost('host-1')).resolves.toBeUndefined();
  });
});
