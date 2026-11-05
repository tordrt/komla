import type { AgentPreset } from '../types/agent-preset';
import type { AgentSkill, AgentSkillFamily } from '../types/agent-skill';

type Folders = readonly (readonly string[])[];

/** How an agent finds the skills it can invoke, and how a prompt invokes one. */
export interface SkillAgent {
  /** Typed before a skill's name: `/name`, or Codex's `$name`. */
  trigger: '/' | '$';
  /** Claude Code runs a skill only at the prompt's start; the others wherever a word starts. */
  onlyAtStart: boolean;
  /** The skills folders it reads, as path segments under the project's folder. */
  project: Folders;
  /** And under the home folder. */
  user: Folders;
  /** Skips a skill whose frontmatter has `user-invocable: false`, keeping it out of its menu. */
  honorsUserInvocable: boolean;
  /** Of a user's skill and a project skill with one name, the one it runs. */
  prefers: 'user' | 'project';
}

const dirs = (...names: string[]): Folders => names.map((name) => [name, 'skills']);

/**
 * The agents that invoke a skill named in a prompt, from their docs. OpenCode and Gemini CLI read
 * skills too, but only the model starts one, so a name typed in a prompt doesn't run it.
 */
export const SKILL_AGENTS: Record<AgentSkillFamily, SkillAgent> = {
  claude: {
    trigger: '/',
    onlyAtStart: true,
    project: dirs('.claude'),
    user: dirs('.claude'),
    honorsUserInvocable: true,
    prefers: 'user',
  },
  // ~/.codex/skills is where Codex read skills before ~/.agents/skills.
  codex: {
    trigger: '$',
    onlyAtStart: false,
    project: dirs('.agents'),
    user: dirs('.agents', '.codex'),
    honorsUserInvocable: false,
    prefers: 'project',
  },
  copilot: {
    trigger: '/',
    onlyAtStart: false,
    project: dirs('.github', '.claude', '.agents'),
    user: dirs('.copilot', '.agents'),
    honorsUserInvocable: true,
    prefers: 'project',
  },
  cursor: {
    trigger: '/',
    onlyAtStart: false,
    project: dirs('.agents', '.cursor', '.claude', '.codex'),
    user: dirs('.agents', '.cursor', '.claude', '.codex'),
    honorsUserInvocable: false,
    prefers: 'project',
  },
};

const AGENT_EXECUTABLES = new Map<string, AgentSkillFamily>([
  ['claude', 'claude'],
  ['codex', 'codex'],
  ['copilot', 'copilot'],
  ['cursor-agent', 'cursor'],
]);

/** The agent whose skills a preset's prompt can invoke, from the executable its command starts. */
export function skillFamilyForPreset(
  preset: Pick<AgentPreset, 'openCommand' | 'promptCommand'> | null | undefined
): AgentSkillFamily | null {
  const command = (preset?.promptCommand || preset?.openCommand || '').trim();
  const executable = command.split(/\s+/)[0] ?? '';
  const name = (executable.split(/[\\/]/).pop() ?? '')
    .replace(/^["']|["']$/g, '')
    .replace(/\.(exe|cmd|ps1)$/i, '')
    .toLowerCase();
  return AGENT_EXECUTABLES.get(name) ?? null;
}

/** How a prompt invokes the agent's skill of that name. */
export function skillInvocation(family: AgentSkillFamily, name: string): string {
  return `${SKILL_AGENTS[family].trigger}${name}`;
}

/** A character a skill name a prompt can type may hold. */
export const SKILL_NAME_CHAR = '[\\w.:-]';

/** A skill name the trigger character is typed before, so `/` in a path doesn't open the menu. */
const SKILL_QUERY_PATTERN = new RegExp(`^${SKILL_NAME_CHAR}*$`);
// The rest of the name a caret was moved into, then the spaces after it.
const NAME_REST_PATTERN = new RegExp(`^${SKILL_NAME_CHAR}*[ \\t]*`);

/**
 * The skill name typed so far before the caret, and where its trigger character is, or null.
 * Claude Code runs a skill only when the prompt starts with it, so `/` counts only there; the
 * other agents take one anywhere a word starts.
 */
export function findSkillQuery(
  text: string,
  caret: number,
  family: AgentSkillFamily
): { start: number; query: string } | null {
  const { trigger, onlyAtStart } = SKILL_AGENTS[family];
  const before = text.slice(0, caret);
  const start = before.lastIndexOf(trigger);
  if (start < 0) return null;
  if (onlyAtStart ? start !== 0 : start > 0 && !/\s/.test(before[start - 1])) return null;
  const query = before.slice(start + 1);
  return SKILL_QUERY_PATTERN.test(query) ? { start, query } : null;
}

/** Skills whose name holds the query, those starting with it first, each group by name. */
export function filterSkills(skills: AgentSkill[], query: string): AgentSkill[] {
  const lower = query.toLowerCase();
  const matches = skills.filter((skill) => skill.name.toLowerCase().includes(lower));
  const starts = (skill: AgentSkill) => skill.name.toLowerCase().startsWith(lower);
  return matches.sort(
    (a, b) => Number(starts(b)) - Number(starts(a)) || a.name.localeCompare(b.name)
  );
}

/**
 * The prompt with the skill name the caret is in replaced by the whole invocation and a space,
 * and where the caret goes after it. With part of a name typed, the rest of it after the caret
 * goes too; a trigger typed in front of a word leaves that word.
 */
export function insertSkill(
  text: string,
  caret: number,
  start: number,
  family: AgentSkillFamily,
  name: string
): { text: string; caret: number } {
  const inserted = `${skillInvocation(family, name)} `;
  const rest = text.slice(caret);
  const after =
    caret > start + 1 ? rest.replace(NAME_REST_PATTERN, '') : rest.replace(/^[ \t]+/, '');
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length };
}
