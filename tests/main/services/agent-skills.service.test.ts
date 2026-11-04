import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  home: '',
  project: undefined as
    | { repositoryPath: string; managed: boolean; managedRepoPath?: string }
    | undefined,
  hostOutput: '',
  hostScripts: [] as string[],
  hostFails: false,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => state.home };
});
vi.mock('../../../src/main/services/project.service', () => ({
  projectService: { get: () => state.project },
}));
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {
    hasHost: (hostId: string) => hostId === 'host-1',
    getHost: (hostId: string) => ({ id: hostId }),
    run: async (_host: unknown, script: string) => {
      state.hostScripts.push(script);
      if (state.hostFails) throw new Error('ssh failed');
      return state.hostOutput;
    },
  },
}));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  hostSkillListingScript,
  listAgentSkills,
  parseHostSkillListing,
  parseSkillFile,
} from '../../../src/main/services/agent-skills.service';

let root: string;

function writeSkill(folder: string, name: string, content: string): void {
  mkdirSync(join(folder, name), { recursive: true });
  writeFileSync(join(folder, name, 'SKILL.md'), content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'komla-skills-'));
  state.home = join(root, 'home');
  mkdirSync(state.home);
  state.project = undefined;
  state.hostOutput = '';
  state.hostScripts = [];
  state.hostFails = false;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseSkillFile', () => {
  it('reads the name and description from the frontmatter', () => {
    expect(
      parseSkillFile(
        '---\nname: review-pr\ndescription: >\n  Reviews a pull\n  request.\n---\n# Body\n',
        'folder',
        'project',
        'claude'
      )
    ).toEqual({ name: 'review-pr', description: 'Reviews a pull request.', source: 'project' });
  });

  it('names a skill without a name after its folder', () => {
    expect(
      parseSkillFile('---\ndescription: "Deploys"\n---\n', 'deploy', 'user', 'claude')
    ).toEqual({
      name: 'deploy',
      description: 'Deploys',
      source: 'user',
    });
  });

  it('skips a file without frontmatter, or with a name a prompt cannot type', () => {
    expect(parseSkillFile('# Just markdown', 'x', 'user', 'claude')).toBeNull();
    expect(parseSkillFile('---\nname: two words\n---\n', 'x', 'user', 'claude')).toBeNull();
  });

  it("reads frontmatter that isn't strict YAML line by line, as Claude Code does", () => {
    const loose = (fields: string) =>
      `---\n${fields}\ndescription: Reviews. Use when: asked\n---\n`;
    expect(parseSkillFile(loose('name: "review-pr"'), 'folder', 'user', 'claude')).toEqual({
      name: 'review-pr',
      description: 'Reviews. Use when: asked',
      source: 'user',
    });
    expect(
      parseSkillFile(loose('name: review-pr\nuser-invocable: false'), 'folder', 'user', 'claude')
    ).toBeNull();
    expect(
      parseSkillFile(
        loose(
          "name: review-pr  # main entry\nuser-invocable: False\nargument-hint: 'It''s \"#1\"'"
        ),
        'folder',
        'user',
        'claude'
      )
    ).toBeNull();
    expect(
      parseSkillFile(
        '---\nname: review-pr # main\nargument-hint: [pr] [priority]\ndescription: >-  \n  Reviews: PRs\n  "Fast" and \'safe\'\n---\n',
        'folder',
        'user',
        'claude'
      )
    ).toEqual({
      name: 'review-pr',
      description: 'Reviews: PRs "Fast" and \'safe\'',
      source: 'user',
    });
    expect(
      parseSkillFile(
        `---\nargument-hint: [pr] [x]\ndescription: "Say \\"hi\\" to 'it''s'"\n---\n`,
        'greet',
        'user',
        'claude'
      )?.description
    ).toBe(`Say "hi" to 'it''s'`);
    // Codex skips such a skill
    expect(parseSkillFile(loose('name: review-pr'), 'folder', 'user', 'codex')).toBeNull();
  });

  it('reads a file that starts with a byte order mark', () => {
    expect(parseSkillFile('\uFEFF---\nname: lint\n---\n', 'x', 'user', 'claude')).toEqual({
      name: 'lint',
      description: '',
      source: 'user',
    });
  });

  it('keeps a Codex skill marked user-invocable: false, as Codex ignores that field', () => {
    expect(
      parseSkillFile('---\nname: lint\nuser-invocable: false\n---\n', 'x', 'user', 'codex')
    ).toEqual({ name: 'lint', description: '', source: 'user' });
  });

  it('reads frontmatter whose --- lines end in spaces', () => {
    expect(parseSkillFile('---  \nname: lint\n--- \nBody', 'x', 'user', 'claude')).toEqual({
      name: 'lint',
      description: '',
      source: 'user',
    });
  });

  it("skips a skill Claude Code keeps out of the user's menu", () => {
    expect(
      parseSkillFile('---\nname: lint\nuser-invocable: false\n---\n', 'x', 'user', 'claude')
    ).toBeNull();
    expect(
      parseSkillFile('---\nname: lint\nuser-invocable: true\n---\n', 'x', 'user', 'claude')
    ).toEqual({
      name: 'lint',
      description: '',
      source: 'user',
    });
  });
});

describe('listAgentSkills on this computer', () => {
  it("lists the user's and the project's skills, a user skill hiding a project one", async () => {
    const repo = join(root, 'repo');
    state.project = { repositoryPath: repo, managed: false };
    writeSkill(
      join(repo, '.claude', 'skills'),
      'review',
      '---\nname: review\ndescription: P\n---\n'
    );
    writeSkill(
      join(state.home, '.claude', 'skills'),
      'review',
      '---\nname: review\ndescription: U\n---\n'
    );
    writeSkill(join(repo, '.claude', 'skills'), 'deploy', '---\nname: deploy\n---\n');
    // Codex's folders aren't Claude Code's
    writeSkill(join(state.home, '.agents', 'skills'), 'codex-only', '---\nname: codex-only\n---\n');

    const skills = await listAgentSkills('claude', 'project-1', null);

    // Claude Code runs the user's skill when both have one name
    expect(skills).toEqual([
      { name: 'review', description: 'U', source: 'user' },
      { name: 'deploy', description: '', source: 'project' },
    ]);
  });

  it('lists a Codex project skill over a user skill of the same name', async () => {
    const repo = join(root, 'repo');
    state.project = { repositoryPath: repo, managed: false };
    writeSkill(
      join(repo, '.agents', 'skills'),
      'deploy',
      '---\nname: deploy\ndescription: P\n---\n'
    );
    writeSkill(
      join(state.home, '.agents', 'skills'),
      'deploy',
      '---\nname: deploy\ndescription: U\n---\n'
    );

    expect(await listAgentSkills('codex', 'project-1', null)).toEqual([
      { name: 'deploy', description: 'P', source: 'project' },
    ]);
  });

  it("reads Codex's folders, its older ~/.codex/skills too, and follows symlinked skills", async () => {
    const repo = join(root, 'repo');
    state.project = { repositoryPath: repo, managed: false };
    writeSkill(join(repo, '.agents', 'skills'), 'lint', '---\nname: lint\n---\n');
    writeSkill(join(state.home, '.codex', 'skills'), 'old', '---\nname: old\n---\n');
    writeSkill(join(root, 'elsewhere'), 'linked', '---\nname: linked\n---\n');
    mkdirSync(join(state.home, '.agents', 'skills'), { recursive: true });
    symlinkSync(join(root, 'elsewhere', 'linked'), join(state.home, '.agents', 'skills', 'linked'));

    const names = (await listAgentSkills('codex', 'project-1', null)).map((s) => s.name);

    expect(names.sort()).toEqual(['linked', 'lint', 'old']);
  });

  it("reads the .agents and .claude folders for any other agent, but not an agent's own", async () => {
    const repo = join(root, 'repo');
    state.project = { repositoryPath: repo, managed: false };
    writeSkill(join(repo, '.agents', 'skills'), 'shared', '---\nname: shared\n---\n');
    writeSkill(join(repo, '.claude', 'skills'), 'from-claude', '---\nname: from-claude\n---\n');
    writeSkill(join(repo, '.github', 'skills'), 'gh', '---\nname: gh\n---\n');
    writeSkill(join(state.home, '.agents', 'skills'), 'mine', '---\nname: mine\n---\n');
    writeSkill(join(state.home, '.claude', 'skills'), 'my-claude', '---\nname: my-claude\n---\n');
    writeSkill(join(state.home, '.copilot', 'skills'), 'copilot', '---\nname: copilot\n---\n');

    const names = (await listAgentSkills('agents', 'project-1', null)).map((s) => s.name);

    expect(names.sort()).toEqual(['from-claude', 'mine', 'my-claude', 'shared']);
  });

  it('lists nothing when no folders exist', async () => {
    expect(await listAgentSkills('claude', null, null)).toEqual([]);
  });
});

describe('listAgentSkills on an SSH host', () => {
  it("reads the user's skills on the host, not this computer's", async () => {
    writeSkill(join(state.home, '.claude', 'skills'), 'local', '---\nname: local\n---\n');
    state.hostOutput = '\x1eremote\n---\nname: remote\ndescription: On the host\n---\n';

    const skills = await listAgentSkills('claude', null, 'host-1');

    expect(skills).toEqual([{ name: 'remote', description: 'On the host', source: 'user' }]);
    expect(state.hostScripts).toHaveLength(1);
  });

  it("lists no host skills when the host is unknown or can't be reached", async () => {
    expect(await listAgentSkills('claude', null, 'missing')).toEqual([]);
    state.hostFails = true;
    expect(await listAgentSkills('claude', null, 'host-1')).toEqual([]);
  });
});

describe('hostSkillListingScript', () => {
  it("prints each skill's frontmatter under HOME, which parseHostSkillListing reads", () => {
    writeSkill(
      join(state.home, '.agents', 'skills'),
      'my skill dir',
      '---\nname: from-agents\ndescription: A\n---\nbody\n'
    );
    writeSkill(join(state.home, '.codex', 'skills'), 'legacy', '\uFEFF---\ndescription: B\n---\n');
    // A folder without a SKILL.md is skipped
    mkdirSync(join(state.home, '.agents', 'skills', 'empty'), { recursive: true });

    const output = execFileSync('sh', ['-c', hostSkillListingScript('codex')], {
      env: { PATH: process.env.PATH, HOME: state.home },
      encoding: 'utf8',
    });

    expect(parseHostSkillListing(output, 'codex')).toEqual([
      { name: 'from-agents', description: 'A', source: 'user' },
      { name: 'legacy', description: 'B', source: 'user' },
    ]);
  });

  it("sends a long frontmatter whole, but not the skill's body", () => {
    const tools = Array.from({ length: 120 }, (_, i) => `  - tool-${i}`).join('\n');
    writeSkill(
      join(state.home, '.claude', 'skills'),
      'long',
      `---\nallowed-tools:\n${tools}\nname: long\ndescription: Last\n---\nSECRET BODY\n`
    );
    writeSkill(join(state.home, '.claude', 'skills'), 'plain', '# No frontmatter\nbody\n');

    const output = execFileSync('sh', ['-c', hostSkillListingScript('claude')], {
      env: { PATH: process.env.PATH, HOME: state.home },
      encoding: 'utf8',
    });

    expect(output).not.toContain('SECRET BODY');
    expect(output).not.toContain('No frontmatter');
    expect(parseHostSkillListing(output, 'claude')).toEqual([
      { name: 'long', description: 'Last', source: 'user' },
    ]);
  });

  it('prints nothing and exits cleanly when the folders are missing', () => {
    const output = execFileSync('sh', ['-c', hostSkillListingScript('claude')], {
      env: { PATH: process.env.PATH, HOME: state.home },
      encoding: 'utf8',
    });
    expect(output).toBe('');
  });
});
