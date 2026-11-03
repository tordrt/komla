import fs from 'fs';
import path from 'path';

import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

const PROJECT_COUNT = 40;

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    const { repoDir } = seedDefaultProject({ branchPrefix: 'project-dropdown/' });
    const file = path.join(SANDBOX_DIR, 'settings', 'projects.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const [first] = settings.projects;
    for (let order = 1; order < PROJECT_COUNT; order++) {
      settings.projects.push({
        ...first,
        id: `project-${order}`,
        name: `project-${String(order).padStart(2, '0')}`,
        repositoryPath: repoDir,
        order,
      });
    }
    fs.writeFileSync(file, JSON.stringify(settings));
    await provide();
  },
});

test.describe('Project dropdown', () => {
  test('keeps a long project list inside the window, scrolling by wheel', async ({
    electronApp,
    appWindow,
  }) => {
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1280, 800)
    );
    const newWorkspace = appWindow.getByRole('button', { name: 'New Workspace' }).first();
    await expect(newWorkspace).toBeVisible({ timeout: 15_000 });
    await newWorkspace.click();
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.getByRole('button', { name: /seed-repo/ }).click();
    const menu = appWindow.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /project-39/ })).toBeAttached();

    // Stops short of the window's edge, like the project search, so its border isn't cut off.
    const { bottom, windowHeight } = await menu.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished));
      return { bottom: element.getBoundingClientRect().bottom, windowHeight: window.innerHeight };
    });
    expect(bottom).toBeLessThanOrEqual(windowHeight - 8);

    const box = (await menu.boundingBox())!;
    await appWindow.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await appWindow.mouse.wheel(0, 2000);
    await expect(menu.getByRole('menuitem', { name: 'Open folder…' })).toBeInViewport();
  });
});
