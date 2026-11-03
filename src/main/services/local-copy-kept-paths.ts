import { shellQuotePosix } from '../../shared/lib/shell-quote';

/**
 * rsync reads a .gitignore, through `--filter=:- .gitignore`, but not as Git does. It skips every
 * path an ignore pattern matches, even one Git tracks, such as a file added with `git add -f`, and
 * it doesn't honor `!` re-includes. Under `/tmp/*` and `!/tmp/pids/.keep`, the folder a `.keep`
 * holds never reached the local copy, and a dev server that writes into it failed.
 *
 * Git can list exactly those paths: the ones it keeps although an ignore pattern matches them.
 * Rules that include them, ahead of the .gitignore filter, copy what Git sees. A list that is out
 * of date only leaves a new one out until the next sync, and never copies an ignored file, so the
 * .gitignore filter keeps the final say on everything else.
 */

// Marks where Git's output starts, after anything a login shell prints first.
const OUTPUT_MARKER = 'komla-git-paths';

const CHECK_IGNORE = 'git check-ignore -z -v --no-index --stdin';
// `git check-ignore` exits 1 when it matched nothing, which isn't a failure here.
const UNLESS_FAILED = 'status=$?; [ "$status" -le 1 ] || exit "$status"';

// Prints each folder above a listed path once, without a trailing `/`, so Git looks at what it is.
// awk reads lines, so a name with a line break also gives the folders its pieces would name. At
// worst, that copies an empty folder. In the C locale, a name in any encoding passes as bytes.
const PARENT_FOLDERS = [
  "LC_ALL=C tr '\\0' '\\n' <\"$listing\"",
  'LC_ALL=C awk -F/ \'{ path = $1; for (i = 2; i <= NF; i++) { if (!(path in seen)) { seen[path] = 1; print path }; path = path "/" $i } }\'',
  "LC_ALL=C tr '\\n' '\\0'",
].join(' | ');

/** The paths Git keeps although an ignore pattern matches them, or the folders holding them. */
export interface KeptPaths {
  files: string[];
  /** Whether Git ignores a folder, which only a tracked file in it can be kept from. */
  folders: Array<{ path: string; ignored: boolean }>;
}

/**
 * A remote command that lists the paths Git keeps in `remoteDirectory` although an ignore pattern
 * matches them, and then each folder above a path Git keeps that a pattern matches itself. A folder
 * matters on its own: under `/tmp/*` and `!/tmp/pids/`, no pattern matches the tracked
 * `tmp/pids/.keep`, but rsync leaves out its folder. It prints nothing outside a Git work tree.
 */
export function buildKeptPathsCommand(remoteDirectory: string): string {
  return [
    `cd ${shellQuotePosix(remoteDirectory)} || exit 1`,
    'git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0',
    'listing=$(mktemp) || exit 1',
    `trap 'rm -f "$listing"' EXIT`,
    `trap 'exit 1' HUP INT TERM`,
    'git ls-files -z --cached --others --exclude-standard >"$listing" || exit 1',
    `printf '%s\\n' ${OUTPUT_MARKER}`,
    `${CHECK_IGNORE} <"$listing"`,
    UNLESS_FAILED,
    // An empty match separates the files from the folders.
    "printf '\\0\\0\\0\\0'",
    `${PARENT_FOLDERS} | ${CHECK_IGNORE}`,
    UNLESS_FAILED,
  ].join('\n');
}

/** The output of `buildKeptPathsCommand`, or undefined outside a Git work tree. */
export function parseKeptPaths(output: string): KeptPaths | undefined {
  const marker = `${OUTPUT_MARKER}\n`;
  // The marker starts a line, the first one included.
  const start = `\n${output}`.indexOf(`\n${marker}`);
  if (start === -1) return undefined;
  const fields = output.slice(start + marker.length).split('\0');
  const kept: KeptPaths = { files: [], folders: [] };
  let inFolders = false;
  // Each match is the source, line number, pattern and path.
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const [pattern, path] = [fields[index + 2], fields[index + 3]];
    if (!path) {
      inFolders = true;
    } else if (inFolders) {
      kept.folders.push({ path, ignored: !pattern.startsWith('!') });
    } else {
      kept.files.push(path);
    }
  }
  return kept;
}

/** The folders above `path`, outermost first, each without a trailing `/`. */
function parentFolders(path: string): string[] {
  const parts = path.replace(/\/+$/, '').split('/').slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
}

/**
 * The rsync rules that copy the kept paths: include rules for each path and the folders above it,
 * and then, for a folder Git ignores, an exclude rule for everything in it the includes didn't
 * name. rsync reads such a folder only because a tracked file is in it, and Git ignores all the
 * rest.
 */
export function keptPathRules({ files, folders }: KeptPaths): {
  include: string[];
  exclude: string[];
} {
  const include = new Set<string>();
  const add = (path: string, suffix: string) => {
    for (const parent of parentFolders(path)) include.add(rsyncPattern(parent, '/'));
    include.add(rsyncPattern(path, suffix));
  };
  for (const { path } of folders) add(path, '/');
  for (const file of files) add(file, '');
  return {
    include: [...include],
    exclude: folders.filter(({ ignored }) => ignored).map(({ path }) => rsyncPattern(path, '/*')),
  };
}

/**
 * An rsync pattern, one line of an `--include-from` or `--exclude-from` file, that matches `path`
 * from the root of the transfer, followed by `suffix` as pattern syntax.
 *
 * rsync matches a pattern literally unless it contains `*`, `?` or `[`, and then a backslash
 * escapes. A line can't hold a line break, so one in a name matches any character instead. At
 * worst, that also matches a file whose name differs only there.
 */
export function rsyncPattern(path: string, suffix = ''): string {
  if (!/[*?[\r\n]/.test(path + suffix)) return `/${path}${suffix}`;
  return `/${path.replace(/[\\*?[]/g, '\\$&').replace(/[\r\n]/g, '?')}${suffix}`;
}
