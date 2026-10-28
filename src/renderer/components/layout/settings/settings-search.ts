import { shortcutEntries } from '@/constants/shortcut-entries';

/** The DOM id a `SettingsCard` gets from its title, so search results can scroll to it. */
export function settingsCardId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `settings-card-${slug}`;
}

interface SettingsSearchEntry {
  kind: 'card' | 'row';
  /** The card title or row label, as shown on the page. */
  label: string;
  /** For rows, the title of the card they sit in, if any. */
  card?: string;
  /** Extra words that find this entry. */
  keywords?: string;
  /** Platforms the setting is shown on; all when omitted. */
  platforms?: readonly string[];
}

const card = (label: string, keywords?: string): SettingsSearchEntry => ({
  kind: 'card',
  label,
  keywords,
});
const rows = (cardTitle: string | undefined, ...labels: string[]): SettingsSearchEntry[] =>
  labels.map((label) => ({ kind: 'row', label, card: cardTitle }));

// What each page shows, for the sidebar search. Pages render their cards
// conditionally, so this is a static list rather than something read from the
// DOM. Keep it in step when cards or rows are added, renamed, or removed.
const SETTINGS_SEARCH_INDEX: Record<string, readonly SettingsSearchEntry[]> = {
  general: [
    card('AI utilities', 'llm provider openai anthropic ollama'),
    ...rows(
      'AI utilities',
      'Auto-name workspaces',
      'Auto-name branches',
      'Provider',
      'Base URL',
      'Model',
      'Workspace naming prompt',
      'Commit message prompt',
      'API key',
      'Test connection'
    ),
    card('Workspace tags', 'label waiting review merge blocked status'),
    {
      kind: 'row',
      label: 'Tag from pull requests',
      card: 'Workspace tags',
      keywords: 'github gh pr review changes auto',
    },
    card('Power', 'sleep'),
    {
      kind: 'row',
      label: 'Keep computer awake',
      card: 'Power',
      keywords: 'sleep caffeinate prevent suspend agents',
    },
    card('Advanced'),
    {
      kind: 'row',
      label: 'Hold ⌘Q to quit',
      card: 'Advanced',
      keywords: 'cmd q quit accidental warn before quitting confirm',
      platforms: ['darwin'],
    },
    {
      kind: 'row',
      label: 'Hold Ctrl+Q to quit',
      card: 'Advanced',
      keywords: 'ctrl q quit accidental warn before quitting confirm',
      platforms: ['linux'],
    },
    ...rows('Advanced', 'Resource usage'),
    card('Settings history', 'undo revert agent changes'),
    card('Privacy', 'telemetry'),
    ...rows('Privacy', 'Usage data', 'Crash reports'),
    ...rows(undefined, 'Delete all workspaces', 'Clear logs'),
  ],
  git: [
    card('Branches', 'naming'),
    ...rows('Branches', 'Branch prefix'),
    card('Commit buttons', 'git shortcut ahead behind merge rebase pull request'),
    ...rows(
      'Commit buttons',
      'Commits ahead (↑N), default branch',
      'Commits ahead (↑N), other branches',
      'Push target branch after fast-forward',
      'Commits behind (↓N)'
    ),
    card('Fetching', 'auto fetch remote origin'),
    ...rows('Fetching', 'Fetch in the background'),
  ],
  agent: [card('Presets', 'agent cli command launch mode')],
  integrations: [
    card('Agent integrations', 'hooks'),
    ...rows('Agent integrations', 'Claude Code', 'Codex CLI', 'Antigravity CLI', 'OpenCode'),
    card('Notifications'),
    ...rows('Notifications', 'Hooks endpoint', 'Activity spinner', 'Notification sounds'),
    card('MCP and CLI access', 'capabilities'),
    ...rows('MCP and CLI access', 'Komla CLI', 'MCP server'),
    {
      kind: 'row',
      label: 'Agent actions',
      card: 'MCP and CLI access',
      keywords: 'komla launch title preview',
    },
    card('Komla CLI launch defaults', 'mcp ssh host'),
    ...rows(
      'Komla CLI launch defaults',
      'Default agent',
      'Default launch mode',
      'Where agents start'
    ),
  ],
  appearance: [
    card('Theme', 'palette dark light color scheme system match automatic'),
    card('Terminal', 'colors font cursor editor'),
    ...rows(
      'Terminal',
      'Background color',
      'Font family',
      'Font size',
      'Line height',
      'Cursor style',
      'Cursor blink'
    ),
    card('Interface'),
    ...rows(
      'Interface',
      'Zoom level',
      'Hide branch names on workspace cards',
      'Compact workspace list',
      'Activity spinner style'
    ),
    { kind: 'row', label: 'Accent color', card: 'Interface', keywords: 'highlight' },
    {
      kind: 'row',
      label: 'Reduce effects',
      card: 'Interface',
      keywords: 'animation motion blur performance slow gpu',
    },
    card('Status bar'),
    {
      kind: 'row',
      label: 'Show status bar',
      card: 'Status bar',
      keywords:
        'toolbar footer bottom bar agents keep awake ssh hosts tips lightbulb open in editor default editor finder explorer file manager',
    },
    {
      kind: 'row',
      label: 'Show agents in the menu bar',
      card: 'Status bar',
      keywords: 'menu bar tray top macos agents activity',
      platforms: ['darwin'],
    },
    {
      kind: 'row',
      label: 'Only while Komla is in the background',
      card: 'Status bar',
      keywords: 'menu bar tray hide focused front background macos',
      platforms: ['darwin'],
    },
  ],
  terminal: [
    card('Scrollback', 'history'),
    ...rows('Scrollback', 'Scrollback lines'),
    card('Panes', 'split'),
    ...rows(
      'Panes',
      'Show pane headers',
      'Show pane buttons on focus',
      'Dim unfocused panes',
      'Focused pane border',
      'Notification pane border'
    ),
    card('Links', 'url browser external website localhost'),
    ...rows('Links', 'Open links in'),
    card('Mouse', 'right click context menu paste'),
    ...rows('Mouse', 'Send right-clicks to programs'),
    {
      kind: 'row',
      label: 'Terminal shell',
      card: 'Shell',
      keywords: 'powershell wsl',
      platforms: ['win32'],
    },
    {
      kind: 'row',
      label: 'WSL distribution',
      card: 'Shell',
      platforms: ['win32'],
    },
    {
      kind: 'row',
      label: "Use Komla's ConPTY",
      card: 'Shell',
      keywords: 'conpty scrollback codex missing output',
      platforms: ['win32'],
    },
  ],
  files: [
    card('File tree', 'diff'),
    ...rows(
      'File tree',
      'Show file tree by default',
      'Default mode',
      'Show changes since target branch by default',
      'Live follow by default'
    ),
    card('Search'),
    ...rows('Search', 'Open search results in'),
    card('Editor', 'monaco'),
    ...rows('Editor', 'Vim mode'),
    card('Browser preview', 'dev server globe default browser links'),
    ...rows('Browser preview', 'Auto reload'),
  ],
  voice: [
    card('Voice input', 'dictation speech microphone'),
    ...rows('Voice input', 'Auto-record in workspace dialog'),
    card('Transcription model', 'parakeet download'),
  ],
  shortcuts: shortcutEntries.flatMap((entry) => rows(entry.group, entry.label)),
  remote: [
    card('Remote control', 'phone mobile tablet tailscale serve publish'),
    ...rows('Remote control', 'Allow access to this computer', 'Keep computer awake'),
    card('SSH hosts', 'ssh tailscale phone direct access only'),
    card('Devices', 'pair paired phone tablet qr code passkey'),
  ],
  license: [card('Plan', 'subscription'), card('Active machines', 'devices')],
};

interface ProjectSearchEntry extends SettingsSearchEntry {
  /** Shown only for git projects, or only where the SSH workspaces card is. */
  only?: 'git' | 'ssh';
}

const gitOnly = (entries: SettingsSearchEntry[]): ProjectSearchEntry[] =>
  entries.map((entry) => ({ ...entry, only: 'git' }));

// What each project's settings page shows; keep it in step with ProjectSettingsPage.
const PROJECT_SEARCH_INDEX: readonly ProjectSearchEntry[] = [
  card('General'),
  ...rows('General', 'Name', 'Color'),
  {
    kind: 'row',
    label: 'Finished workspaces',
    card: 'General',
    keywords: 'prune clean up old stale unused workspaces',
  },
  ...gitOnly([
    card('Branches', 'prune clean up delete old branches'),
    ...rows('Branches', 'Branch prefix', 'Target branch', 'Leftover branches'),
    card('Setup steps', 'workspace setup order commands terminals'),
    card('Quick add', 'workspace setup commands terminals files copy'),
    card('Trash cleanup', 'teardown'),
    card('Commit buttons', 'git shortcut ahead behind merge rebase pull request'),
    ...rows(
      'Commit buttons',
      'Commits ahead (↑N), default branch',
      'Commits ahead (↑N), other branches',
      'Commits behind (↓N)',
      'Push target branch after fast-forward'
    ),
  ]),
  { ...card('SSH workspaces', 'remote local copy rsync'), only: 'ssh' },
  { kind: 'row', label: 'Run Terminal Commands on', card: 'SSH workspaces', only: 'ssh' },
  card('Danger zone'),
  ...rows('Danger zone', 'Delete project'),
];

// Words that find a page even though its title doesn't contain them.
const PAGE_KEYWORDS: Record<string, string> = {
  general: 'preferences',
  agent: 'agent cli presets',
  integrations: 'mcp hooks',
  projects: 'repository repositories folders target branch workspace setup commands scripts',
  git: 'defaults pull request fast-forward push rebase merge',
  actions: 'actions prompts templates',
  automations: 'schedule scheduled cron recurring routines tasks nightly',
  ssh: 'remote server host tmux vm virtual machine container docker sandbox',
  appearance: 'theme colors',
  terminal: 'shell',
  files: 'diff file tree editor',
  voice: 'dictation speech microphone transcription',
  shortcuts: 'keyboard keybindings hotkeys reset',
  license: 'plan subscription',
};

export interface SettingsSearchPage {
  value: string;
  label: string;
}

/** A project, whose settings page search covers too. */
export interface SettingsSearchProject {
  id: string;
  name: string;
  isGit: boolean;
  /** Whether its page shows the SSH workspaces card. */
  showsSsh: boolean;
}

export interface SettingsSearchResult {
  /** Stable key for lists. */
  key: string;
  kind: 'page' | 'project' | 'card' | 'row';
  page: string;
  pageLabel: string;
  /** The page title, card title, or row label that matched. */
  label: string;
  /** Card the result lives in, for context and scrolling; absent for whole pages. */
  card?: string;
  cardId?: string;
  /** The project whose page the result is on. */
  projectId?: string;
}

const MAX_RESULTS = 50;

type ConsiderResult = (
  result: SettingsSearchResult,
  own: string,
  context: string,
  rank: number
) => void;

function projectShows(entry: ProjectSearchEntry, project: SettingsSearchProject): boolean {
  if (entry.only === 'git') return project.isGit;
  if (entry.only === 'ssh') return project.showsSsh;
  return true;
}

/** Offers each project, and the settings on its page, to `consider`. */
function considerProjects(
  consider: ConsiderResult,
  projectsLabel: string,
  projects: readonly SettingsSearchProject[]
) {
  for (const project of projects) {
    consider(
      {
        key: `project:${project.id}`,
        kind: 'project',
        page: 'projects',
        pageLabel: projectsLabel,
        label: project.name,
        projectId: project.id,
      },
      project.name,
      projectsLabel,
      0
    );
    for (const entry of PROJECT_SEARCH_INDEX) {
      if (!projectShows(entry, project)) continue;
      const cardTitle = entry.kind === 'card' ? entry.label : entry.card;
      consider(
        {
          key: `project:${project.id}:${entry.card ?? ''}:${entry.label}`,
          kind: entry.kind,
          page: 'projects',
          pageLabel: project.name,
          label: entry.label,
          card: entry.card,
          cardId: cardTitle ? settingsCardId(cardTitle) : undefined,
          projectId: project.id,
        },
        `${entry.label} ${entry.keywords ?? ''}`,
        `${projectsLabel} ${project.name} ${entry.card ?? ''}`,
        entry.kind === 'card' ? 1 : 2
      );
    }
  }
}

/**
 * Pages, cards, and rows that contain every word of `query`, counting the page
 * and card they sit in. At least one word has to be the result's own, so
 * "terminal font" finds "Font size" in the Terminal card, but "terminal" alone
 * doesn't list every row in that card.
 */
export function searchSettings(
  query: string,
  pages: readonly SettingsSearchPage[],
  platform: string,
  projects: readonly SettingsSearchProject[] = []
): SettingsSearchResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const matches: { result: SettingsSearchResult; rank: number }[] = [];
  const consider: ConsiderResult = (result, own, context, rank) => {
    const ownText = own.toLowerCase();
    const allText = `${ownText} ${context.toLowerCase()}`;
    if (!words.some((word) => ownText.includes(word))) return;
    if (!words.every((word) => allText.includes(word))) return;
    // Labels that start with the query outrank ones that only contain it.
    const prefix = result.label.toLowerCase().startsWith(words[0]);
    matches.push({ result, rank: prefix ? rank : rank + 0.5 });
  };

  for (const page of pages) {
    consider(
      {
        key: page.value,
        kind: 'page',
        page: page.value,
        pageLabel: page.label,
        label: page.label,
      },
      `${page.label} ${PAGE_KEYWORDS[page.value] ?? ''}`,
      '',
      0
    );
    for (const entry of SETTINGS_SEARCH_INDEX[page.value] ?? []) {
      if (entry.platforms && !entry.platforms.includes(platform)) continue;
      const cardTitle = entry.kind === 'card' ? entry.label : entry.card;
      consider(
        {
          key: `${page.value}:${entry.card ?? ''}:${entry.label}`,
          kind: entry.kind,
          page: page.value,
          pageLabel: page.label,
          label: entry.label,
          card: entry.card,
          cardId: cardTitle ? settingsCardId(cardTitle) : undefined,
        },
        `${entry.label} ${entry.keywords ?? ''}`,
        `${page.label} ${entry.card ?? ''}`,
        entry.kind === 'card' ? 1 : 2
      );
    }
  }

  const projectsPage = pages.find((page) => page.value === 'projects');
  if (projectsPage) considerProjects(consider, projectsPage.label, projects);

  return matches
    .sort((a, b) => a.rank - b.rank)
    .map(({ result }) => result)
    .slice(0, MAX_RESULTS);
}

/** Splits `text` into runs, flagging the parts that match a word of `query`. */
export function highlightMatches(text: string, query: string): { text: string; match: boolean }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  const marked = Array.from({ length: text.length }, () => false);
  for (const word of words) {
    let index = lower.indexOf(word);
    while (index !== -1) {
      marked.fill(true, index, index + word.length);
      index = lower.indexOf(word, index + word.length);
    }
  }
  const runs: { text: string; match: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs.at(-1);
    if (last && last.match === marked[i]) last.text += text[i];
    else runs.push({ text: text[i], match: marked[i] });
  }
  return runs;
}
