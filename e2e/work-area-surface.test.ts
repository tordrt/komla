import { test as base, expect, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'work-area-surface/' });
    await provide();
  },
});

test.describe('Work area surface', () => {
  test.describe.configure({ timeout: 60_000 });

  test('puts the tab row on the sidebar color, the active tab a pill on it', async ({
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
      const activeTab = document.querySelector('[data-testid="terminal-tab-row"] [data-active]')!;
      const topRow = document.querySelector('[data-testid="workspace-top-row"]')!;
      const tabs = [...document.querySelectorAll('[data-testid="terminal-tab-row"] [data-tab-id]')];
      return {
        column: getComputedStyle(document.querySelector('.work-column')!).backgroundColor,
        topRow: background('[data-testid="workspace-top-row"]'),
        columnBorder: getComputedStyle(document.querySelector('.work-column')!).borderLeftWidth,
        topRowLine: getComputedStyle(document.querySelector('[data-testid="workspace-top-row"]')!)
          .boxShadow,
        columnBottom: document.querySelector('.work-column')!.getBoundingClientRect().bottom,
        windowBottom: window.innerHeight,
        statusBarInColumn: !!document.querySelector('.work-column [data-testid="status-bar"]'),
        activeTabIndex: tabs.findIndex((tab) => tab.contains(activeTab)),
        activeTabBackground: getComputedStyle(activeTab).backgroundColor,
        activeTabRadius: getComputedStyle(activeTab).borderTopLeftRadius,
        activeTabBottomRadius: getComputedStyle(activeTab).borderBottomLeftRadius,
        activeTabGapBelow:
          topRow.getBoundingClientRect().bottom - activeTab.getBoundingClientRect().bottom,
      };
    });

    // Nothing paints over the chrome: the column and the tab row are see-through.
    expect(surface.column).toBe('rgba(0, 0, 0, 0)');
    expect(surface.topRow).toBe('rgba(0, 0, 0, 0)');
    // No line along the sidebar: the column and the sidebar are one chrome.
    expect(surface.columnBorder).toBe('0px');
    // No line under the tab row: a split's gutter, the same chrome, runs up into it.
    expect(surface.topRowLine).toBe('none');
    // The status bar sits in the column, which runs the window's full height.
    expect(surface.statusBarInColumn).toBe(true);
    expect(surface.columnBottom).toBe(surface.windowBottom);
    // The new tab is active: a rounded pill in a faint foreground wash, clear of the panes below.
    expect(surface.activeTabIndex).toBe(1);
    expect(surface.activeTabBackground).toMatch(/\/ 0\.075\)/);
    expect(surface.activeTabRadius).toBe('8px');
    expect(surface.activeTabBottomRadius).toBe('8px');
    expect(surface.activeTabGapBelow).toBeGreaterThan(0);
  });

  test('sets split panes apart on a 6px gutter of the sidebar color', async ({ appWindow }) => {
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
      .toEqual({ across: 6, down: 6, gutterIsSidebarColor: true });
  });

  test('rounds each pane on a chrome gutter that runs around them, with no lines beside them', async ({
    appWindow,
  }) => {
    await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill('work-area-surface/rounded');
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
    await expect(appWindow.locator('.xterm').filter({ visible: true })).toHaveCount(1, {
      timeout: 10_000,
    });
    await appWindow.getByRole('button', { name: 'Toggle file panel' }).click();
    await expect(
      appWindow.getByRole('separator', { name: 'Resize file tree panel' })
    ).toBeVisible();

    await expect
      .poll(() =>
        appWindow.evaluate(() => {
          const xterm = [...document.querySelectorAll<HTMLElement>('.xterm')].find(
            (element) => element.offsetParent
          )!;
          let pane: HTMLElement | null = xterm;
          while (pane && getComputedStyle(pane).borderTopLeftRadius === '0px') {
            pane = pane.parentElement;
          }
          const box = pane!.getBoundingClientRect();
          const column = document.querySelector('.work-column')!.getBoundingClientRect();
          const statusBar = document.querySelector('[data-status-bar]')!.getBoundingClientRect();
          const panel = document.querySelector('.file-panel-chrome')!;
          const probe = document.body.appendChild(document.createElement('div'));
          probe.style.backgroundColor = 'oklch(var(--chrome))';
          const chrome = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const behind = getComputedStyle(
            pane!.closest('.overflow-clip.relative')!.parentElement!.closest('.overflow-clip') ??
              pane!.parentElement!
          ).backgroundColor;
          return {
            radius: getComputedStyle(pane!).borderBottomRightRadius,
            paneColored: getComputedStyle(pane!).backgroundColor !== 'rgba(0, 0, 0, 0)',
            left: Math.round(box.left - column.left),
            bottom: Math.round(statusBar.top - box.bottom),
            right: Math.round(panel.getBoundingClientRect().left - box.right),
            onChrome: behind === chrome,
            panelLine: getComputedStyle(panel).borderLeftWidth,
            panelBottomLine: getComputedStyle(panel).boxShadow.includes('inset'),
            headerLine: getComputedStyle(
              document.querySelector('[data-testid="file-panel-header"]')!
            ).borderLeftWidth,
          };
        })
      )
      .toEqual({
        radius: '12px',
        paneColored: true,
        left: 6,
        bottom: 6,
        right: 6,
        onChrome: true,
        panelLine: '0px',
        panelBottomLine: true,
        headerLine: '0px',
      });
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
