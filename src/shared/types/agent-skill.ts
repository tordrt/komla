/**
 * The agents whose skills Komla suggests, by how they find and invoke them: Claude Code, Codex,
 * and `agents` for any other.
 */
export const AGENT_SKILL_FAMILIES = ['claude', 'codex', 'agents'] as const;

export type AgentSkillFamily = (typeof AGENT_SKILL_FAMILIES)[number];

/** A skill an AI coding agent can invoke, read from a SKILL.md's frontmatter. */
export interface AgentSkill {
  /** What the prompt types after the trigger character to invoke it. */
  name: string;
  description: string;
  /** The project's own folders, or the home folder where the agent runs. */
  source: 'project' | 'user';
}
