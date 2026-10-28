export interface KomlaSkillStatus {
  /** Whether a skills folder has Komla's skill. */
  isConfigured: boolean;
  /** The SKILL.md files Komla writes it to. */
  paths: string[];
}
