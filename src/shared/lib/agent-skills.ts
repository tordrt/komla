import { canStartWithPrompt } from './agent-preset-prompt';

import type { AgentPreset } from '../types/agent-preset';
import type { AgentSkill, AgentSkillFamily } from '../types/agent-skill';

type Folders = readonly (readonly string[])[];

/** How an agent finds the skills it can invoke, and how a prompt invokes one. */
export interface SkillAgent {
  /** Typed before a skill's name, wherever a word starts: `/name`, or Codex's `$name`. */
  trigger: '/' | '$';
  /** The skills folders it reads, as path segments under the project's folder. */
  project: Folders;
  /** And under the home folder. */
  user: Folders;
  /** Skips a skill whose frontmatter has `user-invocable: false`, keeping it out of its menu. */
  honorsUserInvocable: boolean;
  /**
   * Reads frontmatter that isn't strict YAML, like a description with an unquoted `: `, line by
   * line. An agent that doesn't skips the skill.
   */
  readsLooseFrontmatter: boolean;
  /** Of a user's skill and a project skill with one name, the one it runs. */
  prefers: 'user' | 'project';
}

const dirs = (...names: string[]): Folders => names.map((name) => [name, 'skills']);

/**
 * Claude Code and Codex, from their docs, and `agents` for any other agent. Claude Code runs a
 * skill at the prompt's start directly, and one named later when it judges it was asked to; an
 * agent that doesn't treat `/name` as a command still sees its skills, so it loads one named.
 */
export const SKILL_AGENTS: Record<AgentSkillFamily, SkillAgent> = {
  claude: {
    trigger: '/',
    project: dirs('.claude'),
    user: dirs('.claude'),
    honorsUserInvocable: true,
    readsLooseFrontmatter: true,
    prefers: 'user',
  },
  // ~/.codex/skills is where Codex read skills before ~/.agents/skills, and still does.
  codex: {
    trigger: '$',
    project: dirs('.agents'),
    user: dirs('.agents', '.codex'),
    honorsUserInvocable: false,
    readsLooseFrontmatter: false,
    prefers: 'project',
  },
  // The open Agent Skills format's folders and Claude Code's, which most other agents read
  agents: {
    trigger: '/',
    project: dirs('.agents', '.claude'),
    user: dirs('.agents', '.claude'),
    honorsUserInvocable: false,
    readsLooseFrontmatter: false,
    prefers: 'project',
  },
};

const AGENT_EXECUTABLES = new Map<string, AgentSkillFamily>([
  ['claude', 'claude'],
  ['codex', 'codex'],
]);

/**
 * The agent whose skills a preset's prompt can invoke, from the executable its command starts:
 * `agents` for one other than Claude Code and Codex.
 */
export function skillFamilyForPreset(
  preset: Pick<AgentPreset, 'openCommand' | 'promptCommand'> | null | undefined
): AgentSkillFamily | null {
  const command = (preset?.promptCommand || preset?.openCommand || '').trim();
  // The first word, or a quoted path with spaces, after any `NAME=value` settings
  const executable =
    /^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:"([^"]*)"|'([^']*)'|(\S+))/
      .exec(command)
      ?.slice(1)
      .find((part) => part !== undefined) ?? '';
  const name = (executable.split(/[\\/]/).pop() ?? '')
    .replace(/^["']|["']$/g, '')
    .replace(/\.(exe|cmd|ps1)$/i, '')
    .toLowerCase();
  if (!name) return null;
  return AGENT_EXECUTABLES.get(name) ?? 'agents';
}

/** The agent whose skills a preset's prompt can invoke, or null when it opens without a prompt. */
export function promptSkillFamily(
  preset: Pick<AgentPreset, 'openCommand' | 'promptCommand'> | null | undefined
): AgentSkillFamily | null {
  return preset && canStartWithPrompt(preset) ? skillFamilyForPreset(preset) : null;
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
// A whole name after a trigger, so the start of a path like `/src/app.ts` isn't taken for one.
const LEADING_NAME_PATTERN = new RegExp(`^${SKILL_NAME_CHAR}*(?=\\s|$)`);

/**
 * The skill name typed so far before the caret, and where its trigger character is, or null.
 * The trigger counts where a word starts, so `/` in a path doesn't open the menu.
 */
export function findSkillQuery(
  text: string,
  caret: number,
  family: AgentSkillFamily
): { start: number; query: string } | null {
  const { trigger } = SKILL_AGENTS[family];
  const before = text.slice(0, caret);
  const start = before.lastIndexOf(trigger);
  if (start < 0) return null;
  if (start > 0 && !/\s/.test(before[start - 1])) return null;
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

/**
 * The prompt started with the skill's invocation, where every agent invokes it, in place of an
 * invocation or part of one the prompt already starts with, but not a path or a variable.
 */
export function startPromptWithSkill(
  text: string,
  family: AgentSkillFamily,
  name: string
): { text: string; caret: number } {
  const trigger = SKILL_AGENTS[family].trigger;
  const typed = text.startsWith(trigger)
    ? LEADING_NAME_PATTERN.exec(text.slice(trigger.length))
    : null;
  return insertSkill(text, typed ? trigger.length + typed[0].length : 0, 0, family, name);
}
