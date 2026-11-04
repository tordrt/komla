import type { AgentPreset } from '../types/agent-preset';
import type { AgentSkill, AgentSkillFamily } from '../types/agent-skill';

/** The character a prompt invokes a skill with: Claude Code takes `/name`, Codex `$name`. */
export const SKILL_TRIGGERS: Record<AgentSkillFamily, '/' | '$'> = {
  claude: '/',
  codex: '$',
};

/**
 * The skills folders each agent reads, as path segments under the project's folder and under
 * the home folder. Codex reads ~/.agents/skills and, from before that, ~/.codex/skills.
 */
export const SKILL_FOLDERS: Record<
  AgentSkillFamily,
  { project: readonly (readonly string[])[]; user: readonly (readonly string[])[] }
> = {
  claude: { project: [['.claude', 'skills']], user: [['.claude', 'skills']] },
  codex: {
    project: [['.agents', 'skills']],
    user: [
      ['.agents', 'skills'],
      ['.codex', 'skills'],
    ],
  },
};

const AGENT_EXECUTABLES: Record<string, AgentSkillFamily> = { claude: 'claude', codex: 'codex' };

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
  return AGENT_EXECUTABLES[name] ?? null;
}

/** A character a skill name a prompt can type may hold. */
export const SKILL_NAME_CHAR = '[\\w.:-]';

/** A skill name the trigger character is typed before, so `/` in a path doesn't open the menu. */
const SKILL_QUERY_PATTERN = new RegExp(`^${SKILL_NAME_CHAR}*$`);
// The rest of the name a caret was moved into, then the spaces after it.
const NAME_REST_PATTERN = new RegExp(`^${SKILL_NAME_CHAR}*[ \\t]*`);

/**
 * The skill name typed so far before the caret, and where its trigger character is, or null.
 * Claude Code runs a skill only when the prompt starts with it, so `/` counts only there;
 * Codex takes `$name` anywhere a word starts.
 */
export function findSkillQuery(
  text: string,
  caret: number,
  family: AgentSkillFamily
): { start: number; query: string } | null {
  const trigger = SKILL_TRIGGERS[family];
  const before = text.slice(0, caret);
  const start = before.lastIndexOf(trigger);
  if (start < 0) return null;
  if (family === 'claude' ? start !== 0 : start > 0 && !/\s/.test(before[start - 1])) return null;
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
  const inserted = `${SKILL_TRIGGERS[family]}${name} `;
  const rest = text.slice(caret);
  const after =
    caret > start + 1 ? rest.replace(NAME_REST_PATTERN, '') : rest.replace(/^[ \t]+/, '');
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length };
}
