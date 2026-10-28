import { test as base, expect, seedDefaultProject } from './electron-app';

const FREE_LIMIT = 4;

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'limit/' });
    await provide();
  },
});

test.describe('License free-tier gate', () => {
  test.describe.configure({ timeout: 90_000 });

  // The free limit counts SSH workspaces only, which e2e has no host for; unit tests cover those.
  test(`runs more than ${FREE_LIMIT} local workspaces without a license`, async ({ appWindow }) => {
    await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
      timeout: 15_000,
    });

    for (let i = 1; i <= FREE_LIMIT + 1; i++) {
      const result = await appWindow.evaluate(
        async (branchName) =>
          window.api.createWorkspace({
            mode: 'worktree',
            projectId: 'e2e-project',
            branchName,
          }),
        `limit/ws-${i}`
      );
      // Workspace objects have an id; error results have __workspaceCreateError
      expect(result).not.toHaveProperty('__workspaceCreateError');
    }

    await expect
      .poll(async () => appWindow.evaluate(async () => (await window.api.getWorkspaces()).length))
      .toBe(FREE_LIMIT + 1);
    await expect
      .poll(async () =>
        appWindow.evaluate(async () => (await window.api.getWorkspaceQuota()).count)
      )
      .toBe(0);
  });
});
