import { describe, expect, it } from 'vitest';

import { shortcutEntries } from '../../../src/renderer/constants/shortcut-entries';

describe('shortcutEntries', () => {
  it('lists the jump to the next workspace needing input with the workspace shortcuts', () => {
    expect(shortcutEntries).toContainEqual({
      action: 'workspace.nextAttention',
      label: 'Next workspace needing input',
      group: 'Workspace',
    });
  });

  it('lists the command center with the workspace shortcuts', () => {
    expect(shortcutEntries).toContainEqual({
      action: 'commandCenter.open',
      label: 'Command center',
      group: 'Workspace',
    });
  });

  it('lists New note with the file shortcuts', () => {
    expect(shortcutEntries).toContainEqual({
      action: 'note.new',
      label: 'New note',
      group: 'File',
    });
  });

  it('lists each action once', () => {
    const actions = shortcutEntries.map((entry) => entry.action);
    expect(new Set(actions).size).toBe(actions.length);
  });
});
