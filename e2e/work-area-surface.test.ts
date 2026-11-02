import { test as base, expect, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'work-area-surface/' });
    await provide();
  },
});

test.describe('Work area surface', () => {
  test.describe.configure({ timeout: 60_000 });

  test('puts the tab row on the sidebar color, joining the active tab to the panes', async ({
    appWindow,
  }) => {
    await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill('work-area-surface/one');
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
    await expect(appWindow.locator('.xterm').filter({ visible: true })).toHaveCount(1, {
      timeout: 10_000,
    });
    await appWindow.getByRole('button', { name: 'New tab' }).click();
    await appWindow.getByRole('menuitem', { name: 'New terminal' }).click();
    await expect(appWindow.locator('[data-tab-id]').filter({ visible: true })).toHaveCount(2);

    const surface = await appWindow.evaluate(() => {
      const background = (selector: string) =>
        getComputedStyle(document.querySelector(selector)!).backgroundColor;
      const activeTab = document.querySelector(
        '[data-testid="terminal-tab-row"] .flat-tab-active.joined-tab'
      )!;
      const tabs = [...document.querySelectorAll('[data-testid="terminal-tab-row"] [data-tab-id]')];
      return {
        column: getComputedStyle(document.querySelector('.work-column')!).backgroundColor,
        topRow: background('[data-testid="workspace-top-row"]'),
        columnBorder: getComputedStyle(document.querySelector('.work-column')!).borderLeftWidth,
        columnBorderColor: getComputedStyle(document.querySelector('.work-column')!)
          .borderLeftColor,
        topRowLine: getComputedStyle(document.querySelector('[data-testid="workspace-top-row"]')!)
          .boxShadow,
        columnBottom: document.querySelector('.work-column')!.getBoundingClientRect().bottom,
        windowBottom: window.innerHeight,
        statusBarInColumn: !!document.querySelector('.work-column [data-testid="status-bar"]'),
        activeTabIndex: tabs.findIndex((tab) => tab.contains(activeTab)),
        activeTabBackground: getComputedStyle(activeTab).backgroundColor,
        activeTabOutline: getComputedStyle(activeTab, '::after').borderTopColor,
        activeTabSideLines: getComputedStyle(activeTab).boxShadow,
        dark: document.documentElement.classList.contains('dark'),
      };
    });

    // Nothing paints over the chrome: the column and the tab row are see-through.
    expect(surface.column).toBe('rgba(0, 0, 0, 0)');
    expect(surface.topRow).toBe('rgba(0, 0, 0, 0)');
    // A faint line along the sidebar, the same one as under the tab row, so the panes are framed
    // alike. (The browser writes one in oklab and the other in oklch, so compare the 8% alpha.)
    const faint = /\/ 0\.08\)/;
    expect(surface.columnBorder).toBe('1px');
    expect(surface.columnBorderColor).toMatch(faint);
    expect(surface.topRowLine).toMatch(faint);
    // The status bar sits in the column, which runs the window's full height.
    expect(surface.statusBarInColumn).toBe(true);
    expect(surface.columnBottom).toBe(surface.windowBottom);
    // The new tab is active, in the panes' color, so it opens into them.
    expect(surface.activeTabIndex).toBe(1);
    expect(surface.activeTabBackground).not.toBe('rgba(0, 0, 0, 0)');
    // Its outline is the same faint line that frames the panes, with no side lines of its own.
    expect(surface.activeTabOutline).toMatch(faint);
    expect(surface.dark).toBe(true);
    expect(surface.activeTabSideLines).toBe('none');
  });

  test('sets split panes apart on a 4px gutter of the sidebar color', async ({ appWindow }) => {
    await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill('work-area-surface/split');
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
    const panes = appWindow.locator('.xterm').filter({ visible: true });
    await expect(panes).toHaveCount(1, { timeout: 10_000 });
    await panes.first().click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Split Right' }).click();
    await expect(panes).toHaveCount(2, { timeout: 10_000 });
    await panes.last().click({ button: 'right' });
    await appWindow.getByRole('menuitem', { name: 'Split Down' }).click();
    await expect(panes).toHaveCount(3, { timeout: 10_000 });

    await expect
      .poll(() =>
        appWindow.evaluate(() => {
          // Each pane fills the split view it sits in, inside the view's gutter.
          const boxes = [...document.querySelectorAll<HTMLElement>('.split-view-view .xterm')]
            .filter((xterm) => xterm.offsetParent)
            .map((xterm) => xterm.closest('.split-view-view')!.firstElementChild!)
            .map((pane) => pane.getBoundingClientRect());
          const [left, top, bottom] = boxes;
          const gutter = getComputedStyle(
            document.querySelector(
              '.split-view-horizontal > .split-view-container > :nth-child(2)'
            )!
          ).backgroundColor;
          const probe = document.body.appendChild(document.createElement('div'));
          probe.style.backgroundColor = 'oklch(var(--chrome))';
          const sidebar = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return {
            across: Math.round(top.left - left.right),
            down: Math.round(bottom.top - top.bottom),
            gutterIsSidebarColor: gutter === sidebar && gutter !== 'rgba(0, 0, 0, 0)',
          };
        })
      )
      .toEqual({ across: 4, down: 4, gutterIsSidebarColor: true });
  });

  test('styles a browser pane like the tab row: square tabs on the chrome, faint lines', async ({
    appWindow,
  }) => {
    await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill('work-area-surface/browser');
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
    await expect(appWindow.locator('.xterm').filter({ visible: true })).toHaveCount(1, {
      timeout: 10_000,
    });
    await appWindow.getByRole('button', { name: 'New tab' }).click();
    await appWindow.getByRole('menuitem', { name: 'New browser' }).click();
    await expect(appWindow.getByRole('button', { name: 'New browser tab' })).toBeVisible();

    const browser = await appWindow.evaluate(() => {
      const addButton = document.querySelector('[aria-label="New browser tab"]')!;
      const strip = addButton.closest('.pane-frame-tabs')!;
      const activeTab = strip.querySelector('.flat-tab-active.joined-tab')!;
      const probe = document.body.appendChild(document.createElement('div'));
      probe.style.backgroundColor = 'oklch(var(--chrome))';
      const chrome = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        stripOnChrome: getComputedStyle(strip).backgroundColor === chrome,
        stripLine: getComputedStyle(strip).boxShadow,
        tabRadius: getComputedStyle(activeTab).borderTopRightRadius,
        tabOutline: getComputedStyle(activeTab, '::after').borderTopColor,
        addressLine: getComputedStyle(
          document.querySelector('[data-browser-address]')!.closest('.border-b')!
        ).borderBottomColor,
      };
    });

    const faint = /\/ 0\.08\)/;
    expect(browser.stripOnChrome).toBe(true);
    expect(browser.stripLine).toMatch(faint);
    expect(browser.tabRadius).toBe('0px');
    expect(browser.tabOutline).toMatch(faint);
    expect(browser.addressLine).toMatch(faint);
  });
});
