import fs from 'fs';
import path from 'path';

import { IPC } from '../src/shared/constants/ipc-channels';

import { SANDBOX_DIR, test, expect } from './electron-app';

import type { ElectronApplication, Page } from '@playwright/test';

const CODEX_HOOKS_PATH = path.join(SANDBOX_DIR, 'codex', 'hooks.json');

// Answers agent detection with these template names instead of probing the host's shell,
// and keeps Codex setup from touching the host's Codex settings. The wizard looks for
// agents as it mounts, so the page reloads to ask again.
async function stubOnboarding(electronApp: ElectronApplication, page: Page, agents: string[]) {
  await expect(page.getByText('Add Your First Project')).toBeVisible();
  await electronApp.evaluate(
    ({ ipcMain }, { channels, agents, codexHooksPath }) => {
      const codex = { notifications: false };
      Object.assign(globalThis, { e2eCodexSetup: codex });
      for (const channel of Object.values(channels)) ipcMain.removeHandler(channel);
      ipcMain.handle(channels.detect, () => agents);
      ipcMain.handle(channels.details, () => ({
        isConfigured: codex.notifications,
        command: '',
        configJson: '{"hooks":{}}',
        settingsPath: codexHooksPath,
        port: 0,
        hasConflict: false,
        canAutoConfigure: true,
        conflictMessage: null,
      }));
      ipcMain.handle(channels.enable, () => {
        codex.notifications = true;
      });
    },
    {
      channels: {
        detect: IPC.PRESET_DETECT_INSTALLED,
        details: IPC.CODEX_NOTIFICATIONS_GET_HOOK_DETAILS,
        enable: IPC.CODEX_NOTIFICATIONS_ENABLE,
      },
      agents,
      codexHooksPath: CODEX_HOOKS_PATH,
    }
  );
  await page.reload();
  await expect(page.getByText('Add Your First Project')).toBeVisible();
}

function savedPresetNames(): string[] {
  const saved = JSON.parse(
    fs.readFileSync(path.join(SANDBOX_DIR, 'settings', 'agent-presets.json'), 'utf8')
  ) as {
    presets: { id: string; name: string }[];
    activePresets: { presetId: string; lastUsedAt: number }[];
  };
  const names = new Map(saved.presets.map((preset) => [preset.id, preset.name]));
  return [...saved.activePresets]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .map((entry) => names.get(entry.presetId) ?? '');
}

// Continues from where agents run to the usage analytics question, and declines.
async function answerAnalytics(page: Page) {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Help improve Komla?' })).toBeVisible();
  await page.getByRole('button', { name: /^Don’t share/ }).click();
}

// Leaves the Connect step and finishes setup with agents kept on this computer.
async function startWorkingHere(page: Page) {
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Where should agents run?' })).toBeVisible();
  await answerAnalytics(page);
  await page.getByRole('button', { name: 'Start working' }).click();
}

test('onboarding adds the agents it finds and connects each one on request', async ({
  appWindow,
  electronApp,
}, testInfo) => {
  await stubOnboarding(electronApp, appWindow, ['Codex', 'Cursor CLI']);
  await appWindow.getByRole('button', { name: 'Skip for now' }).click();

  await expect(appWindow.getByRole('heading', { name: 'Choose your agents' })).toBeVisible();
  const installed = appWindow.getByRole('list', { name: 'Installed agents' });
  await expect(installed.getByRole('checkbox', { name: 'Codex' })).toBeChecked();
  await expect(installed.getByRole('checkbox', { name: 'Cursor CLI' })).toBeChecked();
  await expect(
    appWindow.getByRole('list', { name: 'Not installed' }).getByText('Claude Code')
  ).toBeVisible();
  await appWindow.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('choose-agents.png'),
  });
  await appWindow.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(appWindow.getByRole('heading', { name: 'Connect your agents' })).toBeVisible();
  await appWindow.getByRole('button', { name: 'What changes?' }).click();
  await expect(appWindow.getByText(CODEX_HOOKS_PATH)).toBeVisible();
  await appWindow.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('connect-agents.png'),
  });

  const codexSetup = () =>
    electronApp.evaluate(() => (globalThis as { e2eCodexSetup?: unknown }).e2eCodexSetup);
  await appWindow.getByRole('switch', { name: 'Codex Hooks' }).click();
  await expect(appWindow.getByRole('switch', { name: 'Codex Hooks' })).toBeChecked();
  expect(await codexSetup()).toEqual({ notifications: true });

  await startWorkingHere(appWindow);
  await expect(appWindow.getByText('Welcome to Komla')).toHaveCount(0);
  await expect.poll(savedPresetNames).toEqual(['Codex', 'Cursor CLI']);
});

test('onboarding leaves self-setup to Tips', async ({ appWindow, electronApp }) => {
  await stubOnboarding(electronApp, appWindow, ['Codex', 'Cursor CLI']);
  await appWindow.getByRole('button', { name: 'Skip for now' }).click();
  await appWindow.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(appWindow.getByRole('note', { name: 'Cursor CLI can set itself up' })).toContainText(
    'open Tips'
  );
  await expect(appWindow.getByRole('button', { name: /^Set up/ })).toHaveCount(0);
  await startWorkingHere(appWindow);

  await expect(appWindow.getByText('Welcome to Komla')).toHaveCount(0);
  await appWindow.getByRole('button', { name: 'Tips' }).click();
  await expect(appWindow.getByText('Integrate Cursor CLI with Komla')).toBeVisible();
});

test('onboarding adds only the agents left ticked', async ({ appWindow, electronApp }) => {
  await stubOnboarding(electronApp, appWindow, ['Codex', 'Cursor CLI']);
  await appWindow.getByRole('button', { name: 'Skip for now' }).click();
  await appWindow.getByRole('checkbox', { name: 'Codex' }).uncheck();
  await appWindow.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(appWindow.getByRole('heading', { name: 'Connect your agent' })).toBeVisible();
  await expect(appWindow.getByRole('switch', { name: 'Codex Hooks' })).toHaveCount(0);
  await startWorkingHere(appWindow);

  await expect(appWindow.getByText('Welcome to Komla')).toHaveCount(0);
  await expect.poll(savedPresetNames).toEqual(['Cursor CLI']);
  expect(
    await electronApp.evaluate(() => (globalThis as { e2eCodexSetup?: unknown }).e2eCodexSetup)
  ).toEqual({ notifications: false });
});

test('onboarding offers the agent picker when it finds no agents', async ({
  appWindow,
  electronApp,
}) => {
  await stubOnboarding(electronApp, appWindow, []);
  await appWindow.getByRole('button', { name: 'Skip for now' }).click();

  await expect(appWindow.getByText('Choose Your AI Agent')).toBeVisible();
  await expect(appWindow.getByText(/Komla didn’t find an agent CLI/)).toBeVisible();
  await expect(appWindow.getByRole('button', { name: 'Check again' })).toBeVisible();
  await appWindow.getByRole('button', { name: /^Cursor CLI/ }).click();
  await appWindow.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(appWindow.getByRole('heading', { name: 'Connect your agent' })).toBeVisible();
  await expect(appWindow.getByRole('note', { name: 'Cursor CLI can set itself up' })).toBeVisible();
  await appWindow.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(appWindow.getByRole('heading', { name: 'Where should agents run?' })).toBeVisible();
  await appWindow.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(appWindow.getByRole('heading', { name: 'Connect your agent' })).toBeVisible();
  await appWindow.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(appWindow.getByText('Choose Your AI Agent')).toBeVisible();
});

test('onboarding opens Add SSH host once setup is done when agents run over SSH', async ({
  appWindow,
  electronApp,
}, testInfo) => {
  await stubOnboarding(electronApp, appWindow, ['Codex']);
  await appWindow.getByRole('button', { name: 'Skip for now' }).click();
  await appWindow.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(appWindow.getByRole('heading', { name: 'Connect your agent' })).toBeVisible();
  await appWindow.getByRole('button', { name: 'Continue', exact: true }).click();
  await appWindow.getByRole('button', { name: /A machine I can SSH into/ }).click();
  await expect(appWindow.getByRole('link', { name: /No machine yet/ })).toBeVisible();
  await appWindow.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('machine-step.png'),
  });
  await answerAnalytics(appWindow);
  await appWindow.getByRole('button', { name: 'Start working' }).click();

  await expect(appWindow.getByText('Welcome to Komla')).toHaveCount(0);
  await expect(
    appWindow.getByRole('dialog').getByRole('heading', { name: 'Add SSH host' })
  ).toBeVisible();
  await appWindow.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('add-ssh-host.png'),
  });
});
