import { test as base, expect, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'sidebar-expand-button/' });
    await provide();
  },
});

test.describe('Sidebar expand button', () => {
  test('shows whole in the title bar, not clipped by the row it sits in', async ({
    appWindow,
  }) => {
    // A window without workspaces collapses its sidebar, and shows the title bar rather than a
    // workspace's tab row.
    const expand = appWindow.getByTestId('title-bar').getByRole('button', {
      name: 'Expand sidebar',
    });
    await expect(expand).toBeVisible({ timeout: 15_000 });

    // Every ancestor that clips its overflow must contain the whole button.
    const clippedBy = await expand.evaluate((button) => {
      const box = button.getBoundingClientRect();
      for (let el = button.parentElement; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const clip = el.getBoundingClientRect();
        if (
          box.left < clip.left - 0.5 ||
          box.right > clip.right + 0.5 ||
          box.top < clip.top - 0.5 ||
          box.bottom > clip.bottom + 0.5
        ) {
          return el.className;
        }
      }
      return null;
    });
    expect(clippedBy).toBeNull();
  });
});
