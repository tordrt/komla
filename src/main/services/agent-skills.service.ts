import { readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import { load } from 'js-yaml';

import { SKILL_AGENTS, SKILL_NAME_CHAR } from '../../shared/lib/agent-skills';
import { shellQuotePosix } from '../../shared/lib/shell-quote';
import { createLogger } from '../lib/logger';

import { gitExec } from './git/git-exec';
import { sshWorkspaceService } from './ssh-workspace.service';

import type { AgentSkill, AgentSkillFamily } from '../../shared/types/agent-skill';

const logger = createLogger('AgentSkillsService');

// Starts each SKILL.md in a host's listing, followed by its skill folder's name.
const RECORD_SEPARATOR = '\x1e';
// Where a host stops reading a SKILL.md whose frontmatter never closes.
const FRONTMATTER_LINE_LIMIT = 1000;
const HOST_LISTING_TIMEOUT_MS = 15_000;
const SKILL_NAME_PATTERN = new RegExp(`^${SKILL_NAME_CHAR}+$`);
// Like the host's listing, a `---` line may end in spaces, and a file saved by a Windows editor
// may start with a byte order mark.
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * Where an agent finds skills: the user's in the home folder of the SSH host it runs on, or of
 * this computer, and the project's in a folder that is on that host too when projectDirOnHost.
 * With projectBranch, projectDir is a repo here with no checkout, a managed project's bare
 * clone, and the project's skills are the ones committed on that branch.
 */
export interface AgentSkillFolders {
  hostId: string | null;
  projectDir: string | null;
  projectDirOnHost: boolean;
  projectBranch?: string;
}

/** A listed skill, and how to read its SKILL.md where the agent finds it. */
interface FoundSkill {
  skill: AgentSkill;
  read: () => Promise<string>;
}

/**
 * Frontmatter that isn't strict YAML, read leniently: each `key: value` line split at its first
 * colon, and an indented line continuing the value above it.
 */
function readLooseFrontmatter(frontmatter: string): Record<string, unknown> {
  const fields: Record<string, string> = {};
  let key: string | null = null;
  for (const line of frontmatter.split(/\r?\n/)) {
    const entry = /^([\w-]+):[ \t]*(.*)$/.exec(line);
    if (entry) {
      key = entry[1];
      // A `>` or `|` starts a value on the lines below
      fields[key] = entry[2].replace(/^[>|][-+\d]*[ \t]*(?:#.*)?$/, '');
    } else if (key && /^[ \t]/.test(line)) {
      fields[key] = `${fields[key]} ${line.trim()}`;
    }
  }
  return Object.fromEntries(Object.entries(fields).map(([name, raw]) => [name, looseValue(raw)]));
}

function looseValue(raw: string): string | boolean {
  const text = raw.trim();
  const doubleQuoted = /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  if (doubleQuoted) return doubleQuoted[1].replace(/\\(.)/g, '$1');
  const singleQuoted = /^'((?:[^']|'')*)'$/.exec(text);
  if (singleQuoted) return singleQuoted[1].replace(/''/g, "'");
  // Unquoted, a `#` after a space starts a comment
  const value = text.replace(/[ \t]+#.*$/, '');
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  return value;
}

/**
 * A skill from a SKILL.md's frontmatter, named as its `name` says, else as its folder is.
 * Null for a file without frontmatter, with frontmatter that isn't strict YAML for an agent that
 * then skips the skill, with a name a prompt can't type, or that `user-invocable: false` keeps out
 * of the menu of an agent that reads that field.
 */
export function parseSkillFile(
  content: string,
  folderName: string,
  source: AgentSkill['source'],
  family: AgentSkillFamily
): Omit<AgentSkill, 'folder'> | null {
  const match = FRONTMATTER.exec(content);
  if (!match) return null;
  let frontmatter: unknown;
  try {
    frontmatter = load(match[1] ?? '');
  } catch {
    if (!SKILL_AGENTS[family].readsLooseFrontmatter) return null;
    frontmatter = readLooseFrontmatter(match[1] ?? '');
  }
  const fields = (frontmatter && typeof frontmatter === 'object' ? frontmatter : {}) as Record<
    string,
    unknown
  >;
  if (SKILL_AGENTS[family].honorsUserInvocable && fields['user-invocable'] === false) return null;
  const name = typeof fields.name === 'string' && fields.name.trim() ? fields.name : folderName;
  if (!SKILL_NAME_PATTERN.test(name.trim())) return null;
  const description =
    typeof fields.description === 'string' ? fields.description.replace(/\s+/g, ' ').trim() : '';
  return { name: name.trim(), description, source };
}

/** The folder holding a skills folder: `.claude` for `~/.claude/skills`. */
function skillsFolderName(skillsDir: string): string {
  return skillsDir.split(/[\\/]/).at(-2) ?? '';
}

/**
 * The skills from a host's listing: each SKILL.md's frontmatter after a separator, whose
 * skill it is (user or project), and its folder's path.
 */
export function parseHostSkillListing(output: string, family: AgentSkillFamily): AgentSkill[] {
  return readHostListing(output, family).map(({ skill }) => skill);
}

function readHostListing(
  output: string,
  family: AgentSkillFamily
): { skill: AgentSkill; folder: string }[] {
  return output.split(RECORD_SEPARATOR).flatMap((record) => {
    const newline = record.indexOf('\n');
    const header = /^(user|project) (.+)$/.exec(record.slice(0, Math.max(newline, 0)));
    if (!header) return [];
    const source = header[1] as AgentSkill['source'];
    const folder = header[2];
    const folderName = folder.slice(folder.lastIndexOf('/') + 1);
    const skill = parseSkillFile(record.slice(newline + 1), folderName, source, family);
    const skillsDir = folder.slice(0, folder.lastIndexOf('/'));
    return skill ? [{ skill: { ...skill, folder: skillsFolderName(skillsDir) }, folder }] : [];
  });
}

/**
 * The script that prints the frontmatter of each skill in the agent's folders on a host, under
 * HOME and, when given, under the project's folder there, in the order the agent prefers them.
 * A host doesn't send whole skills: only up to the line closing the frontmatter, and nothing for
 * a file without one.
 */
export function hostSkillListingScript(
  family: AgentSkillFamily,
  projectDir: string | null
): string {
  const agent = SKILL_AGENTS[family];
  const user = `skills user ${agent.user
    .map((dirs) => `"$HOME"/${shellQuotePosix(dirs.join('/'))}/*/SKILL.md`)
    .join(' ')}`;
  const project =
    projectDir === null
      ? []
      : [
          `skills project ${agent.project
            .map((dirs) => `${shellQuotePosix([projectDir, ...dirs].join('/'))}/*/SKILL.md`)
            .join(' ')}`,
        ];
  return [
    'skills() {',
    '  kind=$1',
    '  shift',
    '  for f in "$@"; do',
    '    [ -f "$f" ] || continue',
    '    d=${f%/SKILL.md}',
    `    printf '\\036%s %s\\n' "$kind" "$d"`,
    `    awk 'NR == 1 { sub(/^\\357\\273\\277/, "") } NR == 1 && !/^---[ \\t\\r]*$/ { exit } { print } NR > 1 && /^---[ \\t\\r]*$/ { exit } NR >= ${FRONTMATTER_LINE_LIMIT} { exit }' "$f"`,
    '  done',
    '}',
    ...(agent.prefers === 'user' ? [user, ...project] : [...project, user]),
    'exit 0',
  ].join('\n');
}

async function readSkillsFolder(
  folder: string,
  source: AgentSkill['source'],
  family: AgentSkillFamily
): Promise<FoundSkill[]> {
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map(async (entry) => {
        const file = join(folder, entry.name, 'SKILL.md');
        try {
          const skill = parseSkillFile(await readFile(file, 'utf8'), entry.name, source, family);
          return skill
            ? {
                skill: { ...skill, folder: skillsFolderName(folder) },
                read: () => readFile(file, 'utf8'),
              }
            : null;
        } catch {
          return null;
        }
      })
  );
  return skills.filter((found): found is FoundSkill => found !== null);
}

/** The branch's last fetched commit, else its own; null when the repo has neither. */
async function resolveBranchCommit(repo: string, branch: string): Promise<string | null> {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    try {
      return await gitExec.execGitAsync(repo, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${ref}^{commit}`,
      ]);
    } catch {
      // Not this ref
    }
  }
  return null;
}

/** The skills committed to a skills folder of a repo, without a checkout to read them from. */
async function readCommittedSkillsFolder(
  repo: string,
  commit: string,
  folder: string,
  family: AgentSkillFamily
): Promise<FoundSkill[]> {
  let listing;
  try {
    listing = await gitExec.execGitAsyncRaw(repo, ['ls-tree', '-z', `${commit}:${folder}`]);
  } catch {
    return [];
  }
  const names = listing
    .split('\0')
    .map((entry) => /^\d+ tree [0-9a-f]+\t(.+)$/.exec(entry)?.[1])
    .filter((name): name is string => name !== undefined);
  const skills = await Promise.all(
    names.map(async (name) => {
      const read = () => gitExec.readBlobText(repo, commit, `${folder}/${name}/SKILL.md`);
      try {
        const skill = parseSkillFile(await read(), name, 'project', family);
        return skill ? { skill: { ...skill, folder: skillsFolderName(folder) }, read } : null;
      } catch {
        return null;
      }
    })
  );
  return skills.filter((found): found is FoundSkill => found !== null);
}

async function readCommittedSkills(
  repo: string,
  branch: string,
  family: AgentSkillFamily
): Promise<FoundSkill[]> {
  const commit = await resolveBranchCommit(repo, branch);
  if (!commit) return [];
  const folders = await Promise.all(
    SKILL_AGENTS[family].project.map((dirs) =>
      readCommittedSkillsFolder(repo, commit, dirs.join('/'), family)
    )
  );
  return folders.flat();
}

async function listHostSkills(
  hostId: string,
  family: AgentSkillFamily,
  projectDir: string | null
): Promise<FoundSkill[]> {
  if (!sshWorkspaceService.hasHost(hostId)) return [];
  const host = sshWorkspaceService.getHost(hostId);
  // The interactive lane, which the dialog's other reads of the host sign in to, so a host that
  // asks for a password can list its skills once one of them has.
  const options = {
    purpose: { kind: 'interactive' },
    timeout: HOST_LISTING_TIMEOUT_MS,
    prompt: false,
  } as const;
  try {
    const output = await sshWorkspaceService.run(
      host,
      hostSkillListingScript(family, projectDir),
      options
    );
    return readHostListing(output, family).map(({ skill, folder }) => ({
      skill,
      read: () =>
        sshWorkspaceService.run(host, `cat -- ${shellQuotePosix(`${folder}/SKILL.md`)}`, options),
    }));
  } catch (error) {
    logger.warn('Could not list skills on SSH host', { hostId, error: String(error) });
    return [];
  }
}

/** The first skill of each name, so the one the agent runs hides another of that name. */
function uniqueByName(found: FoundSkill[]): FoundSkill[] {
  const seen = new Set<string>();
  return found.filter(({ skill }) => !seen.has(skill.name) && Boolean(seen.add(skill.name)));
}

/**
 * The skills an agent can invoke from those folders: the user's and the project's, in the order
 * the agent prefers them. Of two skills with one name, it lists the one the agent runs.
 */
export async function listAgentSkills(
  family: AgentSkillFamily,
  folders: AgentSkillFolders
): Promise<AgentSkill[]> {
  return (await findAgentSkills(family, folders)).map(({ skill }) => skill);
}

/**
 * The instructions of the skill of that name listAgentSkills lists, read again where the agent
 * finds it: its SKILL.md without the frontmatter. Null once the skill is gone.
 */
export async function readAgentSkill(
  family: AgentSkillFamily,
  folders: AgentSkillFolders,
  name: string
): Promise<string | null> {
  const found = (await findAgentSkills(family, folders)).find(({ skill }) => skill.name === name);
  if (!found) return null;
  try {
    const content = await found.read();
    const frontmatter = FRONTMATTER.exec(content);
    return (frontmatter ? content.slice(frontmatter[0].length) : content).trim();
  } catch (error) {
    logger.warn('Could not read skill', {
      family,
      name,
      hostId: folders.hostId,
      error: String(error),
    });
    return null;
  }
}

async function findAgentSkills(
  family: AgentSkillFamily,
  { hostId, projectDir, projectDirOnHost, projectBranch }: AgentSkillFolders
): Promise<FoundSkill[]> {
  const agent = SKILL_AGENTS[family];
  // A host lists its project folder with its home folder, in one command
  if (hostId && projectDirOnHost) {
    return uniqueByName(await listHostSkills(hostId, family, projectDir));
  }
  const projectSkills = !projectDir
    ? []
    : projectBranch
      ? [readCommittedSkills(projectDir, projectBranch, family)]
      : agent.project.map((dirs) => readSkillsFolder(join(projectDir, ...dirs), 'project', family));
  const userSkills = hostId
    ? [listHostSkills(hostId, family, null)]
    : agent.user.map((dirs) => readSkillsFolder(join(homedir(), ...dirs), 'user', family));
  const ordered =
    agent.prefers === 'user'
      ? [...userSkills, ...projectSkills]
      : [...projectSkills, ...userSkills];
  return uniqueByName((await Promise.all(ordered)).flat());
}
