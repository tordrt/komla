/** The agents whose skills the new workspace dialog suggests, each reading its own folders. */
export type AgentSkillFamily = 'claude' | 'codex';

/** A skill an AI coding agent can invoke, read from a SKILL.md's frontmatter. */
export interface AgentSkill {
  /** What the prompt types after the trigger character to invoke it. */
  name: string;
  description: string;
  /** The project's own folders, or the home folder where the agent runs. */
  source: 'project' | 'user';
}
