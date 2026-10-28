import { readFileSync } from 'fs';

import { describe, it, expect } from 'vitest';

import { buildAppearancePrompt } from '../../../src/shared/constants/appearance-prompt';
import { buildOnboardingDemoPrompt } from '../../../src/shared/constants/onboarding-demo-prompt';
import {
  buildProjectSetupPrompt,
  isProjectSetupPrompt,
} from '../../../src/shared/constants/project-setup-prompt';
import { buildSkillFetchInstruction } from '../../../src/shared/constants/skill-fetch-instruction';

describe('skill fetch instructions', () => {
  it('names the CLI command and the KOMLA_CLI path for login shells that reset PATH', () => {
    expect(buildSkillFetchInstruction('onboarding-demo')).toBe(
      "Run `komla skill onboarding-demo` and follow it. If `komla` isn't found, use the absolute path in `KOMLA_CLI`."
    );
  });
});

describe('onboarding prompt builders', () => {
  it.each([buildOnboardingDemoPrompt(), buildProjectSetupPrompt(), buildAppearancePrompt()])(
    'keeps launch prompts to a title and one line',
    (result) => {
      expect(result).not.toMatch(/localhost|\.komla|\.md/);
      expect(result.split('\n')).toHaveLength(3);
    }
  );

  it('titles the demo as a CLI tour', () => {
    expect(buildOnboardingDemoPrompt()).toContain('# Show me what Komla can do through its CLI');
  });

  it('names each guide', () => {
    expect(buildOnboardingDemoPrompt()).toContain('komla skill onboarding-demo');
    expect(buildProjectSetupPrompt()).toContain('komla skill project-setup');
    expect(buildAppearancePrompt()).toContain('komla skill appearance');
  });

  it('recognizes only older saved project setup prompts that name a desktop file', () => {
    expect(
      isProjectSetupPrompt(
        'Then fall back to `/data/.komla/skills/komla-project-setup-instructions.md`.'
      )
    ).toBe(true);
    expect(isProjectSetupPrompt(buildProjectSetupPrompt())).toBe(false);
    expect(
      isProjectSetupPrompt('Run `komla skill project-setup` and follow it. Only configure api/.')
    ).toBe(false);
  });
});

describe('project setup instructions', () => {
  it('uses one environment-independent workflow with destination-aware steps', () => {
    const instructions = readFileSync(
      new URL('../../../resources/skills/komla-project-setup-instructions.md', import.meta.url),
      'utf8'
    );

    expect(instructions).toContain('komla settings get');
    expect(instructions).toContain('workspace-repository');
    expect(instructions).toContain('local-workspace-repository');
    expect(instructions).toContain('ssh-workspace-repository');
    expect(instructions).toContain('ssh-local-copy');
    expect(instructions).toContain('workspace-creation');
    expect(instructions).toContain('every-workspace-start');
    expect(instructions).toContain('workspace-stop');
    expect(instructions).toMatch(/destination.*cwd.*machine/is);
    expect(instructions).toMatch(/desktop source path/i);
  });

  it('offers desktop apps the virtual desktop on SSH hosts as an optional extra', () => {
    const instructions = readFileSync(
      new URL('../../../resources/skills/komla-project-setup-instructions.md', import.meta.url),
      'utf8'
    );

    expect(instructions).toContain('komla desktop run -- <command>');
    expect(instructions).toMatch(/tigervnc-standalone-server\s+openbox\s+novnc\s+websockify/);
    expect(instructions).toContain('optional extra');
    expect(instructions).toContain('Keep the plain development command as the recommendation');
    expect(instructions.replace(/\s+/g, ' ')).toContain(
      '`komla desktop run -- <command>` with `"sshExecutionLocation": "remote"`'
    );
  });
});
