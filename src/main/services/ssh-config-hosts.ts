import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { isValidSshHostname, type SshConfigHost } from '../../shared/types';

// OpenSSH stops at the same depth.
const MAX_INCLUDE_DEPTH = 16;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_INCLUDE_MATCHES = 256;

const WILDCARD = /[*?]/;

/**
 * The concrete Host entries in the user's ~/.ssh/config and the files it includes, in file order.
 * Patterns and negations are left out: they describe many hosts, not one to connect to. Values
 * come from each entry's own block only, so defaults from `Host *` aren't shown.
 */
export async function listSshConfigHosts(home = homedir()): Promise<SshConfigHost[]> {
  const sshDir = path.join(home, '.ssh');
  const lines = await readConfigLines(path.join(sshDir, 'config'), { home, sshDir }, []);
  return parseHosts(lines);
}

interface IncludeContext {
  home: string;
  sshDir: string;
}

/** A file's lines, with the lines of each file an Include names nested where it appears. */
type ConfigLines = Array<string | ConfigLines>;

async function readConfigLines(
  file: string,
  context: IncludeContext,
  stack: string[]
): Promise<ConfigLines> {
  if (stack.length > MAX_INCLUDE_DEPTH) return [];
  const content = await readSmallFile(file);
  if (content === null) return [];
  const canonical = await realpath(file).catch(() => file);
  if (stack.includes(canonical)) return [];

  const lines: ConfigLines = [];
  for (const line of content.split(/\r?\n/)) {
    const directive = parseDirective(line);
    if (directive?.keyword !== 'include') {
      lines.push(line);
      continue;
    }
    for (const pattern of directive.args) {
      for (const included of await resolveInclude(pattern, context)) {
        lines.push(await readConfigLines(included, context, [...stack, canonical]));
      }
    }
  }
  return lines;
}

async function readSmallFile(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** The files an Include names: relative paths are under ~/.ssh, and the last segment may be a glob. */
async function resolveInclude(pattern: string, { home, sshDir }: IncludeContext) {
  const expanded =
    pattern === '~' || pattern.startsWith('~/') ? path.join(home, pattern.slice(1)) : pattern;
  const absolute = path.resolve(sshDir, expanded);
  const dir = path.dirname(absolute);
  const name = path.basename(absolute);
  if (!WILDCARD.test(name)) return [absolute];
  if (WILDCARD.test(dir)) return [];
  const matcher = globMatcher(name);
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries
    .filter((entry) => matcher.test(entry))
    .sort()
    .slice(0, MAX_INCLUDE_MATCHES)
    .map((entry) => path.join(dir, entry));
}

function globMatcher(glob: string): RegExp {
  const source = glob
    .split('')
    .map((char) =>
      char === '*' ? '[^/]*' : char === '?' ? '[^/]' : char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    )
    .join('');
  // Like the shell, a wildcard doesn't match a leading dot.
  return new RegExp(`^(?!\\.)${source}$`);
}

function parseDirective(line: string): { keyword: string; args: string[] } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(/^([^\s=]+)\s*(?:=\s*|\s)(.*)$/);
  if (!match) return null;
  return { keyword: match[1].toLowerCase(), args: splitArgs(match[2]) };
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (!quoted && char === '#') {
      break;
    } else if (!quoted && /\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

/** An alias for one machine that Komla accepts as a host, unlike a pattern or a negation. */
function isConcreteAlias(pattern: string): boolean {
  return (
    !pattern.startsWith('!') &&
    !WILDCARD.test(pattern) &&
    !pattern.includes('%') &&
    isValidSshHostname(pattern)
  );
}

function parseHosts(lines: ConfigLines): SshConfigHost[] {
  const hosts = new Map<string, SshConfigHost>();
  // The entries the current block configures; a Match block or a Host line of patterns has none.
  let block: SshConfigHost[] = [];

  const parse = (entries: ConfigLines) => {
    for (const line of entries) {
      if (typeof line !== 'string') {
        // As in ssh, the block an Include sits in carries on after the included files.
        const enclosing = block;
        parse(line);
        block = enclosing;
        continue;
      }
      const directive = parseDirective(line);
      if (!directive) continue;
      const { keyword, args } = directive;
      if (keyword === 'host') {
        // A second block for an alias fills in only what earlier ones left unset, as in ssh.
        block = args.filter(isConcreteAlias).map((alias) => {
          const key = alias.toLowerCase();
          const host = hosts.get(key) ?? { alias };
          hosts.set(key, host);
          return host;
        });
        continue;
      }
      if (keyword === 'match') {
        block = [];
        continue;
      }
      const value = args[0];
      if (!value) continue;
      for (const host of block) {
        if (keyword === 'hostname') host.hostname ??= value.replaceAll('%h', host.alias);
        else if (keyword === 'user') host.user ??= value;
        else if (keyword === 'port') host.port ??= parsePort(value);
        else if (keyword === 'identityfile') host.identityFile ??= value;
        else if (keyword === 'proxyjump') host.proxyJump ??= value;
      }
    }
  };
  parse(lines);
  return [...hosts.values()];
}

function parsePort(value: string): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
}
