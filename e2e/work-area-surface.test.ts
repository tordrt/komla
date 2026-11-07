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

  test('rounds each pane on a chrome gutter, with clear lines around the panes, tabs, panels and file panel', async ({
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
          const panelBody = getComputedStyle(panel.querySelector('.file-panel-body')!);
          const panelBodyBox = panel.querySelector('.file-panel-body')!.getBoundingClientRect();
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
            panelLine: panelBody.borderLeftWidth,
            panelBottomLine: panelBody.borderBottomWidth,
            panelCorner: panelBody.borderBottomLeftRadius,
            panelTopLine: panelBody.borderTopWidth,
            bottomRow: (() => {
              const footer = document.querySelector<HTMLElement>('[data-sidebar-footer]')!;
              const bar = document.querySelector<HTMLElement>('[data-status-bar]')!;
              return {
                level:
                  Math.round(footer.getBoundingClientRect().top) ===
                  Math.round(bar.getBoundingClientRect().top),
                lines: [footer, bar].every((el) =>
                  getComputedStyle(el).boxShadow.includes('inset')
                ),
                divider: getComputedStyle(footer, '::after').height,
              };
            })(),
            // The panel's header in the top row is macOS's; elsewhere its tabs sit in the panel.
            topRowDivider: (() => {
              const header = document.querySelector('[data-testid="file-panel-header"]');
              return header && getComputedStyle(header, '::before').height;
            })(),
            panelTopCorner: panelBody.borderTopLeftRadius,
            panelTopLevelWithPanes: Math.round(panelBodyBox.top) === Math.round(box.top),
            panelBottom: Math.round(statusBar.top - panelBodyBox.bottom),
            paneLine: getComputedStyle(pane!.querySelector('.pane-outline')!).borderTopColor,
            ...Object.fromEntries(
              (
                [
                  ['tabLine', '[data-testid="terminal-tab-row"] [data-active]'],
                  ['sidebarPanelLine', '.sidebar-panel'],
                  ['newWorkspaceLine', '[data-new-workspace-controls]'],
                ] as const
              ).map(([key, selector]) => {
                const style = getComputedStyle(document.querySelector(selector)!);
                return [key, `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset}`];
              })
            ),
            selectedWorkspaceLine: getComputedStyle(
              document.querySelector('.sidebar-selected-card')!
            ).boxShadow.includes('inset'),
            headerLine: (() => {
              const header = document.querySelector('[data-testid="file-panel-header"]');
              return header && getComputedStyle(header).borderLeftWidth;
            })(),
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
        panelLine: '1px',
        panelBottomLine: '1px',
        panelCorner: '12px',
        panelTopLine: '1px',
        bottomRow: { level: true, lines: true, divider: '16px' },
        topRowDivider: process.platform === 'darwin' ? '16px' : null,
        panelTopCorner: '12px',
        panelTopLevelWithPanes: true,
        panelBottom: 6,
        paneLine: expect.not.stringMatching(/^rgba\(0, 0, 0, 0\)$/),
        tabLine: 'solid 1px -1px',
        sidebarPanelLine: 'solid 1px -1px',
        newWorkspaceLine: 'solid 1px -1px',
        selectedWorkspaceLine: true,
        headerLine: process.platform === 'darwin' ? '0px' : null,
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

  // With no workspace open, a line marks the sidebar's edge. It stands where a pane's edge stands
  // once one opens, a gutter past the sidebar, so it keeps as clear of the sidebar's panels as the
  // panes do. The bottom row's short divider stays at the sidebar's edge either way.
  test("draws the sidebar's edge line where a pane's edge stands", async ({ appWindow }) => {
    const newWorkspace = appWindow.getByRole('button', { name: 'New Workspace' }).first();
    await expect(newWorkspace).toBeVisible({ timeout: 15_000 });
    await expect(appWindow.locator('.empty-work-area')).toBeVisible();
    // With no workspaces yet, the sidebar starts collapsed.
    await appWindow.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(appWindow.locator('.sidebar-surface')).toBeVisible();

    const edge = await appWindow.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>('.sidebar-surface')!;
      const line = getComputedStyle(sidebar, '::after');
      const footer = document.querySelector<HTMLElement>('[data-sidebar-footer]')!;
      const divider = getComputedStyle(footer, '::after');
      const sidebarRight = sidebar.getBoundingClientRect().right;
      return {
        lineDrawn: line.content !== 'none',
        lineLeft: Math.round(sidebarRight - parseFloat(line.right) - parseFloat(line.width)),
        dividerLeft: Math.round(
          footer.getBoundingClientRect().right -
            parseFloat(divider.right) -
            parseFloat(divider.width)
        ),
        sidebarRight: Math.round(sidebarRight),
      };
    });

    await newWorkspace.click();
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill('work-area-surface/edge');
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
    const pane = appWindow.getByTestId('pane-outline').filter({ visible: true });
    await expect(pane).toHaveCount(1, { timeout: 10_000 });
    const paneLeft = Math.round((await pane.boundingBox())!.x);

    expect(edge.lineDrawn).toBe(true);
    expect(paneLeft).toBe(edge.sidebarRight + 6);
    expect(edge.lineLeft).toBe(paneLeft);
    expect(edge.dividerLeft).toBe(edge.sidebarRight - 1);
  });
});
