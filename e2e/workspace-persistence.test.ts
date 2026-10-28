import { test as base, expect, launchApp, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'persist/' });
    await provide();
  },
});

test.describe('Workspace persistence', () => {
  test.describe.configure({ timeout: 90_000 });

  test('workspace list survives an app restart', async ({ seedSandbox: _seedSandbox }) => {
    // First launch: create two workspaces and wait for both to finish provisioning.
    // The startup cleanup in workspace.service.ts deletes any workspace still flagged
    // `provisioning: true` at boot, so closing mid-provision would silently lose them.
    {
      const { app, window } = await launchApp();
      try {
        const alpha = await window.evaluate(async () =>
          window.api.createWorkspace({
            mode: 'worktree',
            projectId: 'e2e-project',
            branchName: 'persist/alpha',
            customName: 'Alpha',
          })
        );
        expect(alpha).not.toHaveProperty('__workspaceCreateError');

        const beta = await window.evaluate(async () =>
          window.api.createWorkspace({
            mode: 'worktree',
            projectId: 'e2e-project',
            branchName: 'persist/beta',
            customName: 'Beta',
          })
        );
        expect(beta).not.toHaveProperty('__workspaceCreateError');

        await expect
          .poll(
            async () =>
              window.evaluate(async () =>
                (await window.api.getWorkspaces()).map((w) => ({
                  branchName: w.branchName,
                  provisioning: w.provisioning ?? false,
                  provisionError: w.provisionError ?? null,
                }))
              ),
            { timeout: 30_000 }
          )
          .toEqual([
            { branchName: 'persist/alpha', provisioning: false, provisionError: null },
            { branchName: 'persist/beta', provisioning: false, provisionError: null },
          ]);
      } finally {
        await app.close();
      }
    }

    // Second launch: same sandbox, expect both workspaces to reappear in the same
    // order with their branchName and customName intact.
    {
      const { app, window } = await launchApp();
      try {
        const workspaces = await window.evaluate(async () =>
          (await window.api.getWorkspaces()).map((w) => ({
            branchName: w.branchName,
            customName: w.customName,
          }))
        );
        expect(workspaces).toEqual([
          { branchName: 'persist/alpha', customName: 'Alpha' },
          { branchName: 'persist/beta', customName: 'Beta' },
        ]);
      } finally {
        await app.close();
      }
    }
  });
});
