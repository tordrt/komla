import { test as base, expect, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({
      branchPrefix: 'diff/',
      initialFile: { name: 'README.md', content: 'original content\n' },
    });
    await provide();
  },
});

test.describe('Git diff and discard', () => {
  test.describe.configure({ timeout: 90_000 });

  test('detects file edits and reverts them via discardAllChanges', async ({ appWindow }) => {
    await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
      timeout: 15_000,
    });

    const created = await appWindow.evaluate(async () =>
      window.api.createWorkspace({
        mode: 'worktree',
        projectId: 'e2e-project',
        branchName: 'diff/edit-readme',
      })
    );
    expect(created).not.toHaveProperty('__workspaceCreateError');
    const workingDirectory = (created as { workingDirectory: string }).workingDirectory;
    expect(workingDirectory).toBeTruthy();

    // Baseline: clean tree.
    const cleanDiff = await appWindow.evaluate(
      async (cwd) => window.api.getDiff(cwd),
      workingDirectory
    );
    expect(cleanDiff.files).toEqual([]);
    expect(cleanDiff.summary.filesChanged).toBe(0);

    // Modify README.md through the renderer IPC surface.
    await appWindow.evaluate(
      async ([cwd, content]) => window.api.writeFile(cwd, 'README.md', content),
      [workingDirectory, 'original content\nnew line from e2e\n'] as const
    );

    // The diff must now report a single modified file with one added line.
    await expect
      .poll(async () =>
        appWindow.evaluate(async (cwd) => {
          const diff = await window.api.getDiff(cwd);
          return {
            count: diff.files.length,
            first: diff.files[0]
              ? { path: diff.files[0].path, status: diff.files[0].status }
              : null,
            additions: diff.summary.additions,
          };
        }, workingDirectory)
      )
      .toEqual({
        count: 1,
        first: { path: 'README.md', status: 'modified' },
        additions: 1,
      });

    // Discard and verify the working tree returns to clean.
    const discardResult = await appWindow.evaluate(
      async (cwd) => window.api.discardAllChanges(cwd),
      workingDirectory
    );
    expect(discardResult).toEqual({ success: true, message: 'Discarded all changes' });

    const afterDiscard = await appWindow.evaluate(
      async (cwd) => window.api.getDiff(cwd),
      workingDirectory
    );
    expect(afterDiscard.files).toEqual([]);
    expect(afterDiscard.summary.filesChanged).toBe(0);

    // And the file content really is back to the committed version.
    const restored = await appWindow.evaluate(
      async (cwd) => window.api.readFile(cwd, 'README.md'),
      workingDirectory
    );
    expect(restored).toBe('original content\n');
  });
});
