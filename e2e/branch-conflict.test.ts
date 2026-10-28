import { test as base, expect, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'branch-conflict/' });
    await provide();
  },
});

test.describe('Branch conflict guard', () => {
  test.describe.configure({ timeout: 60_000 });

  test('rejects creating a second workspace with a duplicate branch name', async ({
    appWindow,
  }) => {
    const branchName = 'branch-conflict/dup';

    const first = await appWindow.evaluate(
      async (name) =>
        window.api.createWorkspace({
          mode: 'worktree',
          projectId: 'e2e-project',
          branchName: name,
        }),
      branchName
    );
    expect(first).not.toHaveProperty('__workspaceCreateError');

    // Wait until W1 finishes provisioning (worktree on disk, no provisionError).
    await expect
      .poll(async () =>
        appWindow.evaluate(async (name) => {
          const ws = (await window.api.getWorkspaces()).find((w) => w.branchName === name);
          return ws
            ? {
                found: true,
                provisioning: ws.provisioning ?? false,
                provisionError: ws.provisionError ?? null,
              }
            : { found: false };
        }, branchName)
      )
      .toEqual({ found: true, provisioning: false, provisionError: null });

    // Second create with the same branchName must be rejected as a value, not thrown.
    const second = await appWindow.evaluate(
      async (name) =>
        window.api.createWorkspace({
          mode: 'worktree',
          projectId: 'e2e-project',
          branchName: name,
        }),
      branchName
    );
    expect(second).toMatchObject({
      __workspaceCreateError: true,
      message: expect.stringContaining('already open in workspace'),
    });

    // No partial creation: still exactly one workspace with that branchName.
    const matching = await appWindow.evaluate(
      async (name) =>
        (await window.api.getWorkspaces()).filter((w) => w.branchName === name).length,
      branchName
    );
    expect(matching).toBe(1);
  });
});
