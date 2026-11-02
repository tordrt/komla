import { connectKomla } from '../packages/sdk/src/index';
import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

// The SDK reaches the running app as the CLI does, through the port file in its data folder
// (ADR 0008), and its calls are the Komla Operations the CLI sends.
const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'sdk/' });
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
      komla.workspace.tag({ tag: 'CI running', spinner: true }, { workspace: workspaceId })
    ).resolves.toEqual({
      tag: { workspaceId, tag: 'CI running', changed: true, added: true },
    });
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
            kind: workspace?.attention?.kind,
            title: workspace?.attention?.title,
            badge: workspace?.attention?.badge,
          };
        }, workspaceId)
      )
      .toEqual({ tag: 'CI running', kind: 'error', title: 'CI failed', badge: 'CI' });
    await expect(appWindow.getByText('CI', { exact: true }).first()).toBeVisible();
    await appWindow.screenshot({ path: test.info().outputPath('sdk-notification.png') });

    // The client didn't declare agent.launch.workspace, so it refuses before reaching Komla.
    await expect(
      komla.execute({ type: 'agent.launch', destination: 'workspace', prompt: 'x' } as never)
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_DECLARED' });
  });
});
