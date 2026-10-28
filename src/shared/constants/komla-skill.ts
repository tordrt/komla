/** The folder the Komla skill gets in a skills folder, named as its SKILL.md names it. */
export const KOMLA_SKILL_NAME = 'komla';

export interface SkillsFolder {
  /** Path segments under the home directory. */
  dirs: readonly string[];
  /** A folder in the home directory without which this copy is skipped. */
  onlyWith?: string;
}

/**
 * The user-level skills folders the Komla skill goes in. Claude Code reads ~/.claude/skills and
 * Codex ~/.agents/skills; OpenCode reads both and lists the skill once. Antigravity CLI reads
 * ~/.gemini/config/skills, so that copy is written only where ~/.gemini exists.
 */
export const KOMLA_SKILLS_FOLDERS: readonly SkillsFolder[] = [
  { dirs: ['.claude', 'skills'] },
  { dirs: ['.agents', 'skills'] },
  { dirs: ['.gemini', 'config', 'skills'], onlyWith: '.gemini' },
];

/** A folder's Komla SKILL.md, as path segments under the home directory. */
export function komlaSkillFileSegments(folder: SkillsFolder): string[] {
  return [...folder.dirs, KOMLA_SKILL_NAME, 'SKILL.md'];
}

/** Matches a SKILL.md whose frontmatter names it `komla`. */
export const KOMLA_SKILL_PATTERN = /^---\r?\n(?:(?!---)[^\n]*\n)*?name:[ \t]*komla[ \t]*\r?\n/;

/** Whether a SKILL.md is Komla's, so removing it leaves a user's own skill of another name alone. */
export function isKomlaSkill(content: string): boolean {
  return KOMLA_SKILL_PATTERN.test(content);
}
