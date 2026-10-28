import { execSync } from 'child_process';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import fs from 'fs';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { test as base, type ElectronApplication, type Page, _electron } from '@playwright/test';

import { getMachineId } from '../src/main/lib/machine-id';

import { firstRendererWindow } from './electron-app';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Lives in $HOME, sibling to .komla / .komla-dev / .komla-staging.
const SANDBOX_DIR = path.join(homedir(), '.komla-demo');

/**
 * Press a key combination using native macOS key events via osascript.
 * This makes the keypress visible to screen recording software that
 * captures keyboard shortcuts (e.g. KeyCastr).
 *
 * Common key codes: Return=36, Escape=53, Tab=48, Backspace=51,
 * Delete=117, Space=49, Up=126, Down=125, Left=123, Right=124,
 * N=45, S=1, D=2, A=0, E=14, T=17, F=3, \\=42
 * Modifiers: command down, shift down, control down, option down
 */
function nativeKeyPress(keyCode: number, modifiers: string[] = []): Promise<void> {
  return new Promise((resolve) => {
    const modStr = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';
    const script = `tell application "System Events" to key code ${keyCode}${modStr}`;
    execSync(`osascript -e '${script}'`, { timeout: 3000 });
    resolve();
  });
}

/**
 * Pre-compiled Swift binary that double-taps Shift using proper macOS
 * flagsChanged CGEvents. Modifier keys (Shift, Cmd, etc.) don't use
 * regular keyDown/keyUp — they use flagsChanged events with flag masks.
 * That's why osascript `key code 56` doesn't register as a Shift press.
 */
const DOUBLE_TAP_SHIFT_BINARY = '/tmp/komla-demo-double-tap-shift';

function compileDoubleTapShiftHelper(): void {
  if (fs.existsSync(DOUBLE_TAP_SHIFT_BINARY)) return;
  const swiftSrc = `
import CoreGraphics
import Foundation

let tapUs: UInt32 = CommandLine.arguments.count > 1 ? (UInt32(CommandLine.arguments[1]) ?? 80) * 1000 : 80_000
let gapUs: UInt32 = CommandLine.arguments.count > 2 ? (UInt32(CommandLine.arguments[2]) ?? 150) * 1000 : 150_000

func shiftEvent(down: Bool) {
    let src = CGEventSource(stateID: .hidSystemState)
    let event = CGEvent(source: src)!
    event.type = .flagsChanged
    event.flags = down ? .maskShift : []
    event.setIntegerValueField(.keyboardEventKeycode, value: 56)
    event.post(tap: .cghidEventTap)
}

// Tap 1
shiftEvent(down: true)
usleep(tapUs)
shiftEvent(down: false)
usleep(gapUs)
// Tap 2
shiftEvent(down: true)
usleep(tapUs)
shiftEvent(down: false)
`;
  const srcPath = DOUBLE_TAP_SHIFT_BINARY + '.swift';
  fs.writeFileSync(srcPath, swiftSrc);
  execSync(`swiftc -O -o "${DOUBLE_TAP_SHIFT_BINARY}" "${srcPath}"`, { timeout: 60_000 });
  fs.unlinkSync(srcPath);
}

/** Native double-tap Shift via pre-compiled binary with proper flagsChanged events. */
function nativeDoubleTapShift(tapMs = 80, gapMs = 150): void {
  execSync(`"${DOUBLE_TAP_SHIFT_BINARY}" ${tapMs} ${gapMs}`, { timeout: 5000 });
}

/**
 * Type text character-by-character with a natural feel.
 * Each character is typed with a randomized delay to mimic real typing.
 */
async function typeNaturally(
  page: Page,
  selector: string,
  text: string,
  speed: 'slow' | 'medium' | 'fast' = 'medium'
) {
  const baseDelay = { slow: 80, medium: 45, fast: 25 }[speed];
  const el = page.locator(selector);
  // Always re-focus and move cursor to end before typing
  await el.click();
  await page.keyboard.press('Meta+ArrowDown');
  await page.keyboard.press('End');
  for (const char of text) {
    if (char === '\n') {
      await page.keyboard.press('Shift+Enter');
    } else {
      await el.pressSequentially(char, { delay: 0 });
    }
    // Randomize delay ±40% for natural feel
    const jitter = baseDelay * (0.6 + Math.random() * 0.8);
    await page.waitForTimeout(jitter);
  }
}

/**
 * Readable pause between demo actions.
 */
async function pause(page: Page, seconds: number) {
  await page.waitForTimeout(seconds * 1000);
}

interface DemoFixtures {
  electronApp: ElectronApplication;
  appWindow: Page;
  typeNaturally: (
    selector: string,
    text: string,
    speed?: 'slow' | 'medium' | 'fast'
  ) => Promise<void>;
  pause: (seconds: number) => Promise<void>;
  nativeKey: (keyCode: number, modifiers?: string[]) => Promise<void>;
  nativeDoubleTapShift: (tapMs?: number, gapMs?: number) => void;
}

/**
 * Seeds a fake license so the app runs as licensed (unlimited workspaces).
 * Replicates the encryption from src/main/services/license.service.ts.
 */
export function seedLicense(sandboxDir: string) {
  // The same id the app derives on this platform, so the license decrypts.
  const machineId = getMachineId();

  const ENCRYPTION_SALT = 'komla-license-v1';
  const encKey = createHash('sha256')
    .update(machineId + ENCRYPTION_SALT)
    .digest();
  const iv = randomBytes(12);
  const licenseKey = 'KOMLA-DEMO-V1D0-TEST-KEY1';
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const encrypted = Buffer.concat([cipher.update(licenseKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedKey = Buffer.concat([iv, tag, encrypted]).toString('base64');

  fs.writeFileSync(
    path.join(sandboxDir, 'license.json'),
    JSON.stringify({
      licenseKey: encryptedKey,
      activatedAt: Date.now(),
      machineId,
      encrypted: true,
    })
  );
}

function launchApp() {
  return _electron.launch({
    args: [path.join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      KOMLA_DATA_DIR: SANDBOX_DIR,
      NODE_ENV: 'test',
      IS_DEMO: '1',
      // Point license server to nowhere so the fake license isn't invalidated
      KOMLA_API_URL: 'http://localhost:0',
    },
  });
}

/**
 * Seeds the sandbox with all demo data: license, config, projects, repos,
 * workspaces, and agent presets.
 */
// ⚡ renders as 2 columns; pad by visual width so the right wall aligns.
function buildBanner(text: string, interiorWidth: number): string[] {
  let visualWidth = 0;
  for (const ch of text) visualWidth += ch === '⚡' ? 2 : 1;
  const totalPad = Math.max(0, interiorWidth - visualWidth);
  const leftPad = Math.floor(totalPad / 2);
  const rightPad = totalPad - leftPad;
  const horizontal = '═'.repeat(interiorWidth);
  return [
    `╔${horizontal}╗`,
    `║${' '.repeat(leftPad)}${text}${' '.repeat(rightPad)}║`,
    `╚${horizontal}╝`,
  ];
}

function seedDemoSandbox() {
  // Wipe the previous run's contents but keep the directory itself.
  if (fs.existsSync(SANDBOX_DIR)) {
    for (const entry of fs.readdirSync(SANDBOX_DIR)) {
      fs.rmSync(path.join(SANDBOX_DIR, entry), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  }

  compileDoubleTapShiftHelper();
  seedLicense(SANDBOX_DIR);

  // Skip setup wizard and set dark theme.
  fs.writeFileSync(
    path.join(SANDBOX_DIR, 'config.json'),
    JSON.stringify({
      agentSetupComplete: true,
      usageTelemetryConsentAnswered: true,
      notificationPort: 52864,
      notificationsEnabled: true,
      autoNameBranches: false,
      agentLaunchDefaultPresetId: 'demo-claude-preset',
      // Disable live-follow auto-enable for new workspaces so accepted file
      // changes don't auto-navigate (workspace 3 permission demo should be clean).
      defaultLiveFollow: false,
      // Hide the lightbulb tips icon in the title bar.
      showTipsInToolbar: false,
    })
  );
  const settingsDir = path.join(SANDBOX_DIR, 'settings');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'theme.json'), JSON.stringify({ mode: 'dark' }));

  // Create a dummy git repo for the project
  const repoDir = path.join(SANDBOX_DIR, 'komla.dev');
  fs.mkdirSync(repoDir, { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Demo',
    GIT_AUTHOR_EMAIL: 'demo@komla.dev',
    GIT_COMMITTER_NAME: 'Demo',
    GIT_COMMITTER_EMAIL: 'demo@komla.dev',
  };

  // Seed files that double as marketing copy for the file viewer demo
  fs.mkdirSync(path.join(repoDir, 'docs'), { recursive: true });

  fs.writeFileSync(
    path.join(repoDir, 'docs', 'komla-runs-agents-in-parallel.md'),
    [
      '# Komla runs agents in parallel',
      '',
      'Every workspace is fully isolated - its own git branch,',
      'its own terminal, its own agent. Launch as many as you',
      'want and they all run at the same time.',
      '',
      'No conflicts. No waiting. Just parallel progress.',
      '',
      '→ komla.dev',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(repoDir, 'docs', 'every-workspace-is-isolated.md'),
    [
      '# Every workspace is isolated',
      '',
      'Each workspace gets its own git worktree, so agents',
      'never step on each other. Merge when ready.',
      '',
      '→ komla.dev',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(repoDir, 'docs', 'key-features.md'),
    [
      ...buildBanner('⚡ komla.dev ⚡', 47),
      'FEATURES:',
      '',
      '  ▸ Every isolated agent at a glance',
      '  ▸ Notifications when an agent needs input',
      '  ▸ Shortcuts that launch saved prompts & commands',
      '',
      'Run many agents. Stay in control.',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(repoDir, 'README.md'),
    [
      '# Komla',
      '',
      'Run AI coding agents in parallel. Each gets its own branch, terminal, and workspace.',
      '',
      'Works with Claude Code, Codex, Gemini CLI, or any CLI agent.',
      '',
      'komla.dev',
      '',
      'Read about more features at komla.dev',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(repoDir, 'komla-overview.md'),
    [
      '',
      ...buildBanner('⚡ komla.dev ⚡', 47).map((line) => `  ${line}`),
      '',
      '  ▸ Bring any CLI — Claude, Codex, OpenCode, BYO',
      '  ▸ Notifications when an agent needs input',
      '  ▸ Every isolated agent at a glance',
      '  ▸ Code editor + diff viewer baked in',
      '  ▸ Auto-bootstrap — deps, agents, scripts',
      '',
      '  Many agents. Total isolation. Stay in control.',
      '',
      '',
      '',
      '',
    ].join('\n')
  );

  // Seed a bland multi-page website for the MCP redesign demo
  fs.mkdirSync(path.join(repoDir, 'site'), { recursive: true });

  fs.writeFileSync(
    path.join(repoDir, 'site', 'index.html'),
    [
      '<!DOCTYPE html>',
      '<html><head><title>Acme Corp</title><link rel="stylesheet" href="styles.css"></head>',
      '<body>',
      '<nav><a href="index.html">Home</a> <a href="about.html">About</a> <a href="pricing.html">Pricing</a> <a href="contact.html">Contact</a></nav>',
      '<h1>Welcome to Acme Corp</h1>',
      '<p>We build software solutions.</p>',
      '</body></html>',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(repoDir, 'site', 'about.html'),
    [
      '<!DOCTYPE html>',
      '<html><head><title>About - Acme Corp</title><link rel="stylesheet" href="styles.css"></head>',
      '<body>',
      '<nav><a href="index.html">Home</a> <a href="about.html">About</a> <a href="pricing.html">Pricing</a> <a href="contact.html">Contact</a></nav>',
      '<h1>About Us</h1>',
      '<p>Founded in 2024. We are a small team.</p>',
      '</body></html>',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(repoDir, 'site', 'pricing.html'),
    [
      '<!DOCTYPE html>',
      '<html><head><title>Pricing - Acme Corp</title><link rel="stylesheet" href="styles.css"></head>',
      '<body>',
      '<nav><a href="index.html">Home</a> <a href="about.html">About</a> <a href="pricing.html">Pricing</a> <a href="contact.html">Contact</a></nav>',
      '<h1>Pricing</h1>',
      '<p>Free tier available. Pro plan $19/mo.</p>',
      '</body></html>',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(repoDir, 'site', 'contact.html'),
    [
      '<!DOCTYPE html>',
      '<html><head><title>Contact - Acme Corp</title><link rel="stylesheet" href="styles.css"></head>',
      '<body>',
      '<nav><a href="index.html">Home</a> <a href="about.html">About</a> <a href="pricing.html">Pricing</a> <a href="contact.html">Contact</a></nav>',
      '<h1>Contact</h1>',
      '<p>Email us at hello@acme.com</p>',
      '</body></html>',
    ].join('\n')
  );

  fs.writeFileSync(
    path.join(repoDir, 'site', 'styles.css'),
    [
      'body { font-family: sans-serif; margin: 2rem; }',
      'nav { margin-bottom: 1rem; }',
      'nav a { margin-right: 1rem; text-decoration: none; color: #333; }',
      'h1 { color: #222; }',
    ].join('\n')
  );

  // Add .claude/settings.local.json so Claude can commit and use MCP without prompts
  fs.mkdirSync(path.join(repoDir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, '.claude', 'settings.local.json'),
    JSON.stringify(
      {
        permissions: {
          allow: [
            'mcp__komla__spawn_agent_in_new_workspace',
            'Bash(git add:*)',
            'Bash(git commit:*)',
          ],
        },
      },
      null,
      2
    )
  );

  execSync(
    'git init -b main && git add -A && git add -f .claude/settings.local.json && git commit -m "Initial commit"',
    {
      cwd: repoDir,
      env: gitEnv,
    }
  );

  // Create managed bare repos for extra projects
  const reposDir = path.join(SANDBOX_DIR, 'repos');
  const worktreesDir = path.join(SANDBOX_DIR, 'worktrees');

  // abandoned-saas — managed bare repo
  const abandonedBareDir = path.join(reposDir, 'abandoned-saas', 'repo.git');
  fs.mkdirSync(abandonedBareDir, { recursive: true });
  execSync(`git init --bare -b main`, { cwd: abandonedBareDir, env: gitEnv });
  // Create a temp working tree to make an initial commit
  const abandonedTmpDir = path.join(SANDBOX_DIR, '_tmp-abandoned');
  fs.mkdirSync(abandonedTmpDir, { recursive: true });
  execSync(`git clone "${abandonedBareDir}" . && git commit --allow-empty -m "init" && git push`, {
    cwd: abandonedTmpDir,
    env: gitEnv,
  });
  fs.rmSync(abandonedTmpDir, { recursive: true });

  // weekend-project — managed bare repo
  const sideBareDir = path.join(reposDir, 'weekend-project', 'repo.git');
  fs.mkdirSync(sideBareDir, { recursive: true });
  execSync(`git init --bare -b main`, { cwd: sideBareDir, env: gitEnv });
  const sideTmpDir = path.join(SANDBOX_DIR, '_tmp-side');
  fs.mkdirSync(sideTmpDir, { recursive: true });
  execSync(`git clone "${sideBareDir}" . && git commit --allow-empty -m "init" && git push`, {
    cwd: sideTmpDir,
    env: gitEnv,
  });
  fs.rmSync(sideTmpDir, { recursive: true });

  // Pre-seed projects
  fs.writeFileSync(
    path.join(settingsDir, 'projects.json'),
    JSON.stringify({
      _version: 1,
      projects: [
        {
          id: 'demo-project',
          name: 'komla.dev',
          repositoryPath: repoDir,
          defaultBranchPrefix: '',
          createdAt: Date.now(),
          order: 0,
          managed: false,
          color: 'hsl(200, 75%, 50%)',
        },
        {
          id: 'abandoned-project',
          name: 'abandoned-saas',
          repositoryPath: abandonedBareDir,
          defaultBranchPrefix: 'feat/',
          createdAt: Date.now() - 86400000 * 30,
          order: 1,
          managed: true,
          color: 'hsl(340, 70%, 55%)',
        },
        {
          id: 'side-project',
          name: 'weekend-project',
          repositoryPath: sideBareDir,
          defaultBranchPrefix: 'try/',
          createdAt: Date.now() - 86400000 * 7,
          order: 2,
          managed: true,
          color: 'hsl(40, 90%, 50%)',
        },
      ],
    })
  );

  // Create real git worktrees off the managed bare repos. Empty mkdir'd
  // directories aren't real worktrees, so agents cd-ing in would error with
  // "not a git repository" — this gives them a valid checkout.
  const abandonedWtBase = path.join(worktreesDir, 'abandoned-saas');
  const sideWtBase = path.join(worktreesDir, 'weekend-project');
  fs.mkdirSync(abandonedWtBase, { recursive: true });
  fs.mkdirSync(sideWtBase, { recursive: true });

  function addWorktree(bareDir: string, wtPath: string, branchName: string) {
    execSync(`git worktree add -b ${branchName} "${wtPath}"`, { cwd: bareDir, env: gitEnv });
  }
  addWorktree(
    abandonedBareDir,
    path.join(abandonedWtBase, 'add-stripe-billing'),
    'feat/add-stripe-billing'
  );
  addWorktree(
    abandonedBareDir,
    path.join(abandonedWtBase, 'fix-auth-redirect-loop'),
    'feat/fix-auth-redirect-loop'
  );
  addWorktree(
    abandonedBareDir,
    path.join(abandonedWtBase, 'maybe-pivot-to-ai'),
    'feat/maybe-pivot-to-ai'
  );
  addWorktree(sideBareDir, path.join(sideWtBase, 'raytracer-in-rust'), 'try/raytracer-in-rust');
  addWorktree(sideBareDir, path.join(sideWtBase, 'ascii-art-generator'), 'try/ascii-art-generator');

  // Seed a fake Claude Code conversation in the fix-auth-redirect-loop workspace
  // so `claude --continue` picks it up when the workspace is opened
  const authWsDir = fs.realpathSync(path.join(abandonedWtBase, 'fix-auth-redirect-loop'));
  // Claude Code's project-dir encoding replaces both '/' and '.' with '-' —
  // e.g. /Users/x/.komla-demo/y becomes -Users-x--komla-demo-y. Encoding only
  // '/' here would put the seed at the wrong dir name and `claude --continue`
  // wouldn't find it.
  const claudeProjectDir = path.join(
    homedir(),
    '.claude',
    'projects',
    authWsDir.replace(/[/.]/g, '-')
  );
  fs.mkdirSync(claudeProjectDir, { recursive: true });
  const sessionId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const sessionFile = path.join(claudeProjectDir, `${sessionId}.jsonl`);
  const userUuid = 'aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa';
  const assistantUuid = 'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb';
  const ts = new Date(Date.now() - 86400000 * 20).toISOString();
  const commonFields = {
    cwd: authWsDir,
    entrypoint: 'cli',
    userType: 'external',
    sessionId,
    version: '2.1.87',
    gitBranch: 'feat/fix-auth-redirect-loop',
  };
  const conversationLines = [
    JSON.stringify({
      type: 'file-history-snapshot',
      messageId: userUuid,
      snapshot: { messageId: userUuid, trackedFileBackups: {}, timestamp: ts },
      isSnapshotUpdate: false,
    }),
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      promptId: 'demo-prompt-1',
      permissionMode: 'default',
      message: {
        role: 'user',
        content: 'Fix the auth redirect loop - users get stuck in an infinite redirect after login',
      },
      uuid: userUuid,
      timestamp: ts,
      ...commonFields,
    }),
    JSON.stringify({
      parentUuid: userUuid,
      isSidechain: false,
      type: 'assistant',
      uuid: assistantUuid,
      timestamp: ts,
      message: {
        id: 'msg-demo',
        model: 'claude-sonnet-4-20250514',
        role: 'assistant',
        stop_reason: 'end_turn',
        type: 'message',
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [
          {
            type: 'text',
            text: [
              'I found the issue! The OAuth callback handler in `src/auth/callback.ts` was redirecting to `/login` when the token exchange failed, but `/login` itself redirects to the OAuth provider if a session exists - creating an infinite loop.',
              '',
              "Here's what I fixed:",
              '1. **`src/auth/callback.ts`** - redirect to `/login?error=token_exchange_failed` instead of bare `/login`',
              '2. **`src/auth/login.ts`** - check for `error` query param before auto-redirecting to OAuth',
              '3. **`src/middleware/session.ts`** - clear the stale session cookie on auth errors',
              '',
              'The redirect loop was happening because the stale session cookie made `/login` think the user was already authenticated, so it sent them back to OAuth, which failed again, which redirected to `/login`, and so on.',
              '',
              'All 3 files updated and tests passing. Want me to commit?',
              '',
              "P.S. This conversation was from 20 days ago. Glad you came back - I was starting to worry you'd abandoned me like that SaaS idea.",
            ].join('\n'),
          },
        ],
      },
      ...commonFields,
    }),
  ];
  fs.writeFileSync(sessionFile, conversationLines.join('\n') + '\n');

  // Pre-seed some workspaces in the Trash for the extra projects
  fs.writeFileSync(
    path.join(SANDBOX_DIR, 'workspaces.json'),
    JSON.stringify([
      {
        id: 'abandoned-ws-1',
        name: 'add-stripe-billing',
        customName: 'add-stripe-billing',
        workingDirectory: path.join(abandonedWtBase, 'add-stripe-billing'),
        branchName: 'feat/add-stripe-billing',
        isWorktree: true,
        projectId: 'abandoned-project',
        windowId: null,
        categoryId: null,
        terminals: [],
        createdAt: Date.now() - 86400000 * 25,
        lastActivityAt: Date.now() - 86400000 * 25,
        order: 0,
        status: 'trashed',
      },
      {
        id: 'abandoned-ws-2',
        name: 'fix-auth-redirect-loop',
        customName: 'fix-auth-redirect-loop',
        customDescription:
          'Search the old codebase for memory leaks - worked through several workspaces to narrow it down',
        workingDirectory: path.join(abandonedWtBase, 'fix-auth-redirect-loop'),
        branchName: 'feat/fix-auth-redirect-loop',
        isWorktree: true,
        projectId: 'abandoned-project',
        windowId: null,
        categoryId: null,
        terminals: [],
        createdAt: Date.now() - 86400000 * 20,
        lastActivityAt: Date.now() - 86400000 * 20,
        order: 1,
        status: 'trashed',
      },
      {
        id: 'abandoned-ws-3',
        name: 'maybe-pivot-to-ai',
        customName: 'maybe-pivot-to-ai',
        workingDirectory: path.join(abandonedWtBase, 'maybe-pivot-to-ai'),
        branchName: 'feat/maybe-pivot-to-ai',
        isWorktree: true,
        projectId: 'abandoned-project',
        windowId: null,
        categoryId: null,
        terminals: [],
        createdAt: Date.now() - 86400000 * 15,
        lastActivityAt: Date.now() - 86400000 * 15,
        order: 2,
        status: 'trashed',
      },
      {
        id: 'side-ws-1',
        name: 'raytracer-in-rust',
        customName: 'raytracer-in-rust',
        customDescription:
          'Weekend experiment - building a raytracer from scratch to learn Rust. Got reflections working!',
        workingDirectory: path.join(sideWtBase, 'raytracer-in-rust'),
        branchName: 'try/raytracer-in-rust',
        isWorktree: true,
        projectId: 'side-project',
        windowId: null,
        categoryId: null,
        terminals: [],
        createdAt: Date.now() - 86400000 * 5,
        lastActivityAt: Date.now() - 86400000 * 5,
        order: 0,
        status: 'trashed',
      },
      {
        id: 'side-ws-2',
        name: 'ascii-art-generator',
        customName: 'ascii-art-generator',
        workingDirectory: path.join(sideWtBase, 'ascii-art-generator'),
        branchName: 'try/ascii-art-generator',
        isWorktree: true,
        projectId: 'side-project',
        windowId: null,
        categoryId: null,
        terminals: [],
        createdAt: Date.now() - 86400000 * 3,
        lastActivityAt: Date.now() - 86400000 * 3,
        order: 1,
        status: 'trashed',
      },
    ])
  );

  // Pre-seed agent presets (Claude Code + Codex)
  const claudePresetId = 'demo-claude-preset';
  const codexPresetId = 'demo-codex-preset';
  fs.writeFileSync(
    path.join(settingsDir, 'agent-presets.json'),
    JSON.stringify({
      presets: [
        {
          id: claudePresetId,
          name: 'Claude Code',
          openCommand: 'claude',
          continueCommand: 'claude --continue',
          promptCommand: 'claude {{prompt}}',
          utilityCommand: 'claude -p --effort low',
          launchModes: [
            {
              id: 'dangerously-skip-mode',
              name: 'Dangerously skip permissions',
              command: 'claude --dangerously-skip-permissions {{prompt}}',
              color: 'red',
            },
            {
              id: 'plan-mode',
              name: 'Plan',
              command: 'claude --permission-mode plan {{prompt}}',
              color: 'blue',
            },
            {
              id: 'accept-edits-mode',
              name: 'Accept edits',
              command: 'claude --permission-mode acceptEdits {{prompt}}',
              color: 'purple',
            },
            {
              id: 'auto-mode',
              name: 'Auto',
              command: 'claude --permission-mode auto {{prompt}}',
              color: 'orange',
            },
          ],
          isBuiltin: true,
        },
        {
          id: codexPresetId,
          name: 'Codex',
          openCommand: 'codex',
          continueCommand: 'codex resume --last',
          promptCommand: 'codex {{prompt}}',
          utilityCommand: 'codex exec --model gpt-5.4-mini -c model_reasoning_effort="none"',
          launchModes: [
            {
              id: 'codex-read-only',
              name: 'Read only',
              command: 'codex --sandbox read-only {{prompt}}',
              color: 'blue',
            },
            {
              id: 'codex-full-auto',
              name: 'Full auto',
              command: 'codex --sandbox workspace-write --ask-for-approval never {{prompt}}',
              color: 'purple',
            },
            {
              id: 'codex-dangerously-skip',
              name: 'Dangerously skip permissions',
              command: 'codex --dangerously-bypass-approvals-and-sandbox {{prompt}}',
              color: 'red',
            },
          ],
          isBuiltin: true,
        },
      ],
      activePresets: [
        { presetId: claudePresetId, lastUsedAt: Date.now() },
        { presetId: codexPresetId, lastUsedAt: Date.now() - 1000 },
      ],
    })
  );
}

/**
 * Demo fixture — empty app (no workspaces), 16:9 windowed (1600x900), with
 * video recording. Pre-seeds config so the setup wizard is skipped, but no
 * workspaces exist.
 */
export const demoTest = base.extend<DemoFixtures>({
  electronApp: [
    async ({}, provide) => {
      seedDemoSandbox();

      const app = await launchApp();
      await provide(app);
      await app.close();
    },
    { scope: 'test' },
  ],

  appWindow: [
    async ({ electronApp }, provide) => {
      const window = await firstRendererWindow(electronApp);

      // Largest window that fits in the work area at the chosen aspect ratio.
      // Set DEMO_ASPECT to "21:9" (cinematic desktop, default), "16:9" (classic
      // desktop), or "9:16" (mobile portrait). Capture at the resulting size
      // and you stay confined to the screen — no window-clipping in the recording.
      const [aspectW, aspectH] = (process.env.DEMO_ASPECT ?? '21:9')
        .split(':')
        .map((n) => Number(n));
      await electronApp.evaluate(
        ({ BrowserWindow, screen }, { aspectW, aspectH }) => {
          const win = BrowserWindow.getAllWindows()[0];
          const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
          const ratio = aspectW / aspectH;
          // Try filling width first; if the resulting height overflows, fill height instead.
          let w = width;
          let h = Math.round(width / ratio);
          if (h > height) {
            h = height;
            w = Math.round(height * ratio);
          }
          win.setFullScreen(false);
          win.setBounds({
            x: x + Math.max(0, Math.round((width - w) / 2)),
            y: y + Math.max(0, Math.round((height - h) / 2)),
            width: w,
            height: h,
          });
        },
        { aspectW, aspectH }
      );
      await window.waitForTimeout(500);

      await provide(window);
    },
    { scope: 'test' },
  ],

  typeNaturally: [
    async ({ appWindow }, provide) => {
      await provide((selector: string, text: string, speed?: 'slow' | 'medium' | 'fast') =>
        typeNaturally(appWindow, selector, text, speed)
      );
    },
    { scope: 'test' },
  ],

  pause: [
    async ({ appWindow }, provide) => {
      await provide((seconds: number) => pause(appWindow, seconds));
    },
    { scope: 'test' },
  ],

  nativeKey: [
    async ({}, provide) => {
      await provide((keyCode: number, modifiers?: string[]) => nativeKeyPress(keyCode, modifiers));
    },
    { scope: 'test' },
  ],

  nativeDoubleTapShift: [
    async ({}, provide) => {
      await provide((tapMs?: number, gapMs?: number) => nativeDoubleTapShift(tapMs, gapMs));
    },
    { scope: 'test' },
  ],
});

/**
 * Half-window demo fixture — same seeded data as demoTest, but positioned
 * in the left half of the screen instead of fullscreen. Useful for recording
 * commercial footage where the app occupies half the display.
 */
export const demoTestHalfWindow = demoTest.extend<DemoFixtures>({
  appWindow: [
    async ({ electronApp }, provide) => {
      const window = await firstRendererWindow(electronApp);

      // Position in the left half of the screen instead of fullscreen
      // Use workArea (not workAreaSize) to respect menu bar/dock offsets
      await electronApp.evaluate(({ BrowserWindow, screen }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
        win.setFullScreen(false);
        win.setBounds({ x, y, width: Math.round(width / 2), height });
      });
      await window.waitForTimeout(500);

      await provide(window);
    },
    { scope: 'test' },
  ],
});

export { expect } from '@playwright/test';
