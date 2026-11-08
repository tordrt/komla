import fs from 'node:fs';
import path from 'node:path';

import { connectKomla } from '../packages/sdk/src/index';
import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

// The SDK reaches the running app as the CLI does, through the port file in its data folder
// (ADR 0008), and its calls are the Komla Operations the CLI sends.
const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'sdk/' });
    // An agent, so New Workspace shows the prompt a draft fills in.
    fs.mkdirSync(path.join(SANDBOX_DIR, 'settings'), { recursive: true });
    fs.writeFileSync(
      path.join(SANDBOX_DIR, 'settings', 'agent-presets.json'),
      JSON.stringify({
        presets: [
          {
            id: 'e2e-agent',
            name: 'Helper',
            openCommand: 'sh',
            continueCommand: 'sh',
            promptCommand: 'sh -c true {{prompt}}',
            launchModes: [
              { id: 'careful', name: 'Careful', arguments: '--careful' },
              { id: 'quick', name: 'Quick', arguments: '--quick' },
            ],
            isBuiltin: false,
          },
        ],
        activePresets: [
          { presetId: 'e2e-agent', lastUsedAt: Date.now(), lastLaunchModeId: 'careful' },
        ],
      })
    );
    await provide();
  },
});

test.describe('Komla SDK', () => {
  test('lists, tags and notifies a workspace in the running app', async ({ appWindow }) => {
    const created = await appWindow.evaluate(() =>
      window.api.createWorkspace({
        mode: 'worktree',
        projectId: 'e2e-project',
        branchName: 'sdk/ci',
        windowId: new URLSearchParams(window.location.search).get('windowId') ?? undefined,
      })
    );
    expect(created).not.toHaveProperty('__workspaceCreateError');
    const workspaceId = (created as { id: string }).id;

    const komla = connectKomla({
      env: { KOMLA_DATA_DIR: SANDBOX_DIR },
      cwd: SANDBOX_DIR,
      capabilities: ['workspace.tag'],
    });

    await expect
      .poll(async () =>
        (await komla.workspace.list()).workspaces.find((workspace) => workspace.id === workspaceId)
      )
      .toMatchObject({ id: workspaceId, branch: 'sdk/ci', agentActive: false });

    await expect(
      komla.workspace.tag({ tag: 'Blocked' }, { workspace: workspaceId })
    ).resolves.toEqual({ tag: { workspaceId, tag: 'Blocked', changed: true, added: false } });
    await expect(
      komla.workspace.progress({ label: 'CI running', tone: 'info' }, { workspace: workspaceId })
    ).resolves.toEqual({ progress: { workspaceId, label: 'CI running', changed: true } });
    // It spins in the tag's place on the card until the notification below takes that place.
    const progress = appWindow.locator('[data-workspace-progress]').filter({ hasText: 'CI running' });
    await expect(progress.first()).toBeVisible();
    await expect(progress.first().locator('.activity-glyph')).toHaveCount(1);
    await appWindow.screenshot({ path: test.info().outputPath('sdk-progress.png') });
    await expect(
      komla.workspace.notify(
        { title: 'CI failed', badge: 'CI', body: '3 tests failed.', kind: 'error' },
        { workspace: workspaceId }
      )
    ).resolves.toEqual({ notification: { workspaceId } });

    await expect
      .poll(async () =>
        appWindow.evaluate(async (id) => {
          const workspace = (await window.api.getWorkspaces()).find((w) => w.id === id);
          return {
            tag: workspace?.tag,
            progress: workspace?.progress?.label,
            kind: workspace?.attention?.kind,
            title: workspace?.attention?.title,
            badge: workspace?.attention?.badge,
          };
        }, workspaceId)
      )
      .toEqual({
        tag: 'Blocked',
        progress: 'CI running',
        kind: 'error',
        title: 'CI failed',
        badge: 'CI',
      });
    await expect(appWindow.getByText('CI', { exact: true }).first()).toBeVisible();
    await appWindow.screenshot({ path: test.info().outputPath('sdk-notification.png') });

    // The client didn't declare agent.launch.workspace, so it refuses before reaching Komla.
    await expect(
      komla.execute({ type: 'agent.launch', destination: 'workspace', prompt: 'x' } as never)
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_DECLARED' });
  });

  test('drafts a launch in New Workspace, starting nothing', async ({ appWindow }) => {
    const created = await appWindow.evaluate(() =>
      window.api.createWorkspace({
        mode: 'worktree',
        projectId: 'e2e-project',
        branchName: 'sdk/draft',
        windowId: new URLSearchParams(window.location.search).get('windowId') ?? undefined,
      })
    );
    expect(created).not.toHaveProperty('__workspaceCreateError');
    const workspaceId = (created as { id: string }).id;
    const workspaceCount = async () =>
      appWindow.evaluate(async () => (await window.api.getWorkspaces()).length);
    const before = await workspaceCount();

    const komla = connectKomla({
      env: { KOMLA_DATA_DIR: SANDBOX_DIR },
      cwd: SANDBOX_DIR,
      capabilities: ['agent.launch.workspace'],
    });
    await expect(
      komla.agent.launch(
        {
          destination: 'workspace',
          prompt: 'Fix the flaky login test',
          preset: 'Helper',
          mode: 'Quick',
          draft: true,
        },
        { workspace: workspaceId }
      )
    ).resolves.toMatchObject({
      state: 'drafted',
      destination: { kind: 'draft', projectId: 'e2e-project' },
    });

    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await expect(dialog.getByPlaceholder(/what should the agent work on/i)).toHaveValue(
      'Fix the flaky login test'
    );
    // In the mode it asked for, not the one the agent last started in.
    await expect(dialog.getByRole('button', { name: 'Helper Quick' })).toBeVisible();
    await dialog.screenshot({ path: test.info().outputPath('sdk-draft.png') });
    if (process.env.SIDEBAR_PANELS_SCREENSHOT_DIR) {
      await dialog.screenshot({
        path: `${process.env.SIDEBAR_PANELS_SCREENSHOT_DIR}/new-workspace-draft.png`,
      });
    }
    expect(await workspaceCount()).toBe(before);
  });
});
