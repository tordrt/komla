import { execSync } from 'child_process';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import fs from 'fs';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  test as base,
  type ElectronApplication,
  type Page,
  _electron,
  expect,
} from '@playwright/test';

import { AGENT, AGENT_SUFFIX, buildPresetsJson } from '../agent-profiles';
import { firstRendererWindow } from '../electron-app';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIR = '/tmp/komla-screenshots';
const SCREENSHOTS_DIR = __dirname;
const CLAUDE_JSON_PATH = path.join(homedir(), '.claude.json');
const CLAUDE_SETTINGS_PATH = path.join(homedir(), '.claude', 'settings.json');
const GEMINI_SETTINGS_PATH = path.join(homedir(), '.gemini', 'settings.json');

const THEME_MODE = process.env.SCREENSHOT_THEME === 'light' ? 'light' : 'dark';

const BRANCHES = {
  auth: `${AGENT.branchPrefix}add-auth`,
  nav: `${AGENT.branchPrefix}fix-nav-bug`,
  dark: `${AGENT.branchPrefix}dark-mode`,
  stripe: `${AGENT.branchPrefix}stripe-integration`,
  tests: `${AGENT.branchPrefix}test-coverage`,
  cache: `${AGENT.branchPrefix}redis-cache`,
  ci: `${AGENT.branchPrefix}ci-pipeline`,
  migrations: `${AGENT.branchPrefix}db-migrations`,
};

function wtPathFor(branchName: string): string {
  return path.join(SANDBOX_DIR, `wt-${branchName.replace(/\//g, '-')}`);
}

type TakeScreenshotFn = (name: string) => Promise<void>;

interface ScreenshotFixtures {
  electronApp: ElectronApplication;
  appWindow: Page;
  takeScreenshot: TakeScreenshotFn;
}

/**
 * Seeds a fake license so the app shows the licensed (non-free-plan) UI.
 * Replicates the encryption from src/main/services/license.service.ts.
 */
function seedLicense(sandboxDir: string) {
  // Get machine ID the same way the app does
  const rawId = execSync('ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformSerialNumber', {
    encoding: 'utf-8',
    timeout: 5000,
  });
  const match = rawId.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
  const machineId = createHash('sha256').update(`darwin:${match![1]}`).digest('hex');

  // Encrypt the screenshot license key with the same algorithm the app uses
  const ENCRYPTION_SALT = 'komla-license-v1';
  const encKey = createHash('sha256')
    .update(machineId + ENCRYPTION_SALT)
    .digest();
  const iv = randomBytes(12);
  const licenseKey = 'KOMLA-SCRN-SH0T-TEST-KEY1';
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const encrypted = Buffer.concat([cipher.update(licenseKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedKey = Buffer.concat([iv, tag, encrypted]).toString('base64');

  fs.writeFileSync(
    path.join(sandboxDir, 'license.json'),
    JSON.stringify(
      {
        licenseKey: encryptedKey,
        activatedAt: Date.now(),
        machineId,
        encrypted: true,
      },
      null,
      2
    )
  );
}

function seedTheme(sandboxDir: string) {
  const settingsDir = path.join(sandboxDir, 'settings');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'theme.json'), JSON.stringify({ mode: THEME_MODE }));
}

/**
 * Snapshot of a file's pre-test state, so teardown can restore the exact
 * original — including the absence of the file.
 */
type FileBackup = { existed: true; contents: string } | { existed: false };

function readBackup(filePath: string): FileBackup {
  try {
    return { existed: true, contents: fs.readFileSync(filePath, 'utf-8') };
  } catch {
    return { existed: false };
  }
}

function writeBackup(filePath: string, backup: FileBackup) {
  if (backup.existed) {
    fs.writeFileSync(filePath, backup.contents);
  } else {
    try {
      fs.rmSync(filePath);
    } catch {
      // Already gone — nothing to do.
    }
  }
}

/**
 * Pre-trust worktree directories in ~/.claude.json so Claude Code
 * skips the "Do you trust this project?" prompt.
 * Returns the original file state for restoration.
 */
function preTrustDirectories(dirs: string[]): FileBackup {
  let existing: Record<string, unknown> = {};
  const backup = readBackup(CLAUDE_JSON_PATH);
  if (backup.existed) {
    try {
      existing = JSON.parse(backup.contents);
    } catch {
      // Corrupt JSON — fall through with an empty object.
    }
  }

  // Remove mcpServers so Claude Code doesn't show "MCP server needs auth" in the screenshot
  delete existing.mcpServers;

  if (!existing.projects) existing.projects = {};
  const projects = existing.projects as Record<string, Record<string, unknown>>;
  for (const dir of dirs) {
    // Resolve symlinks (macOS: /tmp → /private/tmp) so the path matches what Claude sees
    const realDir = fs.realpathSync(dir);
    if (!projects[realDir]) projects[realDir] = {};
    projects[realDir].hasTrustDialogAccepted = true;
  }

  fs.writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(existing, null, 2));
  return backup;
}

function restoreClaudeJson(backup: FileBackup) {
  writeBackup(CLAUDE_JSON_PATH, backup);
}

/**
 * Replace ~/.claude/settings.json with a minimal version so Claude Code
 * doesn't show noise like /remote-control messages in the screenshot.
 * Returns the original file state for restoration.
 */
function cleanClaudeSettings(): FileBackup {
  const backup = readBackup(CLAUDE_SETTINGS_PATH);
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify({}));
  return backup;
}

function restoreClaudeSettings(backup: FileBackup) {
  writeBackup(CLAUDE_SETTINGS_PATH, backup);
}

/**
 * Strip Komla notification hooks from ~/.gemini/settings.json so globally-installed
 * hooks don't fire during the screenshot test and leak input-required badges into the
 * sidebar. Preserves selectedAuthType and other fields so Gemini doesn't reprompt for
 * authentication. Returns the original file state for restoration.
 */
function cleanGeminiSettings(): FileBackup {
  const backup = readBackup(GEMINI_SETTINGS_PATH);
  if (!backup.existed) return backup;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(backup.contents);
  } catch {
    return backup;
  }
  const hooks = parsed.hooks as
    | Record<string, Array<{ hooks?: Array<{ name?: string }> }>>
    | undefined;
  if (hooks) {
    for (const eventName of Object.keys(hooks)) {
      const matchers = hooks[eventName];
      if (!Array.isArray(matchers)) continue;
      hooks[eventName] = matchers.filter(
        (m) => !m.hooks?.some((h) => h.name === 'komla-notification-hook')
      );
    }
  }
  fs.writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(parsed, null, 2));
  return backup;
}

function restoreGeminiSettings(backup: FileBackup) {
  writeBackup(GEMINI_SETTINGS_PATH, backup);
}

/**
 * Injects fake macOS traffic light dots into the page.
 * The native traffic lights (from titleBarStyle: 'hiddenInset') are OS chrome
 * and aren't captured by page.screenshot(). These match the app's
 * trafficLightPosition: { x: 15, y: 12 } and standard 12px diameter / 20px spacing.
 */
async function injectTrafficLights(page: Page) {
  await page.evaluate(() => {
    if (document.getElementById('fake-traffic-lights')) return;
    const overlay = document.createElement('div');
    overlay.id = 'fake-traffic-lights';
    overlay.style.cssText =
      'position:fixed;top:12px;left:15px;z-index:99999;display:flex;gap:8px;pointer-events:none;';
    for (const color of ['#ff5f57', '#febc2e', '#28c840']) {
      const dot = document.createElement('div');
      dot.style.cssText = `width:12px;height:12px;border-radius:50%;background:${color};`;
      overlay.appendChild(dot);
    }
    document.body.appendChild(overlay);
  });
}

function launchApp() {
  const { CLAUDECODE: _CLAUDECODE, ...cleanEnv } = process.env;
  return _electron.launch({
    args: [path.join(__dirname, '..', '..', 'out', 'main', 'index.js')],
    env: {
      ...cleanEnv,
      KOMLA_DATA_DIR: SANDBOX_DIR,
      KOMLA_API_URL: 'https://test.komla.dev',
      NODE_ENV: 'test',
    },
  });
}

async function setupWindow(electronApp: ElectronApplication): Promise<Page> {
  const window = await firstRendererWindow(electronApp);
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(1280, 800);
  });
  await window.waitForTimeout(200);
  return window;
}

/**
 * Creates a git repo with source files, commits, and uncommitted changes.
 */
function createRepo(repoDir: string, gitEnv: Record<string, string | undefined>) {
  // Create directory structure
  fs.mkdirSync(path.join(repoDir, 'src', 'utils'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true });

  fs.writeFileSync(
    path.join(repoDir, 'README.md'),
    ['# Demo Project', '', 'A sample TypeScript project for demonstrating Komla.'].join('\n')
  );

  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify(
      {
        name: path.basename(repoDir),
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

  return repoDir;
}

/**
 * Creates a git worktree with uncommitted changes.
 */
function createWorktree(
  repoDir: string,
  branchName: string,
  gitEnv: Record<string, string | undefined>,
  changes: { modify?: Record<string, string>; add?: Record<string, string>; delete?: string[] }
) {
  const worktreeDir = path.join(path.dirname(repoDir), `wt-${branchName.replace(/\//g, '-')}`);

  execSync(`git worktree add -b ${branchName} "${worktreeDir}"`, {
    cwd: repoDir,
    env: gitEnv,
  });

  // Make some commits on the branch
  fs.writeFileSync(path.join(worktreeDir, '.gitkeep-branch'), branchName);
  execSync(`git add -A && git commit -m "branch: ${branchName}"`, {
    cwd: worktreeDir,
    env: gitEnv,
  });

  // Apply uncommitted changes
  if (changes.modify) {
    for (const [filePath, content] of Object.entries(changes.modify)) {
      const fullPath = path.join(worktreeDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.appendFileSync(fullPath, content);
    }
  }
  if (changes.add) {
    for (const [filePath, content] of Object.entries(changes.add)) {
      const fullPath = path.join(worktreeDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
  }
  if (changes.delete) {
    for (const filePath of changes.delete) {
      const fullPath = path.join(worktreeDir, filePath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
  }

  return worktreeDir;
}

const landingTest = base.extend<ScreenshotFixtures>({
  electronApp: [
    async ({}, provide) => {
      fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
      fs.mkdirSync(SANDBOX_DIR, { recursive: true });

      fs.writeFileSync(
        path.join(SANDBOX_DIR, 'config.json'),
        JSON.stringify({
          agentSetupComplete: true,
          usageTelemetryConsentAnswered: true,
          showTipsInToolbar: false,
          notificationPort: 52864,
        })
      );
      seedTheme(SANDBOX_DIR);
      seedLicense(SANDBOX_DIR);

      const settingsDir = path.join(SANDBOX_DIR, 'settings');
      fs.mkdirSync(settingsDir, { recursive: true });

      const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      };

      // --- Project 1: acme-web ---
      const webRepo = createRepo(path.join(SANDBOX_DIR, 'acme-web'), gitEnv);

      const wt1 = createWorktree(webRepo, BRANCHES.auth, gitEnv, {
        modify: {
          'src/utils/helpers.ts': [
            '',
            '',
            'export function slugify(text: string): string {',
            '  return text.toLowerCase().replace(/\\s+/g, "-")',
            '}',
          ].join('\n'),
        },
        add: {
          'src/auth/login.ts': [
            'import { slugify, toTitle } from "../utils/helpers"',
            'import { createSession } from "./session"',
            '',
            'interface LoginResult {',
            '  success: boolean',
            '  token?: string',
            '  error?: string',
            '}',
            '',
            'interface User {',
            '  id: string',
            '  email: string',
            '  passwordHash: string',
            '}',
            '',
            '// In-memory user store (replace with DB)',
            'const users = new Map<string, User>()',
            '',
            'export async function login(email: string, password: string): Promise<LoginResult> {',
            '  const user = users.get(email)',
            '  if (!user) {',
            '    return { success: false, error: "Invalid credentials" }',
            '  }',
            '',
            '  const slug = slugify(email)',
            '  const valid = slug === user.email.toLowerCase()',
            '  if (!valid) {',
            '    return { success: false, error: "Invalid credentials" }',
            '  }',
            '',
            '  const session = createSession(user.id)',
            '  return { success: true, token: session.id }',
            '}',
            '',
            'export async function register(email: string, password: string): Promise<LoginResult> {',
            '  if (users.has(email)) {',
            '    return { success: false, error: "Email already registered" }',
            '  }',
            '',
            '  const id = crypto.randomUUID()',
            '  const normalized = slugify(email)',
            '  users.set(normalized, { id, email, passwordHash: password })',
            '',
            '  const session = createSession(id)',
            '  return { success: true, token: session.id }',
            '}',
          ].join('\n'),
          'src/auth/session.ts': [
            'export function createSession(userId: string) {',
            '  return { id: crypto.randomUUID(), userId, expiresAt: Date.now() + 86400000 }',
            '}',
          ].join('\n'),
        },
      });

      // Add more commits to the auth worktree for a richer diff against main
      execSync('git add -A && git commit -m "Add login endpoint with email/password auth"', {
        cwd: wt1,
        env: gitEnv,
      });

      fs.appendFileSync(
        path.join(wt1, 'src/auth/session.ts'),
        [
          '',
          '',
          'export function validateSession(sessionId: string): boolean {',
          '  // TODO: check expiry',
          '  return true',
          '}',
        ].join('\n')
      );
      execSync('git add -A && git commit -m "Add session validation and token refresh"', {
        cwd: wt1,
        env: gitEnv,
      });

      fs.writeFileSync(
        path.join(wt1, 'src/auth/middleware.ts'),
        [
          'import { validateSession } from "./session"',
          '',
          'export function requireAuth(req: any, res: any, next: any) {',
          '  const token = req.headers.authorization?.split(" ")[1]',
          '  if (!token || !validateSession(token)) {',
          '    return res.status(401).json({ error: "Unauthorized" })',
          '  }',
          '  next()',
          '}',
        ].join('\n')
      );

      // Also integrate auth into the main app and replace old tests in the same commit
      fs.writeFileSync(
        path.join(wt1, 'src/index.ts'),
        [
          'import express from "express"',
          'import { formatDate, parseConfig } from "./utils/helpers"',
          'import { requireAuth } from "./auth/middleware"',
          '',
          'const app = express()',
          'const PORT = process.env.PORT || 3000',
          '',
          'app.get("/health", requireAuth, (_req, res) => {',
          '  res.json({ status: "ok", timestamp: formatDate(new Date()) })',
          '})',
          '',
          'app.get("/config", requireAuth, (_req, res) => {',
          '  const config = parseConfig()',
          '  res.json(config)',
          '})',
          '',
          'app.listen(PORT, () => {',
          '  console.log(`Server running on port ${PORT}`)',
          '})',
        ].join('\n')
      );

      fs.unlinkSync(path.join(wt1, 'tests/index.test.ts'));

      fs.writeFileSync(
        path.join(wt1, 'tests/auth.test.ts'),
        [
          'import { describe, it, expect } from "vitest"',
          'import { login, register } from "../src/auth/login"',
          '',
          'describe("register", () => {',
          '  it("should create a new user and return a token", async () => {',
          '    const result = await register("user@test.com", "password123")',
          '    expect(result.success).toBe(true)',
          '    expect(result.token).toBeDefined()',
          '  })',
          '',
          '  it("should reject duplicate emails", async () => {',
          '    await register("dup@test.com", "password123")',
          '    const result = await register("dup@test.com", "password123")',
          '    expect(result.success).toBe(false)',
          '  })',
          '})',
          '',
          'describe("login", () => {',
          '  it("should return error for unknown user", async () => {',
          '    const result = await login("nobody@test.com", "password123")',
          '    expect(result.success).toBe(false)',
          '    expect(result.error).toBe("Invalid credentials")',
          '  })',
          '})',
        ].join('\n')
      );

      execSync('git add -A && git commit -m "Add auth middleware for route protection"', {
        cwd: wt1,
        env: gitEnv,
      });

      // Rewrite helpers.ts to show a mix of additions, deletions, and modifications in the diff
      fs.writeFileSync(
        path.join(wt1, 'src/utils/helpers.ts'),
        [
          'export function formatDate(date: Date): string {',
          '  return date.toISOString().split("T")[0]',
          '}',
          '',
          'export function slugify(text: string): string {',
          '  return text.toLowerCase().replace(/\\s+/g, "-")',
          '}',
          '',
          'export function toTitle(s: string) {',
          '  return s[0].toUpperCase() + s.slice(1)',
          '}',
        ].join('\n')
      );

      // Rewrite src/index.ts to integrate auth routes (shows additions + deletions in diff)
      fs.writeFileSync(
        path.join(wt1, 'src/index.ts'),
        [
          'import express from "express"',
          'import { formatDate } from "./utils/helpers"',
          'import { requireAuth } from "./auth/middleware"',
          'import { login } from "./auth/login"',
          '',
          'const app = express()',
          'const PORT = parseInt(process.env.PORT || "3000", 10)',
          '',
          'app.use(express.json())',
          '',
          'app.post("/auth/login", async (req, res) => {',
          '  const { email, password } = req.body',
          '  const result = await login(email, password)',
          '  res.json(result)',
          '})',
          '',
          'app.get("/health", requireAuth, (_req, res) => {',
          '  res.json({ status: "ok", timestamp: formatDate(new Date()) })',
          '})',
          '',
          'app.listen(PORT, () => {',
          '  console.log(`Server running on port ${PORT}`)',
          '})',
        ].join('\n')
      );

      // Add new file (shows new file in diff)
      fs.writeFileSync(
        path.join(wt1, 'src/auth/types.ts'),
        [
          'export interface AuthToken {',
          '  token: string',
          '  expiresAt: number',
          '  userId: string',
          '}',
          '',
          'export interface Credentials {',
          '  email: string',
          '  password: string',
          '}',
        ].join('\n')
      );

      const wt2 = createWorktree(webRepo, BRANCHES.nav, gitEnv, {
        modify: {
          'src/index.ts': '\n// Fixed: nav bar collapse on mobile\n',
        },
      });

      const wt3 = createWorktree(webRepo, BRANCHES.dark, gitEnv, {
        add: {
          'src/theme.ts': [
            'export type Theme = "light" | "dark" | "system"',
            '',
            'export function getSystemTheme(): Theme {',
            '  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"',
            '}',
          ].join('\n'),
          'src/utils/colors.ts': [
            'export const palette = {',
            '  dark: { bg: "#1a1a2e", fg: "#e0e0e0", accent: "#7c3aed" },',
            '  light: { bg: "#ffffff", fg: "#1a1a2e", accent: "#6d28d9" },',
            '}',
          ].join('\n'),
        },
      });

      // --- Project 2: acme-api ---
      const apiRepo = createRepo(path.join(SANDBOX_DIR, 'acme-api'), gitEnv);

      const wt4 = createWorktree(apiRepo, BRANCHES.stripe, gitEnv, {
        add: {
          'src/stripe/webhook.ts': [
            'import Stripe from "stripe"',
            '',
            'export async function handleWebhook(payload: string, sig: string) {',
            '  const event = JSON.parse(payload) as Stripe.Event',
            '  switch (event.type) {',
            '    case "checkout.session.completed":',
            '      // Handle successful checkout',
            '      break',
            '  }',
            '}',
          ].join('\n'),
          'src/stripe/client.ts': [
            'import Stripe from "stripe"',
            '',
            'export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {',
            '  apiVersion: "2024-12-18.acacia",',
            '})',
          ].join('\n'),
        },
        modify: {
          'src/index.ts': '\n// Added Stripe webhook route\n',
          'src/utils/helpers.ts': [
            '',
            '',
            'export function verifySignature(payload: string, sig: string, secret: string): boolean {',
            '  // TODO: HMAC verification',
            '  return true',
            '}',
          ].join('\n'),
        },
      });

      // Clean worktree (no uncommitted changes, not ahead/behind main) for a stopped workspace,
      // which the sidebar's "Show stopped workspaces" toggle needs
      const wt5 = createWorktree(webRepo, BRANCHES.tests, gitEnv, {});
      execSync('git reset --hard main', { cwd: wt5, env: gitEnv });

      // Pre-trust all worktree directories so Claude Code skips the trust prompt.
      // Only applies when targeting Claude; other agents have their own trust mechanisms.
      const allWorktrees = [wt1, wt2, wt3, wt4, wt5];
      const claudeJsonBackup = AGENT.id === 'claude' ? preTrustDirectories(allWorktrees) : null;
      const claudeSettingsBackup = AGENT.id === 'claude' ? cleanClaudeSettings() : null;
      const geminiSettingsBackup = AGENT.id === 'gemini' ? cleanGeminiSettings() : null;

      // Seed projects
      fs.writeFileSync(
        path.join(settingsDir, 'projects.json'),
        JSON.stringify({
          _version: 1,
          projects: [
            {
              id: 'proj-web',
              name: 'acme-web',
              repositoryPath: webRepo,
              defaultBranchPrefix: AGENT.branchPrefix,
              createdAt: Date.now(),
              order: 0,
              managed: false,
              color: 'hsl(200, 75%, 50%)',
            },
            {
              id: 'proj-api',
              name: 'acme-api',
              repositoryPath: apiRepo,
              defaultBranchPrefix: AGENT.branchPrefix,
              createdAt: Date.now(),
              order: 1,
              managed: false,
              color: 'hsl(340, 70%, 55%)',
            },
          ],
        })
      );

      // Seed workspaces
      const now = Date.now();
      const HOUR = 3600000;
      const DAY = 24 * HOUR;

      fs.writeFileSync(
        path.join(SANDBOX_DIR, 'workspaces.json'),
        JSON.stringify([
          // --- Active workspaces (recent activity) ---
          {
            id: 'ws-auth',
            name: 'Add Auth',
            customName: 'Auth',
            workingDirectory: wt1,
            branchName: BRANCHES.auth,
            isWorktree: true,
            projectId: 'proj-web',
            windowId: null,
            categoryId: null,
            createdAt: now - 3 * HOUR,
            lastActivityAt: now - 60000,
            order: 0,
            terminals: [],
          },
          {
            id: 'ws-dark',
            name: 'Dark Mode',
            customName: 'Dark Mode',
            workingDirectory: wt3,
            branchName: BRANCHES.dark,
            isWorktree: true,
            projectId: 'proj-api',
            windowId: null,
            categoryId: null,
            createdAt: now - HOUR,
            lastActivityAt: now - 2 * DAY,
            order: 1,
            terminals: [],
          },
          {
            id: 'ws-stripe',
            name: 'Stripe Integration',
            customName: 'Stripe Integration',
            workingDirectory: wt4,
            branchName: BRANCHES.stripe,
            isWorktree: true,
            projectId: 'proj-api',
            windowId: null,
            categoryId: null,
            createdAt: now - 5 * HOUR,
            lastActivityAt: now - 12 * 60000,
            order: 2,
            terminals: [],
          },
          {
            id: 'ws-nav',
            name: 'Fix Nav Bug',
            customName: 'Fix Nav Bug',
            workingDirectory: wt2,
            branchName: BRANCHES.nav,
            isWorktree: true,
            projectId: 'proj-web',
            windowId: null,
            categoryId: null,
            createdAt: now - 8 * HOUR,
            lastActivityAt: now - 5 * 60000,
            order: 3,
            terminals: [],
          },

          // --- Stopped workspace (old, no uncommitted changes, not ahead/behind main) ---
          {
            id: 'ws-tests',
            name: 'Test Coverage',
            workingDirectory: wt5,
            branchName: BRANCHES.tests,
            isWorktree: true,
            projectId: 'proj-api',
            windowId: null,
            categoryId: null,
            createdAt: now - 5 * DAY,
            lastActivityAt: now - 3 * DAY,
            order: 4,
            terminals: [],
          },

          // --- Workspaces in the Trash ---
          {
            id: 'ws-cache',
            name: 'Redis Cache Layer',
            workingDirectory: wt1,
            branchName: BRANCHES.cache,
            isWorktree: true,
            projectId: 'proj-api',
            windowId: null,
            categoryId: null,
            createdAt: now - 25 * DAY,
            lastActivityAt: now - 22 * DAY,
            status: 'trashed' as const,
            order: 5,
            terminals: [],
          },
          {
            id: 'ws-ci',
            name: 'CI Pipeline',
            workingDirectory: wt1,
            branchName: BRANCHES.ci,
            isWorktree: true,
            projectId: 'proj-web',
            windowId: null,
            categoryId: null,
            createdAt: now - 35 * DAY,
            lastActivityAt: now - 32 * DAY,
            status: 'trashed' as const,
            order: 6,
            terminals: [],
          },
          {
            id: 'ws-migrations',
            name: 'DB Migrations',
            workingDirectory: wt1,
            branchName: BRANCHES.migrations,
            isWorktree: true,
            projectId: 'proj-api',
            windowId: null,
            categoryId: null,
            createdAt: now - 40 * DAY,
            lastActivityAt: now - 38 * DAY,
            status: 'trashed' as const,
            order: 7,
            terminals: [],
          },
        ])
      );

      fs.writeFileSync(
        path.join(settingsDir, 'actions.json'),
        JSON.stringify({
          actions: [
            {
              id: 'tpl-1',
              title: 'Run dev server',
              content: 'npm run dev',
              type: 'command',
              order: 0,
            },
            { id: 'tpl-2', title: 'Run tests', content: 'npm run test', type: 'command', order: 1 },
            {
              id: 'tpl-3',
              title: 'Lint & fix',
              content: 'npm run lint --fix',
              type: 'command',
              order: 2,
            },
            {
              id: 'tpl-4',
              title: 'Review current branch',
              content: 'Review the changes on this branch against main.',
              type: 'prompt',
              order: 3,
            },
            {
              id: 'tpl-5',
              title: 'Bug scan',
              content: 'Scan commits from main..HEAD for likely bugs.',
              type: 'prompt',
              order: 4,
            },
            {
              id: 'tpl-6',
              title: 'Draft PR description',
              content: 'Draft a pull request description for the changes on this branch.',
              type: 'prompt',
              order: 5,
            },
          ],
        })
      );

      // Pre-seed agent presets so workspaces launch with the target agent.
      fs.writeFileSync(
        path.join(settingsDir, 'agent-presets.json'),
        JSON.stringify(buildPresetsJson(now))
      );

      let app: ElectronApplication | undefined;
      try {
        app = await launchApp();
        await provide(app);
      } finally {
        if (app) await app.close().catch(() => undefined);
        if (claudeJsonBackup !== null) restoreClaudeJson(claudeJsonBackup);
        if (claudeSettingsBackup !== null) restoreClaudeSettings(claudeSettingsBackup);
        if (geminiSettingsBackup !== null) restoreGeminiSettings(geminiSettingsBackup);
      }
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

landingTest.describe('Landing Page Screenshots', () => {
  landingTest(
    'capture screenshots for the landing page',
    async ({ electronApp, appWindow, takeScreenshot }) => {
      landingTest.setTimeout(180_000); // Agent startup + prompt response needs time
      // Wait for the workspace list to load
      const addAuthCard = appWindow.getByText('Auth', { exact: true }).first();
      await expect(addAuthCard).toBeVisible({ timeout: 15_000 });

      // Activate four workspaces so they appear as running
      await appWindow.keyboard.press('Meta+1');
      await appWindow.waitForTimeout(3000);
      await appWindow.keyboard.press('Meta+2');
      await appWindow.waitForTimeout(3000);
      await appWindow.keyboard.press('Meta+3');
      await appWindow.waitForTimeout(3000);
      await appWindow.keyboard.press('Meta+4');
      await appWindow.waitForTimeout(2000);

      // Switch to Auth (first workspace) for the main workspace screenshot
      await appWindow.keyboard.press('Meta+1');
      await appWindow.waitForTimeout(1000);

      // Fold stopped workspaces away in the sidebar so only running ones show
      await appWindow.getByRole('button', { name: /^Filter workspaces/ }).click();
      // The item keeps the menu open.
      const foldStopped = appWindow.getByRole('menuitemcheckbox', {
        name: /^Stopped workspaces/,
      });
      await foldStopped.click();
      await expect(foldStopped).toHaveAttribute('aria-checked', 'true');
      await appWindow.keyboard.press('Escape');
      await appWindow.waitForTimeout(500);

      // Wait for Claude Code to start and finish its initial response
      await appWindow.waitForTimeout(30_000);

      const now = Date.now();
      const HOUR = 3600000;
      // Attention for the sidebar. Nav workspace shows:
      // - Input badge for agents that emit input-required (all agents today)
      // - Idle badge for agents with navStartsIdle (none today)
      // - Otherwise the agent's finish kind
      const navAttentionKind: 'input-required' | 'idle' | 'turn-complete' =
        AGENT.supportsInputRequired
          ? 'input-required'
          : AGENT.navStartsIdle
            ? 'idle'
            : AGENT.finishKind;
      const navAttention = {
        kind: navAttentionKind,
        message: navAttentionKind === 'input-required' ? 'Allow npm test?' : 'Nav bar fix applied',
      };
      const stripeFinishAttention = {
        kind: AGENT.finishKind,
        message: 'Stripe webhook handler added',
      };
      // Selecting a workspace clears its attention, so inject it now.
      // ws-auth is currently open so don't show attention on it
      const sidebarAttention = [
        {
          workspaceId: 'ws-stripe',
          attention: {
            ...stripeFinishAttention,
            source: AGENT.notificationSource,
            updatedAt: now - HOUR,
          },
        },
        {
          workspaceId: 'ws-nav',
          attention: {
            ...navAttention,
            source: AGENT.notificationSource,
            updatedAt: now - 120000,
          },
        },
      ];
      await electronApp.evaluate(({ BrowserWindow }, events) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          for (const event of events) {
            // Workspace-wide attention is also what the card shows.
            win.webContents.send('workspace:needs-attention', {
              ...event,
              workspaceAttention: event.attention,
            });
          }
        }
      }, sidebarAttention);
      await appWindow.waitForTimeout(500);

      // Create a second tab so the tab bar is visible, set its title, then switch back
      await appWindow.keyboard.press('Meta+t');
      await appWindow.waitForTimeout(2000);
      // Set the tab title via OSC escape sequence, then switch back to first tab
      const newTerminalInput = appWindow.locator('textarea[aria-label="Terminal input"]').first();
      await newTerminalInput.click({ force: true });
      await appWindow.waitForTimeout(200);
      await appWindow.keyboard.type('printf "\\033]0;npm run dev\\007"', { delay: 0 });
      await appWindow.keyboard.press('Enter');
      await appWindow.waitForTimeout(500);
      await appWindow.keyboard.press('Meta+[');
      await appWindow.waitForTimeout(500);

      // Re-inject attention after tab creation (workspace selection may have cleared it)
      await electronApp.evaluate(({ BrowserWindow }, events) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          for (const event of events) {
            // Workspace-wide attention is also what the card shows.
            win.webContents.send('workspace:needs-attention', {
              ...event,
              workspaceAttention: event.attention,
            });
          }
        }
      }, sidebarAttention);
      await appWindow.waitForTimeout(500);

      // Type a detailed prompt into the Claude Code terminal input
      await appWindow
        .locator('textarea[aria-label="Terminal input"]')
        .first()
        .click({ force: true });
      await appWindow.waitForTimeout(300);
      await appWindow.keyboard.type('add bcrypt password hashing to login and signup', {
        delay: 30,
      });
      await appWindow.waitForTimeout(500);

      // No inline diff preview — show the Claude terminal for workspace/hero/notification shots.
      // The diff viewer screenshot (landing-diff) is captured later via the full-screen dialog.
      await appWindow.waitForTimeout(500);

      // Inject fake macOS traffic light dots (native ones aren't captured by page.screenshot)
      await injectTrafficLights(appWindow);

      // Clean up visual artifacts before screenshots:
      // 1. Click the xterm terminal canvas to clear any text selection
      //    (xterm.js clears selection on mousedown; avoids triggering Claude Code's Escape handler)
      // 2. Click the sidebar to move focus away from terminal and resize handles
      // 3. Blur focused elements (removes focus rings on resize handles)
      // 4. Hide the workspace quota UI (fake license gets revoked by server validation)
      const xtermCanvas = appWindow.locator('.xterm .xterm-screen canvas').first();
      const canvasBox = await xtermCanvas.boundingBox();
      if (canvasBox) {
        // Click near the top-right corner — safely inside the canvas but away from interactive text
        await appWindow.mouse.click(canvasBox.x + canvasBox.width - 20, canvasBox.y + 10);
      }
      await appWindow.waitForTimeout(100);

      // Click empty area in the sidebar to defocus terminal
      const sidebarBottom = appWindow.locator('.sidebar-surface').first();
      const sidebarBounds = await sidebarBottom.boundingBox();
      if (sidebarBounds) {
        // Click near the bottom center of the sidebar (empty space below workspace cards,
        // but above the sort selector and Overview button)
        await appWindow.mouse.click(
          sidebarBounds.x + sidebarBounds.width / 2,
          sidebarBounds.y + sidebarBounds.height - 120
        );
      }
      await appWindow.waitForTimeout(200);

      await appWindow.evaluate(() => {
        window.getSelection()?.removeAllRanges();
        // Blur any focused element to remove focus rings
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        // Hide the "X of Y workspaces" quota button (only in sidebar)
        const sidebar = document.querySelector('.sidebar-surface');
        if (sidebar) {
          for (const btn of sidebar.querySelectorAll('button')) {
            if (btn.textContent?.includes('workspaces')) {
              const container = btn.closest('div');
              if (container) (container as HTMLElement).style.display = 'none';
              break;
            }
          }
        }
      });
      await appWindow.waitForTimeout(200);

      // === landing-workspace / landing-hero === (active workspace with Claude visible + inline diff preview)
      await takeScreenshot('landing-workspace');
      await takeScreenshot('landing-hero');

      // === landing-notifications GIF frames ===
      // Capture multiple frames showing: spinners → Input badge → Done badge
      // Sends real HTTP notifications to the app's notification server to control state.
      const notifyPort = fs.readFileSync(path.join(SANDBOX_DIR, 'port'), 'utf-8').trim();
      const notifyUrl = `http://127.0.0.1:${notifyPort}/api/v1/notify`;

      // Workspace CWD paths (must match workingDirectory in workspaces.json)
      const cwdNav = wtPathFor(BRANCHES.nav);
      const cwdStripe = wtPathFor(BRANCHES.stripe);
      const cwdDark = wtPathFor(BRANCHES.dark);

      async function sendNotify(cwd: string, kind: string, message?: string) {
        const response = await fetch(notifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, kind, source: AGENT.notificationSource, message }),
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(
            `Notify request failed (${response.status} ${response.statusText}) for ${kind} on ${cwd}: ${body}`
          );
        }
      }

      // Clear the injected attention badges by reloading workspaces from main, which never had
      // them. We can't use HTTP 'idle' because that sets an idle attention object which
      // renders an "Idle" badge that takes precedence over the spinner.
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('workspaces:changed');
      });
      await appWindow.waitForTimeout(300);

      // Pre-seed nav with idle if this agent always has idle present.
      // Happens before any frame is captured so idle is visible from frame 0.
      if (AGENT.navStartsIdle) {
        await sendNotify(cwdNav, 'idle', navAttention.message);
        await appWindow.waitForTimeout(300);
      }

      // Remove stale notification frames from previous runs. Different agents capture
      // different frame counts (Claude: 20, Codex: 20, Gemini: 12, OpenCode: 12) and
      // crop-screenshots.mjs globs all matching files — stale frames from prior runs
      // would otherwise be tacked onto the end of the GIF.
      const frameGlob = new RegExp(
        `^landing-notifications-frame-\\d+${AGENT_SUFFIX}-${THEME_MODE}\\.png$`
      );
      for (const file of fs.readdirSync(SCREENSHOTS_DIR)) {
        if (frameGlob.test(file)) fs.unlinkSync(path.join(SCREENSHOTS_DIR, file));
      }

      const FRAME_INTERVAL = 100;
      let frameIndex = 0;

      // Phase 1: Spinner (Claude, Codex) or baseline (Gemini, OpenCode).
      // For spinner-capable agents, activate spinners on all three unselected workspaces.
      // For others, capture baseline frames so the following transitions are visible as
      // appearing events in the GIF rather than starting mid-state.
      if (AGENT.supportsSpinner) {
        for (const cwd of [cwdNav, cwdStripe, cwdDark]) {
          await sendNotify(cwd, 'prompt-submit');
        }
        await appWindow.waitForTimeout(500);
        for (let i = 0; i < 6; i++) {
          await takeScreenshot(
            `landing-notifications-frame-${String(frameIndex).padStart(2, '0')}`
          );
          frameIndex++;
          await appWindow.waitForTimeout(FRAME_INTERVAL);
        }
      } else {
        for (let i = 0; i < 4; i++) {
          await takeScreenshot(
            `landing-notifications-frame-${String(frameIndex).padStart(2, '0')}`
          );
          frameIndex++;
          await appWindow.waitForTimeout(FRAME_INTERVAL);
        }
      }

      // Phase 2: Nav transition (Input/Done/Idle badge appears on Fix Nav Bug).
      // Skipped for agents where nav already has its target state from pre-seed.
      if (!AGENT.navStartsIdle) {
        await sendNotify(cwdNav, navAttention.kind, navAttention.message);
        await appWindow.waitForTimeout(200);
        for (let i = 0; i < 6; i++) {
          await takeScreenshot(
            `landing-notifications-frame-${String(frameIndex).padStart(2, '0')}`
          );
          frameIndex++;
          await appWindow.waitForTimeout(FRAME_INTERVAL);
        }
      }

      // Phase 3: Finish badge (Done for turn-complete, Idle for opencode) on Stripe Integration
      await sendNotify(cwdStripe, AGENT.finishKind, 'Stripe webhook handler added');
      await appWindow.waitForTimeout(200);

      // Capture final state frames (8 frames — holds longer before loop)
      for (let i = 0; i < 8; i++) {
        await takeScreenshot(`landing-notifications-frame-${String(frameIndex).padStart(2, '0')}`);
        frameIndex++;
        await appWindow.waitForTimeout(FRAME_INTERVAL);
      }

      // === Diff Viewer ===
      await appWindow.keyboard.press('Meta+Shift+g');

      const dialog = appWindow.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 5000 });
      await appWindow.waitForTimeout(1500);
      // @pierre/trees exposes nodes as ARIA treeitems keyed by leaf name —
      // there's no per-row data-path attribute on the tree itself.
      const treeNode = (name: string) => dialog.getByRole('treeitem', { name, exact: true });

      await expect(dialog.getByRole('treeitem').first()).toBeVisible({ timeout: 10_000 });

      // Select src/index.ts to show its diff (mix of additions, modifications, and deletions).
      // The tree may auto-expand folders, so check visibility before toggling.
      let indexDiff = treeNode('index.ts');
      if (!(await indexDiff.isVisible())) {
        // src folder is collapsed — expand it
        const srcFolder = treeNode('src');
        if (await srcFolder.isVisible()) {
          await srcFolder.click();
          await appWindow.waitForTimeout(300);
        }
      }
      indexDiff = treeNode('index.ts');
      await expect(indexDiff).toBeVisible({ timeout: 5000 });
      await indexDiff.click();
      await appWindow.waitForTimeout(500);

      await expect(dialog.locator('.monaco-editor').first()).toBeVisible({ timeout: 5000 });
      await appWindow.waitForTimeout(1000);

      // === landing-diff ===
      await takeScreenshot('landing-diff');
    }
  );
});
