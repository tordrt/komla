import fs from 'fs';
import path from 'path';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'dir/' });
    await provide();
  },
});

test.describe('Directory-mode workspace', () => {
  test('creates a directory-mode workspace at an arbitrary path', async ({ appWindow }) => {
    const dir = path.join(SANDBOX_DIR, 'lone-dir');
    fs.mkdirSync(dir, { recursive: true });

    const result = await appWindow.evaluate(
      async (workingDirectory) =>
        window.api.createWorkspace({
          mode: 'directory',
          directoryPath: workingDirectory,
          customName: 'DirWS',
        }),
      dir
    );
    expect(result).not.toHaveProperty('__workspaceCreateError', true);

    await expect
      .poll(async () =>
        appWindow.evaluate(async () =>
          (await window.api.getWorkspaces()).map((w) => ({
            customName: w.customName,
            isWorktree: w.isWorktree,
            workingDirectory: w.workingDirectory,
          }))
        )
      )
      .toEqual(
        expect.arrayContaining([{ customName: 'DirWS', isWorktree: false, workingDirectory: dir }])
      );
    // The folder opens as a folder project of its own.
    const { workspace, project } = await appWindow.evaluate(async (workingDirectory) => {
      const workspace = (await window.api.getWorkspaces()).find(
        (w) => w.workingDirectory === workingDirectory
      );
      const project = (await window.api.getProjects()).find((p) => p.id === workspace?.projectId);
      return { workspace, project };
    }, dir);
    expect(workspace?.projectId).toBeTruthy();
    expect(project).toMatchObject({ kind: 'directory', name: 'lone-dir', repositoryPath: dir });
  });
});
