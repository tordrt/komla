import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  home: '',
  hostOutput: '',
  hostFile: '',
  hostScripts: [] as string[],
  hostFails: false,
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => state.home };
});
vi.mock('../../../src/main/services/ssh-workspace.service', () => ({
  sshWorkspaceService: {
    hasHost: (hostId: string) => hostId === 'host-1',
    getHost: (hostId: string) => ({ id: hostId }),
    run: async (_host: unknown, script: string) => {
      state.hostScripts.push(script);
      if (state.hostFails) throw new Error('ssh failed');
      return script.startsWith('cat ') ? state.hostFile : state.hostOutput;
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
  readAgentSkill,
} from '../../../src/main/services/agent-skills.service';

let root: string;

/** An agent on this computer, with the project's skills in projectDir. */
const local = (projectDir: string | null = null) => ({
  hostId: null,
  projectDir,
  projectDirOnHost: false,
});
/** An agent on an SSH host, its project's skills read on this computer. */
const home = (hostId: string) => ({ hostId, projectDir: null, projectDirOnHost: false });

function writeSkill(folder: string, name: string, content: string): void {
  mkdirSync(join(folder, name), { recursive: true });
  writeFileSync(join(folder, name, 'SKILL.md'), content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'komla-skills-'));
  state.home = join(root, 'home');
  mkdirSync(state.home);
  state.hostOutput = '';
  state.hostFile = '';
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
    expect(parseSkillFile('---\n---\nTake notes.\n', 'notes', 'user', 'claude')).toEqual({
      name: 'notes',
      description: '',
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

    const skills = await listAgentSkills('claude', local(repo));

    // Claude Code runs the user's skill when both have one name
    expect(skills).toEqual([
      { name: 'review', description: 'U', source: 'user', folder: '.claude' },
      { name: 'deploy', description: '', source: 'project', folder: '.claude' },
    ]);
  });

  it('lists a Codex project skill over a user skill of the same name', async () => {
    const repo = join(root, 'repo');
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

    expect(await listAgentSkills('codex', local(repo))).toEqual([
      { name: 'deploy', description: 'P', source: 'project', folder: '.agents' },
    ]);
  });

  it("reads Codex's folders, its older ~/.codex/skills too, and follows symlinked skills", async () => {
    const repo = join(root, 'repo');
    writeSkill(join(repo, '.agents', 'skills'), 'lint', '---\nname: lint\n---\n');
    writeSkill(join(state.home, '.codex', 'skills'), 'old', '---\nname: old\n---\n');
    writeSkill(join(root, 'elsewhere'), 'linked', '---\nname: linked\n---\n');
    mkdirSync(join(state.home, '.agents', 'skills'), { recursive: true });
    symlinkSync(join(root, 'elsewhere', 'linked'), join(state.home, '.agents', 'skills', 'linked'));

    const names = (await listAgentSkills('codex', local(repo))).map((s) => s.name);

    expect(names.sort()).toEqual(['linked', 'lint', 'old']);
  });

  it("reads the .agents and .claude folders for any other agent, but not an agent's own", async () => {
    const repo = join(root, 'repo');
    writeSkill(join(repo, '.agents', 'skills'), 'shared', '---\nname: shared\n---\n');
    writeSkill(join(repo, '.claude', 'skills'), 'from-claude', '---\nname: from-claude\n---\n');
    writeSkill(join(repo, '.github', 'skills'), 'gh', '---\nname: gh\n---\n');
    writeSkill(join(state.home, '.agents', 'skills'), 'mine', '---\nname: mine\n---\n');
    writeSkill(join(state.home, '.claude', 'skills'), 'my-claude', '---\nname: my-claude\n---\n');
    writeSkill(join(state.home, '.copilot', 'skills'), 'copilot', '---\nname: copilot\n---\n');

    const names = (await listAgentSkills('agents', local(repo))).map((s) => s.name);

    expect(names.sort()).toEqual(['from-claude', 'mine', 'my-claude', 'shared']);
  });

  it('lists nothing when no folders exist', async () => {
    expect(await listAgentSkills('claude', local())).toEqual([]);
  });
});

describe('listAgentSkills on an SSH host', () => {
  it("reads the user's skills on the host, not this computer's", async () => {
    writeSkill(join(state.home, '.claude', 'skills'), 'local', '---\nname: local\n---\n');
    state.hostOutput =
      '\x1euser /home/me/.claude/skills/remote\n---\nname: remote\ndescription: On the host\n---\n';

    const skills = await listAgentSkills('claude', home('host-1'));

    expect(skills).toEqual([
      { name: 'remote', description: 'On the host', source: 'user', folder: '.claude' },
    ]);
    expect(state.hostScripts).toHaveLength(1);
  });

  it("lists no host skills when the host is unknown or can't be reached", async () => {
    expect(await listAgentSkills('claude', home('missing'))).toEqual([]);
    state.hostFails = true;
    expect(await listAgentSkills('claude', home('host-1'))).toEqual([]);
  });
});

describe('listAgentSkills in an SSH workspace', () => {
  it("lists its own folder's skills with the user's on the host, in one command", async () => {
    state.hostOutput = [
      '\x1eproject /work/feature/.claude/skills/deploy\n---\nname: deploy\ndescription: P\n---\n',
      '\x1euser /home/me/.claude/skills/deploy\n---\nname: deploy\ndescription: U\n---\n',
      '\x1euser /home/me/.claude/skills/lint\n---\nname: lint\n---\n',
    ].join('');

    const skills = await listAgentSkills('claude', {
      hostId: 'host-1',
      projectDir: '/work/feature',
      projectDirOnHost: true,
    });

    // The listing comes in the order the agent prefers, so the first of a name is the one it runs
    expect(skills).toEqual([
      { name: 'deploy', description: 'P', source: 'project', folder: '.claude' },
      { name: 'lint', description: '', source: 'user', folder: '.claude' },
    ]);
    expect(state.hostScripts).toHaveLength(1);
    expect(state.hostScripts[0]).toContain("'/work/feature/.claude/skills'/*/SKILL.md");
  });
});

describe("listAgentSkills in a managed project's bare clone", () => {
  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
  }

  it('lists the skills committed on the branch, and reads them from it', async () => {
    const source = join(root, 'source');
    writeSkill(
      join(source, '.claude', 'skills'),
      'deploy',
      '---\ndescription: Ships\n---\nShip it.\n'
    );
    git(root, 'init', '-q', '-b', 'main', source);
    git(source, 'add', '.');
    git(source, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'skills');
    // A skill that was never committed isn't the project's
    writeSkill(join(source, '.claude', 'skills'), 'draft', '---\ndescription: Draft\n---\n');
    const bare = join(root, 'bare.git');
    git(root, 'clone', '-q', '--bare', source, bare);
    const folders = { ...local(bare), projectBranch: 'main' };

    expect(await listAgentSkills('claude', folders)).toEqual([
      { name: 'deploy', description: 'Ships', source: 'project', folder: '.claude' },
    ]);
    expect(await readAgentSkill('claude', folders, 'deploy')).toBe('Ship it.');
    expect(await listAgentSkills('claude', { ...folders, projectBranch: 'missing' })).toEqual([]);
  });
});

describe('readAgentSkill', () => {
  it("reads the listed skill's instructions, without its frontmatter", async () => {
    writeSkill(
      join(state.home, '.claude', 'skills'),
      'deploy',
      '\uFEFF---\nname: deploy\ndescription: Ships it\n---\n\n# Deploy\n\nShip the branch.\n'
    );

    expect(await readAgentSkill('claude', local(), 'deploy')).toBe('# Deploy\n\nShip the branch.');
  });

  it('reads the skill the agent runs, of two with one name', async () => {
    const repo = join(root, 'repo');
    writeSkill(
      join(root, 'repo', '.agents', 'skills'),
      'deploy',
      '---\nname: deploy\n---\nProject'
    );
    writeSkill(join(state.home, '.agents', 'skills'), 'deploy', '---\nname: deploy\n---\nUser');

    expect(await readAgentSkill('codex', local(repo), 'deploy')).toBe('Project');
  });

  it('reads a skill on the SSH host from where it was listed there', async () => {
    state.hostOutput = "\x1euser /home/me/.claude/skills/it's here\n---\nname: deploy\n---\n";
    state.hostFile = '---\nname: deploy\n---\nOn the host\n';

    expect(await readAgentSkill('claude', home('host-1'), 'deploy')).toBe('On the host');
    expect(state.hostScripts[1]).toBe(`cat -- '/home/me/.claude/skills/it'"'"'s here/SKILL.md'`);
  });

  it('is null for a skill that is gone or unreadable', async () => {
    expect(await readAgentSkill('claude', local(), 'deploy')).toBeNull();
    state.hostOutput = '\x1euser /home/me/.claude/skills/deploy\n---\nname: deploy\n---\n';
    state.hostFails = true;
    expect(await readAgentSkill('claude', home('host-1'), 'deploy')).toBeNull();
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

    const output = execFileSync('sh', ['-c', hostSkillListingScript('codex', null)], {
      env: { PATH: process.env.PATH, HOME: state.home },
      encoding: 'utf8',
    });

    expect(parseHostSkillListing(output, 'codex')).toEqual([
      { name: 'from-agents', description: 'A', source: 'user', folder: '.agents' },
      { name: 'legacy', description: 'B', source: 'user', folder: '.codex' },
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

    const output = execFileSync('sh', ['-c', hostSkillListingScript('claude', null)], {
      env: { PATH: process.env.PATH, HOME: state.home },
      encoding: 'utf8',
    });

    expect(output).not.toContain('SECRET BODY');
    expect(output).not.toContain('No frontmatter');
    expect(parseHostSkillListing(output, 'claude')).toEqual([
      { name: 'long', description: 'Last', source: 'user', folder: '.claude' },
    ]);
  });

  it("lists the project folder's skills on the host too, in the order the agent prefers", () => {
    const workspace = join(root, "work's tree");
    writeSkill(join(workspace, '.agents', 'skills'), 'deploy', '---\ndescription: P\n---\n');
    writeSkill(join(state.home, '.agents', 'skills'), 'deploy', '---\ndescription: U\n---\n');
    writeSkill(join(state.home, '.claude', 'skills'), 'review', '---\ndescription: C\n---\n');

    const output = (family: 'claude' | 'codex' | 'agents') =>
      execFileSync('sh', ['-c', hostSkillListingScript(family, workspace)], {
        env: { PATH: process.env.PATH, HOME: state.home },
        encoding: 'utf8',
      });

    expect(parseHostSkillListing(output('agents'), 'agents')).toEqual([
      { name: 'deploy', description: 'P', source: 'project', folder: '.agents' },
      { name: 'deploy', description: 'U', source: 'user', folder: '.agents' },
      { name: 'review', description: 'C', source: 'user', folder: '.claude' },
    ]);
    // Claude Code reads only .claude folders, the user's first
    expect(parseHostSkillListing(output('claude'), 'claude')).toEqual([
      { name: 'review', description: 'C', source: 'user', folder: '.claude' },
    ]);
  });

  it('prints nothing and exits cleanly when the folders are missing', () => {
    const output = execFileSync('sh', ['-c', hostSkillListingScript('claude', null)], {
      env: { PATH: process.env.PATH, HOME: state.home },
      encoding: 'utf8',
    });
    expect(output).toBe('');
  });
});
