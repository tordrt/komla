import { describe, expect, it } from 'vitest';

import {
  highlightMatches,
  searchSettings,
  settingsCardId,
} from '../../../../../src/renderer/components/layout/settings/settings-search';

const pages = [
  { value: 'general', label: 'General' },
  { value: 'appearance', label: 'Appearance' },
  { value: 'terminal', label: 'Terminal' },
  { value: 'files', label: 'Files & Diffs' },
  { value: 'voice', label: 'Voice' },
  { value: 'shortcuts', label: 'Shortcuts' },
];

describe('settingsCardId', () => {
  it('slugs a card title into a DOM id', () => {
    expect(settingsCardId('Security & permissions')).toBe('settings-card-security-permissions');
    expect(settingsCardId('MCP and CLI access')).toBe('settings-card-mcp-and-cli-access');
  });
});

describe('searchSettings', () => {
  it('returns nothing for an empty query', () => {
    expect(searchSettings('  ', pages, 'darwin')).toEqual([]);
  });

  it('finds a row by its label, pointing at its page and card', () => {
    const [result] = searchSettings('font size', pages, 'darwin');

    expect(result).toMatchObject({
      kind: 'row',
      page: 'appearance',
      pageLabel: 'Appearance',
      label: 'Font size',
      card: 'Terminal',
      cardId: 'settings-card-terminal',
    });
  });

  it.each(['status bar', 'toolbar', 'footer', 'keep awake', 'tips', 'default editor', 'finder'])(
    'finds the status bar switch for "%s"',
    (query) => {
      expect(searchSettings(query, pages, 'darwin')).toContainEqual(
        expect.objectContaining({ kind: 'row', label: 'Show status bar', card: 'Status bar' })
      );
    }
  );

  it.each(['keep awake', 'sleep', 'caffeinate'])(
    'finds the keep-awake setting under Power for "%s"',
    (query) => {
      expect(searchSettings(query, pages, 'darwin')).toContainEqual(
        expect.objectContaining({ kind: 'row', label: 'Keep computer awake', card: 'Power' })
      );
    }
  );

  it('finds notification settings beside the agent integrations', () => {
    const agentPages = [
      { value: 'agent', label: 'Agents' },
      { value: 'integrations', label: 'Integrations & MCP' },
    ];

    expect(searchSettings('notification sounds', agentPages, 'darwin')).toEqual([
      expect.objectContaining({
        kind: 'row',
        page: 'integrations',
        label: 'Notification sounds',
        card: 'Notifications',
      }),
    ]);
  });

  it('ranks the page, then cards, then rows', () => {
    const results = searchSettings('cursor', pages, 'darwin');

    expect(results.map((result) => [result.kind, result.label])).toEqual([
      ['card', 'Terminal'],
      ['row', 'Cursor style'],
      ['row', 'Cursor blink'],
    ]);
    expect(searchSettings('terminal', pages, 'darwin')[0]).toMatchObject({
      kind: 'page',
      page: 'terminal',
    });
  });

  it('matches words from the page or card a row sits in, as long as one is the row’s own', () => {
    const labels = searchSettings('terminal font', pages, 'darwin').map((result) => result.label);

    expect(labels).toContain('Font size');
    expect(labels).toContain('Font family');
    // "terminal" alone matches the page, not every row on it.
    expect(searchSettings('terminal', pages, 'darwin').map((result) => result.label)).not.toContain(
      'Font size'
    );
  });

  it('finds pages and cards by keyword', () => {
    expect(searchSettings('keybindings', pages, 'darwin')[0]).toMatchObject({
      kind: 'page',
      page: 'shortcuts',
    });
    expect(searchSettings('dark', pages, 'darwin')[0]).toMatchObject({
      kind: 'card',
      label: 'Theme',
      cardId: 'settings-card-theme',
    });
  });

  it('finds voice input on its own page', () => {
    expect(
      searchSettings('dictation', pages, 'darwin').map((result) => [result.kind, result.page])
    ).toEqual([
      ['page', 'voice'],
      ['card', 'voice'],
    ]);
    expect(searchSettings('auto-record', pages, 'darwin')[0]).toMatchObject({
      page: 'voice',
      cardId: 'settings-card-voice-input',
    });
    for (const query of ['transcription model', 'parakeet']) {
      expect(searchSettings(query, pages, 'darwin')[0]).toMatchObject({
        kind: 'card',
        page: 'voice',
        label: 'Transcription model',
        cardId: 'settings-card-transcription-model',
      });
    }
  });

  it('indexes shortcut actions under their group card', () => {
    expect(searchSettings('split right', pages, 'darwin')[0]).toMatchObject({
      page: 'shortcuts',
      label: 'Split right',
      cardId: 'settings-card-terminal',
    });
  });

  it('leaves out pages that are not offered', () => {
    expect(searchSettings('font size', [pages[0]], 'darwin')).toEqual([]);
  });

  it('leaves out settings that the platform does not show', () => {
    expect(searchSettings('wsl', pages, 'darwin')).toEqual([]);
    expect(searchSettings('wsl', pages, 'win32').map((result) => result.label)).toEqual([
      'WSL distribution',
      'Terminal shell',
    ]);
  });

  it('has no card id for rows outside a titled card', () => {
    expect(searchSettings('clear logs', pages, 'darwin')[0]).toMatchObject({
      page: 'general',
      label: 'Clear logs',
      cardId: undefined,
    });
  });
});

describe('searchSettings in projects', () => {
  const projectPages = [...pages, { value: 'projects', label: 'Projects' }];
  const komla = { id: 'p1', name: 'Komla', isGit: true, showsSsh: true };
  const notes = { id: 'p2', name: 'Notes', isGit: false, showsSsh: false };

  it('finds a project by name', () => {
    expect(searchSettings('kom', projectPages, 'darwin', [komla, notes])[0]).toMatchObject({
      kind: 'project',
      page: 'projects',
      label: 'Komla',
      projectId: 'p1',
    });
  });

  it("finds a setting on each project's page, narrowed by the project's name", () => {
    const keys = (query: string) =>
      searchSettings(query, projectPages, 'darwin', [komla, { ...komla, id: 'p3', name: 'Docs' }])
        .filter((result) => result.label === 'Trash cleanup')
        .map((result) => result.projectId);

    expect(keys('trash')).toEqual(['p1', 'p3']);
    expect(keys('trash docs')).toEqual(['p3']);
    expect(searchSettings('trash docs', projectPages, 'darwin', [komla])).toEqual([]);
  });

  it('points a project setting at its page and card', () => {
    expect(
      searchSettings('branch prefix', projectPages, 'darwin', [komla]).find(
        (result) => result.projectId === 'p1'
      )
    ).toMatchObject({
      kind: 'row',
      page: 'projects',
      pageLabel: 'Komla',
      card: 'Branches',
      cardId: 'settings-card-branches',
    });
  });

  it('leaves out what a project page does not show', () => {
    const labels = (query: string, project: typeof komla) =>
      searchSettings(query, projectPages, 'darwin', [project]).map((result) => result.label);

    expect(labels('branch prefix', notes)).toEqual([]);
    expect(labels('run terminal commands', { ...komla, showsSsh: false })).toEqual([]);
    expect(labels('run terminal commands', komla)).toEqual(['Run Terminal Commands on']);
    expect(labels('delete project', notes)).toEqual(['Delete project']);
  });

  it('leaves projects out when the Projects page is not offered', () => {
    expect(searchSettings('notes', pages, 'darwin', [notes])).toEqual([]);
  });
});

describe('highlightMatches', () => {
  it('flags every occurrence of each query word, ignoring case', () => {
    expect(highlightMatches('Show pane buttons on focus', 'PANE on')).toEqual([
      { text: 'Show ', match: false },
      { text: 'pane', match: true },
      { text: ' butt', match: false },
      { text: 'on', match: true },
      { text: 's ', match: false },
      { text: 'on', match: true },
      { text: ' focus', match: false },
    ]);
  });

  it('returns the text unmarked when nothing matches', () => {
    expect(highlightMatches('Zoom level', 'font')).toEqual([{ text: 'Zoom level', match: false }]);
  });
});
