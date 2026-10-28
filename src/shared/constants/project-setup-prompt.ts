import { buildSkillFetchInstruction } from './skill-fetch-instruction';

// Shared prompt for the "Set up project in Komla" built-in action and the Tips
// menu entry. The CLI follows the terminal's actual local or SSH route.
export function buildProjectSetupPrompt(): string {
  return `# Set up this project in Komla

${buildSkillFetchInstruction('project-setup')}`;
}

// Older prompts saved in users' Actions name an instructions file on the
// desktop, which SSH workspaces can't read, so they get the current prompt.
export function isProjectSetupPrompt(prompt: string | undefined): boolean {
  return Boolean(prompt && /komla-project-setup(?:-ssh)?-instructions\.md/.test(prompt));
}
