/* eslint-disable import/order -- Vitest needs the mocked modules declared before their imports. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { mockElectron } from "../../mocks/electron";

vi.mock("electron", () => mockElectron());

vi.mock("../../../src/main/services/paths", () => ({
  getKomlaBasePath: vi.fn(),
}));

vi.mock("@electron-toolkit/utils", () => ({
  is: { dev: true },
}));

// These imports intentionally follow the hoisted mocks so the module initializes
// against the test paths and Electron shim.
import { getKomlaBasePath } from "../../../src/main/services/paths";
import { installBundledSkills } from "../../../src/main/lib/install-skills";

function readProjectSetupInstructions(): string {
  return readFileSync(
    join(
      process.cwd(),
      "resources",
      "skills",
      "komla-project-setup-instructions.md",
    ),
    "utf-8",
  );
}

describe("installBundledSkills", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `komla-test-skills-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    vi.mocked(getKomlaBasePath).mockReturnValue(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("bundles the everyday Komla skill for installation", () => {
    const sourceDir = join(process.cwd(), "resources", "skills");
    installBundledSkills(sourceDir);
    expect(readFileSync(join(testDir, "skills", "komla", "SKILL.md"), "utf8")).toBe(
      readFileSync(join(sourceDir, "komla", "SKILL.md"), "utf8"),
    );
  });

  it("installs the appearance guide pointing at this data dir's theme file", () => {
    installBundledSkills(join(process.cwd(), "resources", "skills"));

    const skillsDir = join(testDir, "skills");
    expect(
      readFileSync(join(skillsDir, "komla-appearance-instructions.md"), "utf8"),
    ).toContain(`\`${testDir}/settings/theme.json\``);
  });

  it("installs the customize guide pointing at this data dir's settings folder", () => {
    installBundledSkills(join(process.cwd(), "resources", "skills"));

    const skillsDir = join(testDir, "skills");
    expect(
      readFileSync(join(skillsDir, "komla-customize-instructions.md"), "utf8"),
    ).toContain(`\`${testDir}/settings/\``);
  });

  it("copies skill directory and sibling loose instruction file", () => {
    const sourceDir = join(testDir, "source-skills");
    mkdirSync(join(sourceDir, "komla"), { recursive: true });
    writeFileSync(
      join(sourceDir, "komla", "SKILL.md"),
      "---\nname: test\nversion: 1\n---\n# Test",
    );
    writeFileSync(
      join(sourceDir, "komla-project-setup-instructions.md"),
      "# Detailed instructions",
    );

    installBundledSkills(sourceDir);

    const skillsDir = join(testDir, "skills");
    const destSkillDir = join(skillsDir, "komla");
    expect(existsSync(join(destSkillDir, "SKILL.md"))).toBe(true);
    expect(readFileSync(join(destSkillDir, "SKILL.md"), "utf-8")).toContain(
      "# Test",
    );

    // The loose instructions file sits alongside the skill directory, not
    // inside it, so `npx skills add` doesn't bundle it into the user's
    // ~/.claude/skills/ snapshot.
    expect(existsSync(join(destSkillDir, "INSTRUCTIONS.md"))).toBe(false);
    expect(
      existsSync(join(skillsDir, "komla-project-setup-instructions.md")),
    ).toBe(true);
    expect(
      readFileSync(
        join(skillsDir, "komla-project-setup-instructions.md"),
        "utf-8",
      ),
    ).toContain("# Detailed instructions");
  });

  it("removes stale files from previous versions", () => {
    const skillsDir = join(testDir, "skills", "komla");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), "# Old");
    writeFileSync(join(skillsDir, "old-file.md"), "# Should be removed");

    const sourceDir = join(testDir, "source-skills");
    mkdirSync(join(sourceDir, "komla"), { recursive: true });
    writeFileSync(
      join(sourceDir, "komla", "SKILL.md"),
      "---\nname: test\nversion: 2\n---\n# New",
    );

    installBundledSkills(sourceDir);

    expect(readFileSync(join(skillsDir, "SKILL.md"), "utf-8")).toContain(
      "# New",
    );
    expect(existsSync(join(skillsDir, "old-file.md"))).toBe(false);
  });

  it("substitutes {{komlaDir}} in skill and loose files", () => {
    const sourceDir = join(testDir, "source-skills");
    mkdirSync(join(sourceDir, "komla"), { recursive: true });
    writeFileSync(
      join(sourceDir, "komla", "SKILL.md"),
      "Read {{komlaDir}}/skills/komla-project-setup-instructions.md.",
    );
    writeFileSync(
      join(sourceDir, "komla-project-setup-instructions.md"),
      "Settings live at `{{komlaDir}}/settings/`.",
    );

    installBundledSkills(sourceDir);

    const skillsDir = join(testDir, "skills");
    expect(
      readFileSync(join(skillsDir, "komla", "SKILL.md"), "utf-8"),
    ).toBe(
      `Read ${testDir}/skills/komla-project-setup-instructions.md.`,
    );
    expect(
      readFileSync(
        join(skillsDir, "komla-project-setup-instructions.md"),
        "utf-8",
      ),
    ).toBe(`Settings live at \`${testDir}/settings/\`.`);
  });

  it("does not throw if source file is missing", () => {
    const sourceDir = join(testDir, "empty-source");
    mkdirSync(sourceDir, { recursive: true });

    expect(() => installBundledSkills(sourceDir)).not.toThrow();
  });

  it("installs the guides alongside the skill", () => {
    const skillsDir = join(testDir, "skills");

    installBundledSkills(join(process.cwd(), "resources", "skills"));

    expect(existsSync(join(skillsDir, "komla-customize-instructions.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "komla-status-items-instructions.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "komla-automations-instructions.md"))).toBe(true);
  });

  it("komla skill launches agents only when the user asks", () => {
    const content = readFileSync(
      join(process.cwd(), "resources", "skills", "komla", "SKILL.md"),
      "utf-8",
    ).replace(/\s+/g, " ");
    const description = content.match(/description: (.*?) --- /)?.[1] ?? "";

    expect(description).toContain(
      "when the user asks Komla to start an agent in a new workspace or tab",
    );
    expect(description).not.toMatch(/in parallel|hand off|split work/i);
    expect(content).toContain(
      "Run each `komla` command for an effect the user asked for",
    );
  });

  it("komla skill creates scheduled agents as automations through the customize guide", () => {
    const skill = readFileSync(
      join(process.cwd(), "resources", "skills", "komla", "SKILL.md"),
      "utf-8",
    ).replace(/\s+/g, " ");
    const customize = readFileSync(
      join(process.cwd(), "resources", "skills", "komla-customize-instructions.md"),
      "utf-8",
    ).replace(/\s+/g, " ");
    const automations = readFileSync(
      join(process.cwd(), "resources", "skills", "komla-automations-instructions.md"),
      "utf-8",
    );

    expect(skill.match(/description: (.*?) --- /)?.[1]).toContain("on a schedule");
    expect(skill).toContain("agents Komla starts on a schedule");
    expect(customize).toContain("run `komla skill automations` for their format");
    expect(customize).toContain("The resource is `automations`.");
    expect(customize).toContain("Settings → General → Settings history records every change except automations");
    expect(automations).toMatch(/Settings history doesn't record automations/);
  });

  it("standalone guides apply their resource through `komla settings apply`", () => {
    for (const [guide, resource] of [
      ["komla-status-items-instructions.md", "status-items"],
      ["komla-automations-instructions.md", "automations"],
    ]) {
      const content = readFileSync(join(process.cwd(), "resources", "skills", guide), "utf-8").replace(
        /\s+/g,
        " ",
      );
      expect(content).toContain(`\`komla settings apply ${resource}\``);
      expect(content).toContain("show the user each change first");
    }
  });

  it("automation guides pick a launch mode that runs without a person to answer prompts", () => {
    const automations = readFileSync(
      join(process.cwd(), "resources", "skills", "komla-automations-instructions.md"),
      "utf-8",
    ).replace(/\s+/g, " ");
    const projectSetup = readProjectSetupInstructions().replace(/\s+/g, " ");

    expect(automations).toContain("Nobody answers permission prompts during a run");
    // Automations list every mode, unlike `komla agent presets`; the user approves each one.
    expect(automations).toContain("from `agents`");
    expect(automations).toContain("A mode with `skipsPermissionPrompts`");
    expect(automations).toContain("apply after they choose");
    // The automations guide is the one place that says how to pick the mode.
    expect(projectSetup).toContain("run `komla skill automations` for their format and how to pick");
    expect(projectSetup).not.toContain("skipsPermissionPrompts");
    expect(automations + projectSetup).not.toContain("komla agent presets");
  });

  it("komla skill retries sandbox-blocked commands with approved network access", () => {
    const skill = readFileSync(
      join(process.cwd(), "resources", "skills", "komla", "SKILL.md"),
      "utf-8",
    ).replace(/\s+/g, " ");
    const content = readProjectSetupInstructions();

    expect(skill).toContain(
      "When a sandbox blocks a `komla` command's network access, ask the user to approve running it again with network access.",
    );
    expect(content).toMatch(/ask the user to approve a retry with network access/);
    expect(content).toMatch(/reach Komla only through `komla` commands/);
    expect(content).toMatch(/exact entries to make in Komla's Settings/);
    expect(content).not.toContain("{{komlaDir}}/port");
    expect(content).not.toContain("On SSH");
  });

  it("project setup reads settings through the CLI without relying on local Komla paths", () => {
    const content = readProjectSetupInstructions();

    expect(content).toContain("WORKSPACE_SETUP_UNSUPPORTED");
    expect(content).not.toContain("X-Komla-Workspace-Id");
    expect(content).toMatch(/CLI.*workspace and project to Komla/is);
  });

  it("project setup reads settings as direct JSON without version-header ceremony", () => {
    const content = readProjectSetupInstructions();

    expect(content).toContain(
      'komla settings get actions --scope global',
    );
    expect(content).not.toContain("/api/v1/settings/");
    expect(content).toMatch(/Run the three reads in one tool call/i);
    expect(content).toMatch(/three plain commands that print their JSON/i);
    expect(content).not.toContain("curl -fsS -H");
    expect(content).not.toContain("curl -fsS");
    expect(content).not.toContain("curl -sS");
    expect(content).toMatch(/JSON body names the error's `code`/i);
    expect(content).not.toMatch(/current-project&cwd/);
    expect(content).not.toContain("curl -fsS -i");
    expect(content).not.toContain("If-Match");
    expect(content).not.toMatch(/version token/i);
  });

  it("project setup prioritizes the environment new workspaces start in", () => {
    const content = readProjectSetupInstructions();

    expect(content).toContain("setupCapabilities");
    expect(content).toContain("currentEnvironment");
    expect(content).toContain("selectedForNewWorkspaces");
    expect(content).toMatch(/configured-only.*optional/is);
  });

  it("project setup prepares dependencies where SSH Terminal Commands execute", () => {
    const content = readProjectSetupInstructions();

    expect(content).toContain("actionsRunInLocalCopy");
    expect(content).toMatch(/dependency.*`ssh-local-copy`/is);
    expect(content).toMatch(/remote.*dependency.*agent/is);
  });

  it("project setup keeps new current-project Quick Command entries free of persistence identity", () => {
    const content = readProjectSetupInstructions();

    expect(content).toMatch(/Komla generates the Quick Command ID/i);
    expect(content).toMatch(
      /infers the project association from the\s+request context/i,
    );
    expect(content).toMatch(
      /New Quick Command entries omit `id`, `projectCount`,\s+and `projectIds`/i,
    );
    expect(content).toContain(
      '{ "title": "Develop", "content": "npm run dev", "type": "command" }',
    );
  });

  it("project setup asks whether to create or customize its minimal recommendation", () => {
    const content = readProjectSetupInstructions();

    expect(content).toContain("## 3. Propose a compact recommendation");
    expect(content).toContain("❓");
    expect(content).toContain("Alternatives:");
    expect(content).toContain("one or two focused questions");
    expect(content).toContain(
      "Would you like me to create this recommended minimal setup in Komla?",
    );
    expect(content).toContain("Proceed with this setup");
    expect(content).toContain("Modify the setup");
    expect(content).toContain("Add more shortcuts");
    expect(content).toContain("Configure new-workspace workflow");
    expect(content).toMatch(/confirmation dialog[\s\S]*before saving/i);
    expect(content).not.toContain("Review these changes");
    expect(content).not.toContain("Recommendation: Review these changes");
    expect(content).not.toContain("Shall I open Komla's review");
    expect(content).not.toContain("Submit it");
    expect(content).toMatch(
      /Label each recommended\s+item `Add`, `Update`, or `Remove`/i,
    );
    expect(content).not.toContain("Would you like to use these defaults");
    expect(content).toContain("Install dependencies on creation");
    expect(content).toMatch(/Primary development command/i);
    expect(content).toMatch(/Offer more\s+choices only when the\s+user asks/);
    expect(content).toMatch(
      /do not\s+print the full component or shortcut inventory/i,
    );
  });

  it("project setup bases its recommendation on value instead of unchanged settings", () => {
    const content = readProjectSetupInstructions();

    expect(content).toMatch(
      /Choose the recommended setup for its concrete benefit/i,
    );
    expect(content).toMatch(
      /Mention\s+existing settings only when they\s+materially constrain/i,
    );
  });

  it("project setup keeps discovery evidence out of the conversation unless it informs a choice", () => {
    const content = readProjectSetupInstructions();

    expect(content).toContain("Keep repository evidence out of the reply");
    expect(content).toMatch(
      /Surface a fact only beside the decision it explains/i,
    );
    expect(content).toMatch(
      /Show\s+monorepo breadth through selected Quick Commands/i,
    );
  });

  it("project setup offers lightweight web-server startup without overwhelming the user", () => {
    const content = readProjectSetupInstructions();

    expect(content).toMatch(/Other useful\s+options/);
    expect(content).toContain("one to three");
    expect(content).toContain("lightweight web server");
    expect(content).toContain("handles port conflicts");
    expect(content).toContain("supports an explicit port option");
    expect(content).toContain("How should <server> fit into new workspaces?");
    expect(content).toContain("Start in a new tab");
    expect(content).toContain("Keep as a manual Quick Command");
    expect(content).toContain("new tab");
  });

  it("project setup offers terminal and process workflow preferences", () => {
    const content = readProjectSetupInstructions();

    expect(content).toContain("what starts automatically");
    expect(content).toContain("new tab");
    expect(content).toContain("split right");
    expect(content).toContain("split bottom");
    expect(content).toContain("background");
    expect(content).toMatch(/automatically\s+start selected\s+services/i);
    expect(content).toMatch(/whenever a new workspace\s+is created/i);
    expect(content).toMatch(/How should <server> fit into new workspaces\?/);
    expect(content).toMatch(
      /Preserve the current layout unless the user chooses/i,
    );
  });

  it("project setup discovers environment prerequisites without exposing secrets", () => {
    const content = readProjectSetupInstructions();

    expect(content).toContain(".env.example");
    expect(content).toMatch(/environment templates/i);
    expect(content).toMatch(/project-owned bootstrap/i);
    expect(content).toMatch(/`workspace-creation` step/i);
    expect(content).toMatch(/never overwrites/i);
    expect(content).toMatch(
      /Do not read or print values from ignored or local\s+environment files/i,
    );
    expect(content).toMatch(/Do not put secret values/i);
    expect(content).toMatch(/manual prerequisite/i);
  });

  it("project setup leaves worktree-safe port selection to project commands", () => {
    const content = readProjectSetupInstructions();

    expect(content).toMatch(
      /port\s+selection belongs to the project, not Komla/i,
    );
    expect(content).toMatch(/Do not recommend a port number/);
    expect(content).toMatch(
      /project command or wrapper that discovers a free port/,
    );
    expect(content).toContain("worktree-safe");
  });

  it("project setup reuses automatic process Quick Commands without racing bootstrap work", () => {
    const content = readProjectSetupInstructions();

    expect(content).toContain("Define each automatically started command once");
    expect(content).toMatch(/Reference an automatic Quick Command's generated ID/i);
    expect(content).toContain("setup steps do not provide dependency ordering");
    expect(content).toMatch(/could\s+race/);
    expect(content).toMatch(/project-provided bootstrap\s+command/);
    expect(content).toMatch(/single visible setup\s+command/);
    expect(content).toContain("npm install && npm run dev");
    expect(content).toContain("separate parallel setup steps");
  });

  it("project setup inventories every runnable monorepo component", () => {
    const content = readProjectSetupInstructions();

    expect(content).toContain("runnable component inventory");
    expect(content).toContain("package-manager workspace declarations");
    expect(content).toContain("nested manifests even when they are not listed");
    expect(content).toMatch(
      /exclude dependency, build,\s+cache, and vendored directories/,
    );
    expect(content).toMatch(/For each runnable component/i);
    expect(content).toMatch(/remaining\s+runnable service/i);
    expect(content).toContain("working-directory-safe command");
  });

  it("project setup compares canonical and variant development commands", () => {
    const content = readProjectSetupInstructions();

    expect(content).toMatch(/unsuffixed `dev` or\s+`start`/);
    expect(content).toMatch(/distinct\s+common variants/);
    expect(content).toMatch(/separate manual Quick Commands/);
    expect(content).toContain("secondary runnable component");
  });

  it("project setup recommends multiple useful secondary components compactly", () => {
    const content = readProjectSetupInstructions();

    expect(content).toMatch(/Rank every secondary runnable component/i);
    expect(content).toMatch(/day-to-day value/i);
    expect(content).toMatch(/readiness|prerequisite/i);
    expect(content).toMatch(/account for peers/i);
    expect(content).toMatch(/useful services in one compact group/i);
    expect(content).toMatch(/up to\s+three/i);
    expect(content).not.toMatch(/select one only/i);
  });

  it("project setup makes recommended development Quick Commands dependency-ready", () => {
    const content = readProjectSetupInstructions();

    expect(content).toMatch(/dependency (root|domain)/i);
    expect(content).toMatch(/independent lockfile/i);
    expect(content).toMatch(/conditional install guard/i);
    expect(content).toMatch(/recommended development Quick Command/i);
    expect(content).toMatch(/`workspace-creation` setup/i);
  });

  it("project setup keeps the shortcut inventory internal until requested", () => {
    const content = readProjectSetupInstructions();

    expect(content).toContain("internal shortcut inventory");
    expect(content).toMatch(/development, preview, workers, tests/);
    expect(content).toMatch(
      /watchers, typechecking, linting, builds, diagnostics/,
    );
    expect(content).toContain("small relevant subset");
    expect(content).toContain("production-affecting");
  });

  it("project setup does not claim the confirmation dialog opened without evidence", () => {
    const content = readProjectSetupInstructions();

    expect(content).toMatch(
      /A pending `settings apply` proves only that confirmation has not resolved/,
    );
    expect(content).toMatch(/say the dialog should appear, not that it did/);
    expect(content).toContain("Creating this setup in Komla now");
    expect(content).toMatch(
      /Komla should show a confirmation dialog in the target Komla\s+window/,
    );
  });

  it("keeps project setup instructions concise", () => {
    const instructions = readProjectSetupInstructions();

    expect(instructions.trim().split(/\s+/).length).toBeLessThanOrEqual(1900);
  });
});
