import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { test as base, type ElectronApplication, type Page, _electron } from '@playwright/test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A directory under /tmp (the temp folder on Windows) that only this checkout uses, so e2e runs
 * in other worktrees can't wipe it mid-test. Resolved, since Komla stores real paths
 * (/private/tmp on macOS).
 */
export function e2eSandboxDir(name: string): string {
  const checkout = createHash('sha256')
    .update(path.join(__dirname, '..'))
    .digest('hex')
    .slice(0, 8);
  const tmp = process.platform === 'win32' ? os.tmpdir() : fs.realpathSync('/tmp');
  return path.join(tmp, `${name}-${checkout}`);
}

export const SANDBOX_DIR = e2eSandboxDir('komla-e2e');
export const ELECTRON_ENTRY = path.join(__dirname, '..', 'out', 'main', 'index.js');
/** Launch arguments with an Electron profile of this checkout's own, which runs would otherwise
 *  share with every unpackaged Electron app on the machine. */
export const ELECTRON_ARGS = [
  `--user-data-dir=${e2eSandboxDir('komla-e2e-profile')}`,
  ELECTRON_ENTRY,
];
/** Renderer localStorage key of the one-time pane menu hint. */
const PANE_MENU_HINT_STORAGE_KEY = 'komla:pane-menu-hint';

/** A git name and email for launched apps, so tests don't depend on the host's git config. */
export const E2E_GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'E2E',
  GIT_AUTHOR_EMAIL: 'e2e@test.local',
  GIT_COMMITTER_NAME: 'E2E',
  GIT_COMMITTER_EMAIL: 'e2e@test.local',
};

export interface SeedDefaultProjectOptions {
  projectId?: string;
  projectName?: string;
  branchPrefix?: string;
  /** Optional file committed to the seed repo's initial commit. */
  initialFile?: { name: string; content: string };
}

export interface SeedDefaultProjectResult {
  repoDir: string;
  projectId: string;
}

/**
 * Seeds SANDBOX_DIR with a config.json (agentSetupComplete=true), an initialized
 * git repo, and a single project entry pointing at it. Called inside a
 * `seedSandbox` fixture override so it runs after cleanup but before app launch.
 */
export function seedDefaultProject(
  options: SeedDefaultProjectOptions = {}
): SeedDefaultProjectResult {
  const projectId = options.projectId ?? 'e2e-project';
  const projectName = options.projectName ?? 'seed-repo';
  const branchPrefix = options.branchPrefix ?? 'test/';

  fs.writeFileSync(
    path.join(SANDBOX_DIR, 'config.json'),
    JSON.stringify({ agentSetupComplete: true, usageTelemetryConsentAnswered: true })
  );

  const repoDir = path.join(SANDBOX_DIR, projectName);
  fs.mkdirSync(repoDir, { recursive: true });

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'E2E',
    GIT_AUTHOR_EMAIL: 'e2e@test.local',
    GIT_COMMITTER_NAME: 'E2E',
    GIT_COMMITTER_EMAIL: 'e2e@test.local',
  };

  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: repoDir, env: gitEnv });
  };

  git(['init', '-b', 'main']);
  if (options.initialFile) {
    fs.writeFileSync(path.join(repoDir, options.initialFile.name), options.initialFile.content);
    git(['add', '--', options.initialFile.name]);
    git(['commit', '-m', 'init']);
  } else {
    git(['commit', '--allow-empty', '-m', 'init']);
  }

  fs.mkdirSync(path.join(SANDBOX_DIR, 'settings'), { recursive: true });
  fs.writeFileSync(
    path.join(SANDBOX_DIR, 'settings', 'projects.json'),
    JSON.stringify({
      _version: 1,
      projects: [
        {
          id: projectId,
          name: projectName,
          repositoryPath: repoDir,
          defaultBranchPrefix: branchPrefix,
          createdAt: Date.now(),
          order: 0,
          managed: false,
        },
      ],
    })
  );

  return { repoDir, projectId };
}

/** Launch the Electron app pointed at SANDBOX_DIR. Use for tests that need to
 *  restart the app within a single test (e.g. settings-persistence). */
export async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await _electron.launch({
    args: ELECTRON_ARGS,
    env: {
      ...process.env,
      KOMLA_DATA_DIR: SANDBOX_DIR,
      NODE_ENV: 'test',
    },
  });
  const window = await firstRendererWindow(app);
  return { app, window };
}

/** The first window once Komla's renderer page has loaded. Since Electron 44,
 *  `firstWindow()` can resolve while the window still shows its blank initial
 *  document; that document's load state is already reached, so the renderer
 *  navigation would then destroy the page under the test. */
export async function firstRendererWindow(app: ElectronApplication): Promise<Page> {
  const window = await app.firstWindow();
  await window.waitForURL(/\/renderer\/index\.html/, { waitUntil: 'domcontentloaded' });
  // The one-time pane menu hint stays until closed, so it would land in screenshots and demos.
  // It is remembered in the Electron profile, which outlives a run, so without this only the
  // profile's first run would show it.
  await window.evaluate((key) => localStorage.setItem(key, 'shown'), PANE_MENU_HINT_STORAGE_KEY);
  return window;
}

interface ElectronAppFixtures {
  /** Extra environment for the launched app; an undefined value removes the variable. */
  appEnv: Record<string, string | undefined>;
  cleanSandbox: void;
  seedSandbox: void;
  electronApp: ElectronApplication;
  appWindow: Page;
}

export const test = base.extend<ElectronAppFixtures>({
  appEnv: [E2E_GIT_IDENTITY_ENV, { option: true }],

  // eslint-disable-next-line no-empty-pattern
  cleanSandbox: async ({}, provide) => {
    fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
    await provide();
  },

  // Override-point: tests that need a pre-launch project seed override this
  // fixture and call seedDefaultProject() inside it. Default is a no-op so
  // tests like app-launch get a truly empty sandbox.
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    await provide();
  },

  electronApp: async ({ seedSandbox: _seedSandbox, appEnv }, provide) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...appEnv,
      KOMLA_DATA_DIR: SANDBOX_DIR,
      NODE_ENV: 'test',
    };
    for (const key of Object.keys(env)) {
      if (env[key] === undefined) delete env[key];
    }
    const app = await _electron.launch({
      args: ELECTRON_ARGS,
      env: env as Record<string, string>,
    });
    await provide(app);
    await app.close();
  },

  appWindow: async ({ electronApp }, provide) => {
    const window = await firstRendererWindow(electronApp);
    await provide(window);
  },
});

export { expect } from '@playwright/test';
