import { describe, expect, it } from 'vitest';

import {
  isOpenInEditorShownOutsideStatusBar,
  isStatusBarItemShown,
  statusBarItemMoveUpdate,
  statusBarItemsAreDefault,
  statusBarPlacement,
  tipsInStatusBar,
} from '../../../../../src/renderer/components/layout/status-bar/status-bar-items';

describe('status bar items', () => {
  it('brings Open in editor back outside the bar while the status bar is off', () => {
    expect(isOpenInEditorShownOutsideStatusBar({})).toBe(true);
    expect(isOpenInEditorShownOutsideStatusBar({ showEditorInToolbar: false })).toBe(false);
    expect(
      isOpenInEditorShownOutsideStatusBar({ showStatusBar: false, showEditorInToolbar: false })
    ).toBe(true);
  });

  it('shows what changes on its own by default, and leaves launchers off', () => {
    expect(isStatusBarItemShown({}, 'pull-request')).toBe(true);
    expect(isStatusBarItemShown({}, 'ssh-hosts')).toBe(true);
    expect(isStatusBarItemShown({}, 'commit-graph')).toBe(false);
    expect(isStatusBarItemShown({ statusBarShownItems: ['commit-graph'] }, 'commit-graph')).toBe(
      true
    );
    expect(isStatusBarItemShown({ statusBarHiddenItems: ['pull-request'] }, 'pull-request')).toBe(
      false
    );
  });

  it('hides Tips once turned off', () => {
    const config = { showTipsInToolbar: false };

    expect(isStatusBarItemShown(config, 'tips')).toBe(false);
    expect(tipsInStatusBar(config)).toBe(false);
  });

  describe('placement', () => {
    const DEFAULT_LEFT = [
      'git-menu',
      'target-branch',
      'pull-request',
      'open-in-editor',
      'file-search',
      'file-viewer',
      'diff-viewer',
      'notes',
      'commit-graph',
    ];
    const DEFAULT_RIGHT = [
      'agents',
      'claude-code-usage',
      'codex-usage',
      'automations',
      'notification-sounds',
      'keep-awake',
      'ssh-hosts',
      'system-metrics',
      'tips',
    ];

    it('places the workspace items and tools at the left and the app items at the right', () => {
      expect(statusBarPlacement({})).toEqual({ left: DEFAULT_LEFT, right: DEFAULT_RIGHT });
    });

    it("follows the user's order, skipping unknown and repeated items", () => {
      const placement = statusBarPlacement({
        statusBarLeftItems: ['tips', 'future-item', 'git-menu', 'agent:elsewhere'],
        statusBarRightItems: ['tips', 'notes', 'agents'],
      });

      expect(placement.left.slice(0, 2)).toEqual(['tips', 'git-menu']);
      expect(placement.right.slice(0, 2)).toEqual(['notes', 'agents']);
      expect(placement.left.filter((id) => id === 'tips')).toHaveLength(1);
      expect([...placement.left, ...placement.right]).toHaveLength(
        DEFAULT_LEFT.length + DEFAULT_RIGHT.length
      );
    });

    it('puts an item the user never placed after the one it follows by default', () => {
      const placement = statusBarPlacement({
        statusBarLeftItems: ['notes', 'git-menu'],
        statusBarRightItems: ['tips', 'agents'],
      });

      expect(placement.left).toEqual([
        'notes',
        'commit-graph',
        'git-menu',
        'target-branch',
        'pull-request',
        'open-in-editor',
        'file-search',
        'file-viewer',
        'diff-viewer',
      ]);
      expect(placement.right).toEqual([
        'tips',
        'agents',
        'claude-code-usage',
        'codex-usage',
        'automations',
        'notification-sounds',
        'keep-awake',
        'ssh-hosts',
        'system-metrics',
      ]);
    });

    it('moves an item within its side and across to the other', () => {
      expect(statusBarItemMoveUpdate({}, [], 'tips', 'right', 0)).toEqual({
        statusBarLeftItems: DEFAULT_LEFT,
        statusBarRightItems: ['tips', ...DEFAULT_RIGHT.slice(0, -1)],
      });
      expect(statusBarItemMoveUpdate({}, [], 'notes', 'right', 99)).toEqual({
        statusBarLeftItems: DEFAULT_LEFT.filter((id) => id !== 'notes'),
        statusBarRightItems: [...DEFAULT_RIGHT, 'notes'],
      });
    });

    it('places custom items one by one, new ones closing the left half', () => {
      const placement = statusBarPlacement(
        { statusBarLeftItems: ['agent:tests', 'git-menu'], statusBarRightItems: ['command:ci'] },
        ['command:ci', 'command:deploy', 'agent:tests']
      );

      expect(placement.left).toEqual([
        'agent:tests',
        'git-menu',
        'target-branch',
        'pull-request',
        'open-in-editor',
        'file-search',
        'file-viewer',
        'diff-viewer',
        'notes',
        'commit-graph',
        'command:deploy',
      ]);
      expect(placement.right).toEqual(['command:ci', ...DEFAULT_RIGHT]);
    });

    it("keeps the places of custom items the open workspace doesn't have when moving one", () => {
      const config = {
        statusBarLeftItems: ['git-menu', 'agent:elsewhere', 'target-branch'],
        statusBarRightItems: ['command:gone', 'agents'],
      };

      const update = statusBarItemMoveUpdate(config, ['agent:tests'], 'agent:tests', 'right', 0);

      expect(update.statusBarLeftItems?.slice(0, 3)).toEqual([
        'git-menu',
        'agent:elsewhere',
        'target-branch',
      ]);
      expect(update.statusBarRightItems?.slice(0, 3)).toEqual([
        'command:gone',
        'agent:tests',
        'agents',
      ]);
    });

    it('drops the oldest unknown entries past the limit', () => {
      const stale = Array.from({ length: 130 }, (_, index) => `agent:old-${index}`);

      const update = statusBarItemMoveUpdate(
        { statusBarRightItems: stale },
        [],
        'tips',
        'right',
        0
      );

      expect(update.statusBarRightItems).toHaveLength(128);
      expect(update.statusBarRightItems).toEqual(expect.arrayContaining(DEFAULT_RIGHT));
      expect(update.statusBarRightItems).not.toContain('agent:old-0');
      expect(update.statusBarRightItems).toContain('agent:old-129');
    });
    it('counts a moved item as a change for Reset', () => {
      expect(statusBarItemsAreDefault({})).toBe(true);
      expect(statusBarItemsAreDefault({ statusBarLeftItems: [], statusBarRightItems: [] })).toBe(
        true
      );
      expect(statusBarItemsAreDefault(statusBarItemMoveUpdate({}, [], 'tips', 'left', 0))).toBe(
        false
      );
    });

    it("counts hidden custom items and other workspaces' placed items for Reset", () => {
      expect(statusBarItemsAreDefault({ statusBarHiddenItems: ['command:ci'] })).toBe(false);
      expect(statusBarItemsAreDefault({ statusBarRightItems: ['agent:elsewhere'] })).toBe(false);
      expect(
        statusBarItemsAreDefault(
          statusBarItemMoveUpdate({}, ['agent:tests'], 'agent:tests', 'left', 0),
          ['agent:tests']
        )
      ).toBe(false);
      // The open workspace's own item, saved where it sits by default.
      expect(
        statusBarItemsAreDefault({ statusBarLeftItems: ['agent:tests'] }, ['agent:tests'])
      ).toBe(true);
    });
  });
});
