import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

import ignore, { type Ignore } from 'ignore';

interface GitignoreScope {
  base: string;
  matcher: Ignore;
}

/**
 * Translates one .gitignore into rsync protect rules for its directory.
 *
 * `--filter=:- .gitignore` keeps ignored remote files out of the transfer, but
 * macOS openrsync does not apply per-directory merge rules when deleting, so
 * local-only ignored files (.env, dependencies) would be removed on every sync.
 * Static protect rules only affect deletion and behave the same in GNU rsync.
 * Negations are skipped: protecting too much leaves a stale file, never loses one.
 */
export function gitignoreToProtectRules(content: string, directory: string): string[] {
  const base = directory ? `/${directory}/` : '/';
  const rules: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;

    const dirSuffix = line.endsWith('/') ? '/' : '';
    let body = line.replace(/\/+$/, '');
    let anchored = body.includes('/');
    // `**/**/` matches the same paths as `**/`, and `/**/x` the same as `**/x`.
    body = body.replace(/^\/+/, '').replace(/(?:\*\*\/)+/g, '**/');
    const anyDepth = body.startsWith('**/');
    if (anyDepth) {
      body = body.slice(3);
      anchored = body.includes('/');
    }
    if (!body) continue;

    if (anchored) {
      // rsync anchors a pattern containing "/", so a leading **/ needs its own any-depth rule.
      for (const path of anyDepth ? [body, `**/${body}`] : [body]) {
        for (const variant of withEmptyDoubleStars(path)) {
          rules.push(`P ${base}${variant}${dirSuffix}`);
        }
      }
    } else if (!directory) {
      rules.push(`P ${body}${dirSuffix}`);
    } else {
      rules.push(`P ${base}${body}${dirSuffix}`, `P ${base}**/${body}${dirSuffix}`);
    }
  }
  return rules;
}

// Git's `a/**/b` also matches `a/b`, but rsync's `/**/` needs at least one directory,
// so each `/**/` also gets a collapsed variant.
function withEmptyDoubleStars(path: string): string[] {
  const index = path.indexOf('/**/');
  if (index === -1) return [path];
  const head = path.slice(0, index);
  const tails = withEmptyDoubleStars(path.slice(index + 4));
  return [...tails.map((tail) => `${head}/**/${tail}`), ...tails.map((tail) => `${head}/${tail}`)];
}

/** Collects protect rules from every .gitignore in a local copy, skipping ignored directories. */
export async function collectGitignoreProtectRules(
  root: string,
  skippedNames: ReadonlySet<string>
): Promise<string[]> {
  const rules: string[] = [];
  const visit = async (relativeDir: string, scopes: GitignoreScope[]): Promise<void> => {
    const absoluteDir = relativeDir ? join(root, relativeDir) : root;
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }

    let nextScopes = scopes;
    if (entries.some((entry) => entry.isFile() && entry.name === '.gitignore')) {
      try {
        const content = await readFile(join(absoluteDir, '.gitignore'), 'utf8');
        rules.push(...gitignoreToProtectRules(content, relativeDir));
        nextScopes = [...scopes, { base: relativeDir, matcher: ignore().add(content) }];
      } catch {
        // An unreadable .gitignore only means fewer protected files.
      }
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || (!relativeDir && skippedNames.has(entry.name))) continue;
      const child = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const ignored = nextScopes.some(({ base, matcher }) =>
        matcher.ignores(`${base ? child.slice(base.length + 1) : child}/`)
      );
      // Git never reads .gitignore files inside ignored directories either.
      if (!ignored) await visit(child, nextScopes);
    }
  };

  await visit('', []);
  return rules;
}
