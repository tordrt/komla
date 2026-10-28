import { buildSkillFetchInstruction } from './skill-fetch-instruction';

export function buildOnboardingDemoPrompt(): string {
  return `# Show me what Komla can do through its CLI

${buildSkillFetchInstruction('onboarding-demo')}`;
}
