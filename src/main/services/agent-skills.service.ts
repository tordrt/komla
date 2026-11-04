import { readdir, readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

import { load } from 'js-yaml';

import { SKILL_FOLDERS, SKILL_NAME_CHAR } from '../../shared/lib/agent-skills';
import { projectRepoPath } from '../../shared/lib/project-repo-path';
import { shellQuotePosix } from '../../shared/lib/shell-quote';
import { createLogger } from '../lib/logger';

import { projectService } from './project.service';
import { sshWorkspaceService } from './ssh-workspace.service';

import type { AgentSkill, AgentSkillFamily } from '../../shared/types/agent-skill';

const logger = createLogger('AgentSkillsService');

// Starts each SKILL.md in a host's listing, followed by its skill folder's name.
const RECORD_SEPARATOR = '\x1e';
// Where a host stops reading a SKILL.md whose frontmatter never closes.
const FRONTMATTER_LINE_LIMIT = 1000;
const HOST_LISTING_TIMEOUT_MS = 15_000;
const SKILL_NAME_PATTERN = new RegExp(`^${SKILL_NAME_CHAR}+$`);

/**
 * A skill from a SKILL.md's frontmatter, named as its `name` says, else as its folder is.
 * Null for a file without frontmatter, with a name a prompt can't type, or that Claude Code's
 * `user-invocable: false` keeps out of the user's menu.
 */
export function parseSkillFile(
  content: string,
  folderName: string,
  source: AgentSkill['source'],
  family: AgentSkillFamily
): AgentSkill | null {
  // Like the host's listing, a `---` line may end in spaces
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return null;
  let frontmatter: unknown;
  try {
    frontmatter = load(match[1]);
  } catch {
    return null;
  }
  const fields = (frontmatter && typeof frontmatter === 'object' ? frontmatter : {}) as Record<
    string,
    unknown
  >;
  if (family === 'claude' && fields['user-invocable'] === false) return null;
  const name = typeof fields.name === 'string' && fields.name.trim() ? fields.name : folderName;
  if (!SKILL_NAME_PATTERN.test(name.trim())) return null;
  const description =
    typeof fields.description === 'string' ? fields.description.replace(/\s+/g, ' ').trim() : '';
  return { name: name.trim(), description, source };
}

/**
 * The skills from a host's listing: each SKILL.md's frontmatter after a separator
 * and its folder's name.
 */
export function parseHostSkillListing(output: string, family: AgentSkillFamily): AgentSkill[] {
  return output.split(RECORD_SEPARATOR).flatMap((record) => {
    const newline = record.indexOf('\n');
    if (newline <= 0) return [];
    const folderName = record.slice(0, newline);
    const skill = parseSkillFile(record.slice(newline + 1), folderName, 'user', family);
    return skill ? [skill] : [];
  });
}

/**
 * The script that prints the frontmatter of each skill in the agent's folders under HOME, so a
 * host doesn't send whole skills: up to the line closing it, and nothing for a file without one.
 */
export function hostSkillListingScript(family: AgentSkillFamily): string {
  const globs = SKILL_FOLDERS[family].user
    .map((dirs) => `"$HOME"/${shellQuotePosix(dirs.join('/'))}/*/SKILL.md`)
    .join(' ');
  return [
    `for f in ${globs}; do`,
    '  [ -f "$f" ] || continue',
    '  d=${f%/SKILL.md}',
    `  printf '\\036%s\\n' "\${d##*/}"`,
    `  awk 'NR == 1 && !/^---[ \\t\\r]*$/ { exit } { print } NR > 1 && /^---[ \\t\\r]*$/ { exit } NR >= ${FRONTMATTER_LINE_LIMIT} { exit }' "$f"`,
    'done',
    'exit 0',
  ].join('\n');
}

async function readSkillsFolder(
  folder: string,
  source: AgentSkill['source'],
  family: AgentSkillFamily
): Promise<AgentSkill[]> {
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
        try {
          const content = await readFile(join(folder, entry.name, 'SKILL.md'), 'utf8');
          return parseSkillFile(content, entry.name, source, family);
        } catch {
          return null;
        }
      })
  );
  return skills.filter((skill): skill is AgentSkill => skill !== null);
}

async function listHostSkills(hostId: string, family: AgentSkillFamily): Promise<AgentSkill[]> {
  if (!sshWorkspaceService.hasHost(hostId)) return [];
  try {
    const output = await sshWorkspaceService.run(
      sshWorkspaceService.getHost(hostId),
      hostSkillListingScript(family),
      // The interactive lane, which the dialog's other reads of the host sign in to, so a host
      // that asks for a password can list its skills once one of them has.
      { purpose: { kind: 'interactive' }, timeout: HOST_LISTING_TIMEOUT_MS, prompt: false }
    );
    return parseHostSkillListing(output, family);
  } catch (error) {
    logger.warn('Could not list skills on SSH host', { hostId, error: String(error) });
    return [];
  }
}

/** The first skill of each name, so the one the agent runs hides another of that name. */
function uniqueByName(skills: AgentSkill[]): AgentSkill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => !seen.has(skill.name) && Boolean(seen.add(skill.name)));
}

/**
 * The skills an agent can invoke in a new workspace of the project: the user's, from the SSH
 * host's home folder when the workspace starts there and from this computer's otherwise, then
 * the project's own, read from this computer's clone. Of two skills with one name, Claude Code
 * runs the user's, and Codex looks in the project first.
 */
export async function listAgentSkills(
  family: AgentSkillFamily,
  projectId: string | null,
  hostId: string | null
): Promise<AgentSkill[]> {
  const project = projectId ? projectService.get(projectId) : undefined;
  const repoPath = project ? projectRepoPath(project) : null;
  const projectSkills = repoPath
    ? SKILL_FOLDERS[family].project.map((dirs) =>
        readSkillsFolder(join(repoPath, ...dirs), 'project', family)
      )
    : [];
  const userSkills = hostId
    ? [listHostSkills(hostId, family)]
    : SKILL_FOLDERS[family].user.map((dirs) =>
        readSkillsFolder(join(homedir(), ...dirs), 'user', family)
      );
  const ordered =
    family === 'claude' ? [...userSkills, ...projectSkills] : [...projectSkills, ...userSkills];
  return uniqueByName((await Promise.all(ordered)).flat());
}
