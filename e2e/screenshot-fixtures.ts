import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { test as base, type ElectronApplication, type Page, _electron } from '@playwright/test';

import { AGENT_SUFFIX, buildPresetsJson } from './agent-profiles';
import { firstRendererWindow } from './electron-app';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIR = '/tmp/komla-screenshots';
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

/** Set via SCREENSHOT_THEME env var: 'light' | 'dark' (default: 'dark') */
const THEME_MODE = process.env.SCREENSHOT_THEME === 'light' ? 'light' : 'dark';

/** Renderer localStorage key holding the palette, which decides light vs dark. */
const PALETTE_STORAGE_KEY = 'komla.experimental.palette';
/** A light palette from src/renderer/lib/palette-presets.ts. */
const LIGHT_PALETTE_ID = 'frost';

type TakeScreenshotFn = (name: string) => Promise<void>;

interface ScreenshotFixtures {
  electronApp: ElectronApplication;
  appWindow: Page;
  takeScreenshot: TakeScreenshotFn;
}

function seedTheme(sandboxDir: string) {
  const settingsDir = path.join(sandboxDir, 'settings');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'theme.json'), JSON.stringify({ mode: THEME_MODE }));
}

function launchApp() {
  return _electron.launch({
    args: [path.join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      KOMLA_DATA_DIR: SANDBOX_DIR,
      NODE_ENV: 'test',
    },
  });
}

/**
 * The renderer applies the stored palette at startup (theme.json no longer
 * selects light/dark), so store a light one and reload. The previous value is
 * restored right away so it can't leak into later runs via the Electron profile.
 */
async function applyLightPalette(window: Page): Promise<void> {
  const previous = await window.evaluate(
    ([key, paletteId]) => {
      const stored = localStorage.getItem(key);
      localStorage.setItem(key, paletteId);
      return stored;
    },
    [PALETTE_STORAGE_KEY, LIGHT_PALETTE_ID] as const
  );
  await window.reload();
  await window.waitForLoadState('domcontentloaded');
  await window.evaluate(
    ([key, stored]) => {
      if (stored === null) localStorage.removeItem(key);
      else localStorage.setItem(key, stored);
    },
    [PALETTE_STORAGE_KEY, previous] as const
  );
}

async function setupWindow(electronApp: ElectronApplication): Promise<Page> {
  const window = await firstRendererWindow(electronApp);
  if (THEME_MODE === 'light') await applyLightPalette(window);
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(1280, 800);
  });
  await window.waitForTimeout(200);
  return window;
}

/**
 * Fresh app state — clean sandbox, shows SetupWizard on launch.
 */
export const freshTest = base.extend<ScreenshotFixtures>({
  electronApp: [
    async ({}, provide) => {
      fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
      fs.mkdirSync(SANDBOX_DIR, { recursive: true });

      // Seed a different port to avoid banner if regular Komla is running
      fs.writeFileSync(
        path.join(SANDBOX_DIR, 'config.json'),
        JSON.stringify({
          notificationPort: 52864,
          showTipsInToolbar: false,
          aiHelpersOffDismissed: true,
        })
      );
      seedTheme(SANDBOX_DIR);
      const app = await launchApp();
      await provide(app);
      await app.close();
    },
    { scope: 'test' },
  ],

  appWindow: [
    async ({ electronApp }, provide) => {
      await provide(await setupWindow(electronApp));
    },
    { scope: 'test' },
  ],

  takeScreenshot: [
    async ({ appWindow }, provide) => {
      await provide(async (name: string) => {
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
        await appWindow.screenshot({
          path: path.join(SCREENSHOTS_DIR, `${name}${AGENT_SUFFIX}-${THEME_MODE}.png`),
          // Finish overlay enter/exit animations so captures don't land mid-fade.
          animations: 'disabled',
        });
      });
    },
    { scope: 'test' },
  ],
});

/**
 * Configured app state — pre-seeds config and project so the app shows the main UI.
 */
export const configuredTest = base.extend<ScreenshotFixtures>({
  electronApp: [
    async ({}, provide) => {
      fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
      fs.mkdirSync(SANDBOX_DIR, { recursive: true });

      // Pre-seed config so the app skips the setup wizard.
      fs.writeFileSync(
        path.join(SANDBOX_DIR, 'config.json'),
        JSON.stringify({
          agentSetupComplete: true,
          usageTelemetryConsentAnswered: true,
          aiHelpersOffDismissed: true,
          showTipsInToolbar: false,
          notificationPort: 52864,
        })
      );
      seedTheme(SANDBOX_DIR);

      // Create a dummy git repo for the project
      const repoDir = path.join(SANDBOX_DIR, 'dummy-repo');
      fs.mkdirSync(repoDir, { recursive: true });
      const { execSync } = await import('child_process');
      execSync('git init && git commit --allow-empty -m "init"', {
        cwd: repoDir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@test.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@test.com',
        },
      });

      // Pre-seed a project pointing to the dummy repo
      const settingsDir = path.join(SANDBOX_DIR, 'settings');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'projects.json'),
        JSON.stringify({
          _version: 1,
          projects: [
            {
              id: 'screenshot-project',
              name: 'dummy-repo',
              repositoryPath: repoDir,
              defaultBranchPrefix: 'test/',
              createdAt: Date.now(),
              order: 0,
              managed: false,
              color: 'hsl(200, 75%, 50%)',
            },
          ],
        })
      );

      // Pre-seed agent presets so the dialog shows the prompt textarea.
      // The target AGENT is the most recently used so it appears selected in UI.
      fs.writeFileSync(
        path.join(settingsDir, 'agent-presets.json'),
        JSON.stringify(buildPresetsJson())
      );

      const app = await launchApp();
      await provide(app);
      await app.close();
    },
    { scope: 'test' },
  ],

  appWindow: [
    async ({ electronApp }, provide) => {
      await provide(await setupWindow(electronApp));
    },
    { scope: 'test' },
  ],

  takeScreenshot: [
    async ({ appWindow }, provide) => {
      await provide(async (name: string) => {
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
        await appWindow.screenshot({
          path: path.join(SCREENSHOTS_DIR, `${name}${AGENT_SUFFIX}-${THEME_MODE}.png`),
          // Finish overlay enter/exit animations so captures don't land mid-fade.
          animations: 'disabled',
        });
      });
    },
    { scope: 'test' },
  ],
});

/**
 * File viewer state — pre-seeds a repo with real files, commits, and uncommitted
 * changes so the file explorer, diff viewer, and file search have content to show.
 */
export const fileViewerTest = base.extend<ScreenshotFixtures>({
  electronApp: [
    async ({}, provide) => {
      fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
      fs.mkdirSync(SANDBOX_DIR, { recursive: true });

      // Pre-seed config so the app skips the setup wizard
      fs.writeFileSync(
        path.join(SANDBOX_DIR, 'config.json'),
        JSON.stringify({
          agentSetupComplete: true,
          usageTelemetryConsentAnswered: true,
          aiHelpersOffDismissed: true,
          showTipsInToolbar: false,
          notificationPort: 52864,
        })
      );
      seedTheme(SANDBOX_DIR);

      // Create a dummy repo with real source files
      const repoDir = path.join(SANDBOX_DIR, 'dummy-repo');
      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      };
      const { execSync } = await import('child_process');

      // Create directory structure
      fs.mkdirSync(path.join(repoDir, 'src', 'utils'), { recursive: true });
      fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true });

      // Write source files
      fs.writeFileSync(
        path.join(repoDir, 'README.md'),
        [
          '# Demo Project',
          '',
          'A sample TypeScript project for demonstrating Komla file views.',
          '',
          '## Getting Started',
          '',
          '```bash',
          'npm install',
          'npm run dev',
          '```',
        ].join('\n')
      );

      fs.writeFileSync(
        path.join(repoDir, 'package.json'),
        JSON.stringify(
          {
            name: 'demo-project',
            version: '1.0.0',
            type: 'module',
            scripts: { dev: 'tsx src/index.ts', test: 'vitest run' },
            dependencies: { express: '^4.18.0' },
            devDependencies: { typescript: '^5.3.0', vitest: '^1.0.0' },
          },
          null,
          2
        )
      );

      fs.writeFileSync(
        path.join(repoDir, 'src', 'index.ts'),
        [
          'import express from "express"',
          'import { formatDate, parseConfig } from "./utils/helpers"',
          '',
          'const app = express()',
          'const PORT = process.env.PORT || 3000',
          '',
          'app.get("/health", (_req, res) => {',
          '  res.json({ status: "ok", timestamp: formatDate(new Date()) })',
          '})',
          '',
          'app.get("/config", (_req, res) => {',
          '  const config = parseConfig()',
          '  res.json(config)',
          '})',
          '',
          'app.listen(PORT, () => {',
          '  console.log(`Server running on port ${PORT}`)',
          '})',
        ].join('\n')
      );

      fs.writeFileSync(
        path.join(repoDir, 'src', 'utils', 'helpers.ts'),
        [
          'export function formatDate(date: Date): string {',
          '  return date.toISOString().split("T")[0]',
          '}',
          '',
          'export function parseConfig(): Record<string, string> {',
          '  return {',
          '    env: process.env.NODE_ENV || "development",',
          '    version: "1.0.0",',
          '  }',
          '}',
        ].join('\n')
      );

      fs.writeFileSync(
        path.join(repoDir, 'tests', 'index.test.ts'),
        [
          'import { describe, it, expect } from "vitest"',
          'import { formatDate, parseConfig } from "../src/utils/helpers"',
          '',
          'describe("formatDate", () => {',
          '  it("should format date as YYYY-MM-DD", () => {',
          '    const date = new Date("2024-01-15T12:00:00Z")',
          '    expect(formatDate(date)).toBe("2024-01-15")',
          '  })',
          '})',
          '',
          'describe("parseConfig", () => {',
          '  it("should return default config", () => {',
          '    const config = parseConfig()',
          '    expect(config.version).toBe("1.0.0")',
          '  })',
          '})',
        ].join('\n')
      );

      // Initial commit
      execSync('git init -b main && git add -A && git commit -m "Initial commit"', {
        cwd: repoDir,
        env: gitEnv,
      });

      // Create uncommitted changes for the diff viewer
      // 1. Modify helpers.ts — append a new function
      fs.appendFileSync(
        path.join(repoDir, 'src', 'utils', 'helpers.ts'),
        [
          '',
          '',
          'export function slugify(text: string): string {',
          '  return text',
          '    .toLowerCase()',
          '    .replace(/[^a-z0-9]+/g, "-")',
          '    .replace(/^-|-$/g, "")',
          '}',
        ].join('\n')
      );

      // 2. Add a new untracked file
      fs.writeFileSync(
        path.join(repoDir, 'src', 'config.ts'),
        [
          'export interface AppConfig {',
          '  port: number',
          '  environment: string',
          '  debug: boolean',
          '}',
          '',
          'export const defaultConfig: AppConfig = {',
          '  port: 3000,',
          '  environment: "development",',
          '  debug: false,',
          '}',
        ].join('\n')
      );

      // 3. Delete a tracked file
      fs.unlinkSync(path.join(repoDir, 'tests', 'index.test.ts'));

      // Pre-seed a project pointing to the dummy repo
      const settingsDir = path.join(SANDBOX_DIR, 'settings');
      fs.mkdirSync(settingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(settingsDir, 'projects.json'),
        JSON.stringify({
          _version: 1,
          projects: [
            {
              id: 'screenshot-project',
              name: 'dummy-repo',
              repositoryPath: repoDir,
              defaultBranchPrefix: 'test/',
              createdAt: Date.now(),
              order: 0,
              managed: false,
            },
          ],
        })
      );

      // Pre-seed a directory workspace pointing to the repo
      fs.writeFileSync(
        path.join(SANDBOX_DIR, 'workspaces.json'),
        JSON.stringify([
          {
            id: 'screenshot-workspace',
            name: 'demo-workspace',
            workingDirectory: repoDir,
            branchName: 'main',
            isWorktree: true,
            projectId: 'screenshot-project',
            windowId: null,
            categoryId: null,
            createdAt: 1700000000000,
            lastActivityAt: 1700000000000,
            order: 0,
          },
        ])
      );

      const app = await launchApp();
      await provide(app);
      await app.close();
    },
    { scope: 'test' },
  ],

  appWindow: [
    async ({ electronApp }, provide) => {
      await provide(await setupWindow(electronApp));
    },
    { scope: 'test' },
  ],

  takeScreenshot: [
    async ({ appWindow }, provide) => {
      await provide(async (name: string) => {
        fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
        await appWindow.screenshot({
          path: path.join(SCREENSHOTS_DIR, `${name}${AGENT_SUFFIX}-${THEME_MODE}.png`),
          // Finish overlay enter/exit animations so captures don't land mid-fade.
          animations: 'disabled',
        });
      });
    },
    { scope: 'test' },
  ],
});

export { expect } from '@playwright/test';
