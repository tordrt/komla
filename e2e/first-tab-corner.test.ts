import { test as base, expect, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'first-tab-corner/' });
    await provide();
  },
});

const FIRST_TAB = '[data-testid="terminal-tab-row"] .flat-tab-active.edge-tab';

test.describe('First tab corner', () => {
  test.describe.configure({ timeout: 60_000 });

  test("follows the work area card's corner, so the card doesn't clip its outline", async ({
    appWindow,
  }) => {
    await expect(appWindow.getByRole('button', { name: 'New Workspace' }).first()).toBeVisible({
      timeout: 15_000,
    });
    await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
    const dialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
    await dialog.locator('input[placeholder$="swift-fox"]').fill('first-tab-corner/one');
    await dialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
    await expect(appWindow.locator(FIRST_TAB)).toBeVisible({ timeout: 10_000 });

    const corner = await appWindow.evaluate((firstTab) => {
      document.documentElement.classList.add('dark');
      const tabElement = document.querySelector(firstTab)!;
      const cardElement = document.querySelector('.work-column')!;
      const tab = getComputedStyle(tabElement);
      const card = getComputedStyle(cardElement);
      const cardRadius = parseFloat(card.borderTopLeftRadius);
      const tabOffset =
        tabElement.getBoundingClientRect().top -
        cardElement.getBoundingClientRect().top -
        parseFloat(card.borderTopWidth);
      return {
        tabRadius: tab.borderTopLeftRadius,
        // The card's inner curve, as seen from the tab: inside its borders, and from the tab's top.
        cardInnerRadius: `${cardRadius - parseFloat(card.borderLeftWidth)}px ${
          cardRadius - parseFloat(card.borderTopWidth) - tabOffset
        }px`,
        tabShadow: tab.boxShadow,
      };
    }, FIRST_TAB);

    expect(corner.tabRadius).toBe(corner.cardInnerRadius);
    // The card's border already draws this edge: a line of the tab's own would double it.
    expect(corner.tabShadow).not.toMatch(/ 1px 0px 0px 0px inset/);
    expect(corner.tabShadow).toMatch(/ 0px 1px 0px 0px inset/);
  });
});
