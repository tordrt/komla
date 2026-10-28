import { buildSkillFetchInstruction } from './skill-fetch-instruction';

// Prompt for "Customize with an agent" in Settings → Appearance.
export function buildAppearancePrompt(): string {
  return `# Customize Komla's appearance

${buildSkillFetchInstruction('appearance')}`;
}
