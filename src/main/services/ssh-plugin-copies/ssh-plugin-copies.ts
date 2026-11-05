import { shellQuotePosix } from '../../../shared/lib/shell-quote';
import { createLogger } from '../../lib/logger';
import { tarArchive, type TarEntry } from '../../lib/tar-archive';

const logger = createLogger('SshPluginCopies');

/** How long Komla trusts that a copy it made or saw is still on its host. */
const COPY_CHECK_TTL_MS = 10 * 60_000;
/** How long after a copy failed Komla tries again, so failing hosts aren't sent it every poll. */
const RETRY_AFTER_MS = 60_000;
/**
 * How many minutes a revision the plugin no longer runs stays, for commands still using it: a
 * sync or copy marks it, and one at least this many minutes later removes it.
 */
const SUPERSEDED_MINUTES = 10;
/** How many minutes a copy left half made, by a connection that dropped, stays. */
const ABANDONED_MINUTES = 60;
/** A copy's folder name: the start of its digest, enough to tell one revision from the next. */
const DIGEST_LENGTH = 16;
const READY = 'komla-plugin-copy-ready';

export interface SshPluginCopiesDependencies {
  /** The plugins that run and may run something on an SSH host, with their files' digests. */
  plugins(): { id: string; digest: string }[];
  /**
   * A plugin's files and their digest; throws unless they are still those of `digest`, but for a
   * plugin in development, which runs its files as they are.
   */
  files(pluginId: string, digest: string): Promise<{ entries: TarEntry[]; digest: string }>;
  /** The folder on the host that holds this installation's copies, one folder per plugin. */
  root(hostId: string): Promise<string>;
  run(hostId: string, script: string): Promise<string>;
  /** Runs the script with the archive as its standard input. */
  upload(hostId: string, script: string, archive: Buffer): Promise<string>;
  now(): number;
}

interface Copy {
  digest: string;
  promise: Promise<string>;
  /** When Komla last knew the copy was there; undefined while it's being made. */
  checkedAt?: number;
  /** When making it failed. */
  failedAt?: number;
  /** Where it is, once Komla knows. */
  folder?: string;
}

function revision(digest: string): string {
  return digest.slice(0, DIGEST_LENGTH);
}

/**
 * Copies of the plugins that run, on the SSH hosts where their commands do, so a command finds
 * its plugin's files at `KOMLA_PLUGIN_DIR` there as it does on this computer. A copy holds the
 * files the user turned on, by their digest, and each revision has a folder of its own, so a
 * command still running keeps its files while the next revision is copied. Each installation
 * keeps its own copies, and removes those of revisions and plugins it no longer runs a while
 * after they stop.
 */
export class SshPluginCopies {
  private readonly copies = new Map<string, Map<string, Copy>>();
  /** Until when a sync needn't ask the host again, unless the plugins change. */
  private readonly synced = new Map<string, { plugins: string; until: number }>();
  private readonly syncing = new Map<string, Promise<void>>();
  /** Changes when Komla forgets a host, so a sync that started before then keeps nothing. */
  private readonly generations = new Map<string, number>();

  constructor(private readonly dependencies: SshPluginCopiesDependencies) {}

  /**
   * Where a plugin that runs has its files on the host, copying them there first if they aren't;
   * undefined for a plugin that doesn't run or doesn't run anything on SSH hosts.
   */
  async folder(hostId: string, pluginId: string): Promise<string | undefined> {
    const plugin = this.dependencies.plugins().find(({ id }) => id === pluginId);
    if (!plugin) return undefined;
    return this.copy(hostId, plugin, false);
  }

  /**
   * Where the plugin's copy is on the host if Komla knows it's there now, without asking the host
   * or copying it, which a sync or a command that waits for it does.
   */
  knownFolder(hostId: string, pluginId: string): string | undefined {
    const known = this.copies.get(hostId)?.get(pluginId);
    if (known?.checkedAt === undefined) return undefined;
    if (this.dependencies.now() - known.checkedAt >= COPY_CHECK_TTL_MS) return undefined;
    const plugin = this.dependencies.plugins().find(({ id }) => id === pluginId);
    return plugin?.digest === known.digest ? known.folder : undefined;
  }

  /**
   * Makes the host's copies those of the plugins that run: copies the ones it lacks, and removes
   * the rest of this installation's once they've been left a while for commands still using
   * them. It asks the host again only after the plugins change or after a while, as SSH
   * Workspace Sync reads a host every half minute.
   */
  syncHost(hostId: string): Promise<void> {
    const running = this.syncing.get(hostId);
    if (running) return running;
    const promise = this.sync(hostId).finally(() => this.syncing.delete(hostId));
    this.syncing.set(hostId, promise);
    return promise;
  }

  /** Forgets what the host had, as after the host was edited or removed. */
  forgetHost(hostId: string): void {
    this.copies.delete(hostId);
    this.synced.delete(hostId);
    this.syncing.delete(hostId);
    this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1);
  }

  private hostCopies(hostId: string): Map<string, Copy> {
    const host = this.copies.get(hostId) ?? new Map<string, Copy>();
    this.copies.set(hostId, host);
    return host;
  }

  /**
   * The plugin's copy: the one Komla is making, a failure until it's time to try again, or one it
   * knows is there, unless `missing` says the host just reported it gone; otherwise a new one.
   */
  private copy(
    hostId: string,
    plugin: { id: string; digest: string },
    missing: boolean
  ): Promise<string> {
    const host = this.hostCopies(hostId);
    const known = host.get(plugin.id);
    const now = this.dependencies.now();
    if (known?.digest === plugin.digest) {
      if (known.failedAt !== undefined) {
        if (now - known.failedAt < RETRY_AFTER_MS) return known.promise;
      } else if (known.checkedAt === undefined) {
        return known.promise;
      } else if (!missing && now - known.checkedAt < COPY_CHECK_TTL_MS) {
        return known.promise;
      }
    }
    const copy: Copy = { digest: plugin.digest, promise: this.ensure(hostId, plugin, missing) };
    host.set(plugin.id, copy);
    copy.promise.then(
      (folder) => {
        copy.checkedAt = this.dependencies.now();
        copy.folder = folder;
      },
      () => {
        copy.failedAt = this.dependencies.now();
      }
    );
    return copy.promise;
  }

  private async sync(hostId: string): Promise<void> {
    const plugins = this.dependencies.plugins();
    const key = plugins.map(({ id, digest }) => `${id}/${digest}`).join(' ');
    const last = this.synced.get(hostId);
    if (last?.plugins === key && this.dependencies.now() < last.until) return;
    const generation = this.generations.get(hostId);
    const root = await this.dependencies.root(hostId);
    const keep = plugins.map(({ id, digest }) => `${id}/${revision(digest)}`);
    const output = await this.dependencies.run(
      hostId,
      pruneScript(
        root,
        keep,
        plugins.map(({ id }) => id)
      )
    );
    // Komla forgot the host meanwhile, as after it was edited: what this read is of another.
    if (this.generations.get(hostId) !== generation) return;
    const present = new Set(output.split('\n').map((line) => line.trim()));
    const checkedAt = this.dependencies.now();
    const host = this.hostCopies(hostId);
    let failed = false;
    await Promise.all(
      plugins.map(async (plugin) => {
        const name = `${plugin.id}/${revision(plugin.digest)}`;
        const known = host.get(plugin.id);
        const settled = known?.checkedAt !== undefined || known?.failedAt !== undefined;
        if (present.has(name) && (!known || known.digest !== plugin.digest || settled)) {
          const folder = `${root}/${name}`;
          const promise = Promise.resolve(folder);
          host.set(plugin.id, { digest: plugin.digest, promise, checkedAt, folder });
          return;
        }
        try {
          await this.copy(hostId, plugin, !present.has(name));
        } catch (error) {
          failed = true;
          logger.warn(`Could not copy plugin ${plugin.id} to SSH host ${hostId}`, error);
        }
      })
    );
    if (this.generations.get(hostId) !== generation) return;
    // A copy that failed is tried again once it may be.
    const until = checkedAt + (failed ? RETRY_AFTER_MS : COPY_CHECK_TTL_MS);
    this.synced.set(hostId, { plugins: key, until });
  }

  private async ensure(
    hostId: string,
    plugin: { id: string; digest: string },
    missing: boolean
  ): Promise<string> {
    const root = await this.dependencies.root(hostId);
    const parent = `${root}/${plugin.id}`;
    if (!missing) {
      const name = revision(plugin.digest);
      const folder = `${parent}/${name}`;
      // One that runs is unmarked, should a copy that finished late have marked it.
      const checked = await this.dependencies.run(
        hostId,
        [
          `if [ -d ${shellQuotePosix(folder)} ]; then`,
          `  rm -f ${shellQuotePosix(`${parent}/.komla-superseded.${name}`)}`,
          `  printf ${READY}`,
          'fi',
        ].join('\n')
      );
      if (checked.includes(READY)) return folder;
    }
    const files = await this.dependencies.files(plugin.id, plugin.digest);
    // By the files it holds, which for a plugin in development may be newer than its digest.
    const folder = `${parent}/${revision(files.digest)}`;
    const archive = tarArchive(files.entries, Math.floor(this.dependencies.now() / 1000));
    await this.dependencies.upload(hostId, copyScript(parent, folder), archive);
    logger.info(`Copied plugin ${plugin.id} to SSH host ${hostId}`, { folder });
    return folder;
  }
}

/** Shell lines that mark `$copy`, a revision no longer run, and remove it once marked a while. */
const RETIRE_COPY = [
  'mark="${copy%/*}/.komla-superseded.${copy##*/}"',
  'if [ ! -e "$mark" ]; then',
  '  : > "$mark"',
  `elif [ -n "$(find "$mark" -mmin +${SUPERSEDED_MINUTES - 1} 2>/dev/null)" ]; then`,
  '  rm -rf "$copy" && rm -f "$mark"',
  'fi',
];

/** Shell lines that remove what's left in the plugin's folder `$plugin`: half copies, old marks. */
const CLEAN_PLUGIN = [
  `find "$plugin" -maxdepth 1 -name '.komla.*' -mmin +${ABANDONED_MINUTES} -exec rm -rf {} + 2>/dev/null || true`,
  'for mark in "$plugin"/.komla-superseded.*; do',
  '  [ -e "$mark" ] || continue',
  '  [ -d "$plugin/${mark##*/.komla-superseded.}" ] || rm -f "$mark"',
  'done',
];

/**
 * Extracts the archive on standard input into the copy's folder, through a folder of its own so
 * a command never sees half a copy, and retires the plugin's other revisions. A copy that
 * finishes late marks the one that runs now, but a sync, or a command checking it, unmarks it.
 */
function copyScript(parent: string, folder: string): string {
  return [
    'set -e',
    'umask 077',
    `plugin=${shellQuotePosix(parent)}`,
    `folder=${shellQuotePosix(folder)}`,
    'mkdir -p "$plugin"',
    'temp=$(mktemp -d "$plugin/.komla.XXXXXX")',
    'trap \'rm -rf "$temp"\' 0',
    "trap 'exit 1' HUP INT TERM",
    'tar -xf - -C "$temp"',
    // Another run copied it first.
    '[ -e "$folder" ] || mv "$temp" "$folder"',
    'rm -f "$plugin/.komla-superseded.${folder##*/}"',
    'set +e',
    'for copy in "$plugin"/*; do',
    '  [ -d "$copy" ] && [ "$copy" != "$folder" ] || continue',
    ...RETIRE_COPY.map((line) => `  ${line}`),
    'done',
    ...CLEAN_PLUGIN,
    'exit 0',
  ].join('\n');
}

/**
 * Prints which of `keep`, `<id>/<revision>`, this installation's copies have, unmarking them,
 * and retires the rest: it marks a revision no plugin runs with `.komla-superseded.<revision>`
 * beside it, and one at least `SUPERSEDED_MINUTES` later removes it. It also removes copies left
 * half made, and the folders of plugins that don't run once they're empty.
 */
function pruneScript(root: string, keep: string[], ids: string[]): string {
  return [
    `root=${shellQuotePosix(root)}`,
    '[ -d "$root" ] || exit 0',
    `keep=${shellQuotePosix(` ${keep.join(' ')} `)}`,
    `ids=${shellQuotePosix(` ${ids.join(' ')} `)}`,
    'for plugin in "$root"/*; do',
    '  [ -d "$plugin" ] || continue',
    '  id=${plugin##*/}',
    '  for copy in "$plugin"/*; do',
    '    [ -d "$copy" ] || continue',
    '    case "$keep" in',
    '      *" $id/${copy##*/} "*)',
    '        rm -f "$plugin/.komla-superseded.${copy##*/}"',
    '        printf "%s\\n" "$id/${copy##*/}" ;;',
    '      *)',
    ...RETIRE_COPY.map((line) => `        ${line}`),
    '        ;;',
    '    esac',
    '  done',
    ...CLEAN_PLUGIN.map((line) => `  ${line}`),
    '  case "$ids" in',
    '    *" $id "*) ;;',
    '    *) rmdir "$plugin" 2>/dev/null || true ;;',
    '  esac',
    'done',
  ].join('\n');
}
