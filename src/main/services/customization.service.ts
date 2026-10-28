import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

import { BrowserWindow } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { DEFAULT_TERMINAL_CONFIG } from '../../shared/constants/terminal';
import {
  CUSTOM_PALETTE_ID,
  DEFAULT_ACCENT,
  DEFAULT_LIGHT_ACCENT,
  DEFAULT_PALETTE_ID,
  LIGHT_PALETTE_ID,
  themeChoice,
  themeMode,
} from '../../shared/lib/appearance';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { migrate } from '../lib/migration';

import { MultiFileWatcher } from './file-watcher';
import { getKomlaBasePath } from './paths';
import { windowService } from './window.service';

import type {
  AppearanceSettings,
  ThemeConfig,
  TerminalColorConfig,
  TerminalConfig,
} from '../../shared/types';

export type { ThemeConfig, TerminalColorConfig, TerminalConfig };

/** An update whose nested objects merge key by key into the current config. */
export type ConfigUpdate<T> = {
  [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K];
};

const THEME_VERSION = 1;
const THEME_MIGRATIONS: Record<number, (data: Record<string, unknown>) => Record<string, unknown>> =
  {};

const TERMINAL_VERSION = 1;
const TERMINAL_MIGRATIONS: Record<
  number,
  (data: Record<string, unknown>) => Record<string, unknown>
> = {};

/**
 * Convert an OKLCH color string to an ANSI true-color escape sequence.
 * Falls back to a default blue if parsing fails.
 */
function oklchToAnsi(oklchStr: string): string {
  const match = oklchStr.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (!match) return '\x1b[38;2;100;149;237m'; // fallback: cornflower blue

  const L = parseFloat(match[1]);
  const C = parseFloat(match[2]);
  const h = parseFloat(match[3]) * (Math.PI / 180);

  // OKLCH → OKLab
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  // OKLab → linear sRGB
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;
  const lr = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const lg = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const lb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  // Linear sRGB → sRGB (gamma)
  const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  const clamp = (x: number) => Math.max(0, Math.min(255, Math.round(gamma(x) * 255)));

  return `\x1b[38;2;${clamp(lr)};${clamp(lg)};${clamp(lb)}m`;
}

// The custom theme's accent while the theme, or the light theme while following the system, is
// the custom theme.
function customThemeAccent(theme: ThemeConfig): string | undefined {
  if (theme.palette === CUSTOM_PALETTE_ID) return theme.colors.accent;
  if (theme.followSystem && theme.lightPalette === CUSTOM_PALETTE_ID) {
    return theme.colors.lightAccent;
  }
  return undefined;
}

// Removing or replacing the custom theme moves a slot still on it back to that slot's Komla theme,
// so neither the theme nor the light theme is left on a missing custom theme or one of the wrong
// mode.
function withoutStaleCustomTheme(theme: ThemeConfig): ThemeConfig {
  const mode = theme.customPalette?.mode;
  let next = theme;
  if (
    theme.palette === CUSTOM_PALETTE_ID &&
    (mode === undefined || (theme.followSystem && mode !== 'dark'))
  ) {
    next = {
      ...next,
      palette: DEFAULT_PALETTE_ID,
      colors: { ...next.colors, accent: DEFAULT_ACCENT },
    };
  }
  if (theme.lightPalette === CUSTOM_PALETTE_ID && mode !== 'light') {
    next = {
      ...next,
      lightPalette: LIGHT_PALETTE_ID,
      colors: { ...next.colors, lightAccent: DEFAULT_LIGHT_ACCENT },
    };
  }
  return next;
}

const DEFAULT_THEME: ThemeConfig = {
  mode: 'dark',
  palette: 'default',
  followSystem: false,
  lightPalette: LIGHT_PALETTE_ID,
  colors: {
    accent: DEFAULT_ACCENT,
    lightAccent: DEFAULT_LIGHT_ACCENT,
  },
  typography: {
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    fontSize: 14,
    borderRadius: 10,
  },
};

const README_CONTENT = `# Komla Settings

This folder contains customization settings for Komla.
Open Workspace from Komla Settings to edit these files manually or with an AI assistant.

## ⚠️ Important: Do Not Delete Files

**Never delete files in this folder - only edit them.**

The application expects these files to exist. If you want to reset settings to defaults,
copy the contents from the \`defaults/\` folder instead of deleting files.

## Quick Commands for AI

The AI can edit one file or multiple files together in a single request.

Tell the AI assistant things like:
- "Give Komla a retro-futuristic Fallout theme for both UI and terminal"
- "Make everything cozy for night coding with warmer colors and softer contrast"
- "Use Fira Code at 16 and rebalance spacing so everything still feels compact"
- "Suggest better shortcuts for pane splitting and tab navigation"
- "Propose three shortcut layouts optimized for laptop keyboards"
- "Create a quick command named Bug Scan with grounding rules"
- "Update my PR review quick command to compare changes against {{target_branch}}"
- "Reset to defaults" (copy from defaults/ folder)

## Folder Structure

\`\`\`
settings/
├── theme.json          # Your current theme settings
├── terminal.json       # Your current terminal settings
├── shortcuts.json      # Your keyboard shortcuts
├── actions.json        # Your quick commands (Saved Prompts and Terminal Commands)
├── status-items.json   # Your custom status bar items (commands run on an interval)
├── hooks.json          # Commands run on agent and workspace events, or on a timer
├── README.md           # This documentation
├── AGENTS.md           # AI context (open standard)
├── GEMINI.md           # AI context for Gemini CLI
├── CLAUDE.md           # AI context for Claude Code
└── defaults/           # Default settings (read-only reference)
    ├── theme.json      # Default theme - copy to reset
    ├── terminal.json   # Default terminal - copy to reset
    ├── shortcuts.json  # Default shortcuts - copy to reset
    └── actions.json    # Default quick commands - copy to reset
\`\`\`

## Resetting to Defaults

To reset settings to defaults, copy the files from the \`defaults/\` folder:
- Copy \`defaults/theme.json\` to \`theme.json\` to reset theme
- Copy \`defaults/terminal.json\` to \`terminal.json\` to reset terminal
- Copy \`defaults/shortcuts.json\` to \`shortcuts.json\` to reset shortcuts
- Copy \`defaults/actions.json\` to \`actions.json\` to reset quick commands

## Files

### theme.json

Controls the application's visual appearance. See \`defaults/theme.json\` for all available properties and their default values.

Colors use the OKLCH color space: \`"oklch(L C H)"\`
- **L** (Lightness): 0-1, where 0 is black and 1 is white
- **C** (Chroma): 0-0.4, color intensity (0 = gray, higher = more vibrant)
- **H** (Hue): 0-360, the color angle (0/360 = red, 120 = green, 240 = blue)

Color examples: \`"oklch(0.65 0.15 250)"\` (blue), \`"oklch(0.65 0.15 142)"\` (green), \`"oklch(0.60 0.18 300)"\` (purple)

### terminal.json

Controls the terminal emulator appearance. See \`defaults/terminal.json\` for all available properties and their default values.

**Popular Terminal Fonts:** Menlo, Fira Code, JetBrains Mono, SF Mono, Cascadia Code

### shortcuts.json

Controls keyboard shortcuts. Use "Cmd" in the config file - it becomes the Meta key (⌘) on Mac and Ctrl on Windows/Linux.

| Action | Default | Description |
|--------|---------|-------------|
| workspace.next | Cmd+ArrowDown | Switch to next running workspace |
| workspace.previous | Cmd+ArrowUp | Switch to previous running workspace |
| workspace.select.1-9 | Cmd+1-9 | Jump to workspace by position |
| workspace.new | Cmd+N | Open new workspace dialog |
| workspace.openFolder | Cmd+O (macOS), unbound (Windows/Linux) | Open a folder as a workspace |
| workspace.overview | Cmd+Shift+O | Show workspace overview |
| diff.toggle | Cmd+Shift+G (macOS), Cmd+Shift+D (Windows/Linux) | Toggle diff viewer |
| history.toggle | Cmd+Shift+H | Toggle commit history |
| pane.close | Cmd+W (macOS), Cmd+Alt+W (Windows/Linux) | Close current pane |
| pane.splitRight | Cmd+D (macOS), Cmd+\\ (Windows/Linux) | Split pane vertically |
| pane.splitDown | Cmd+Shift+D (macOS), Cmd+Shift+\\ (Windows/Linux) | Split pane horizontally |
| pane.focusNext | Cmd+K | Focus next pane |
| pane.focusPrev | Cmd+J | Focus previous pane |
| terminal.new | Cmd+T | New terminal in workspace |
| tab.next | Cmd+Shift+] | Switch to next tab |
| tab.previous | Cmd+Shift+[ | Switch to previous tab |
| file.open | DoubleTap+Shift | Open file search |
| file.tree | Cmd+Shift+E | Toggle file tree |
| terminal.scrollToBottom | Cmd+Shift+ArrowDown | Scroll terminal to bottom |
| terminal.search | Cmd+F | Open terminal search |
| newWorkspace.cycleAgent | Ctrl+Tab (macOS), Cmd+. (Windows/Linux) | Next agent, in the new workspace dialog |
| newWorkspace.cycleLaunchMode | Shift+Tab | Next launch mode, from the dialog's prompt |
| newWorkspace.cycleEffort, cycleProject, cycleEnvironment | unbound | Next effort level, project or environment, in the dialog |
| newWorkspace.agentMenu, effortMenu, environmentMenu, branchMenu, projectSearch | unbound | Open that menu, in the dialog |

\`newWorkspace.*\` shortcuts act only in the new workspace dialog, so they can reuse keys used elsewhere, and may use Shift+Tab. In the dialog, the \`workspace.select.1-9\` keys pick a project. An empty string (\`""\`) leaves an action unbound.

**Note:** \`workspace.next\` and \`workspace.previous\` only cycle through running workspaces (not stopped ones). Use \`Cmd+1-9\` to jump to any workspace by position.

**🌍 International Keyboard Layouts**

On first run, Komla detects your keyboard layout. For non-US layouts (AZERTY, QWERTZ, Nordic, etc.), different defaults are used because brackets and backslash are hard to access. macOS split-pane shortcuts stay on Cmd+D / Cmd+Shift+D because D is layout-friendly:

| US Default | International Default |
|------------|----------------------|
| Cmd+[ / Cmd+] | Cmd+, / Cmd+. |
| Cmd+\\ | Cmd+/ |
| Cmd+Shift+[ / Cmd+Shift+] | Cmd+Shift+, / Cmd+Shift+. |
| Cmd+Shift+\\ | Cmd+Shift+/ |

Your actual defaults are in \`shortcuts.json\`. The \`defaults/shortcuts.json\` file shows the platform/layout-aware defaults created on first run.

**⚠️ Avoid Terminal Conflicts**

When customizing shortcuts, avoid key combinations that conflict with common terminal input:
- \`Ctrl+C\` (interrupt/SIGINT)
- \`Ctrl+D\` (EOF/logout)
- \`Ctrl+Z\` (suspend)
- \`Ctrl+L\` (clear screen)
- \`Ctrl+R\` (reverse search)
- \`Ctrl+A/E\` (line navigation)

The default shortcuts use \`Cmd\` (Meta on Mac, Ctrl on Windows) specifically to avoid these conflicts on macOS. On Windows/Linux, the defaults may conflict with some terminal operations.

**Example customization:**
\`\`\`json
{
  "shortcuts": {
    "workspace.next": "Cmd+]",
    "workspace.previous": "Cmd+[",
    "diff.toggle": "Cmd+Shift+D"
  }
}
\`\`\`

### actions.json

Stores reusable quick commands (Saved Prompts and Terminal Commands) shown when creating workspaces.

Create or edit quick commands in the app via:
- \`Settings → Quick Commands → New quick command\` — built-in editor
- \`Settings → Quick Commands → Create with AI\` — describe what you need, AI writes the quick command

Supported placeholders:
- \`{{user_input}}\` — prompts for text input at launch time (e.g., ticket number, topic)
- \`{{target_branch}}\` — resolves to the workspace/project target branch when available

**Quick command types:**
- \`"prompt"\` (default) — Saved Prompt; the content is sent to the AI agent when the workspace launches
- \`"command"\` — Terminal Command; the content is executed as a raw command (no AI agent involved)

Full example with all supported fields:
\`\`\`json
{
  "actions": [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "type": "prompt",
      "title": "PR Review",
      "content": "Review the changes in this workspace against {{target_branch}}. Summarise what changed and flag any concerns.",
      "projectIds": [],
      "order": 0,
      "lastUsedAt": null
    },
    {
      "id": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
      "type": "command",
      "title": "Ticket Investigation",
      "content": "Investigate issue {{user_input}} and propose a fix. Start by searching for relevant code.",
      "projectIds": [],
      "order": 1,
      "lastUsedAt": null
    }
  ]
}
\`\`\`

Field reference:
- \`id\` — unique UUID (generate one or let the app create it)
- \`type\` — \`"prompt"\` for a Saved Prompt or \`"command"\` for a Terminal Command
- \`title\` — short label shown in menus
- \`content\` — the prompt text sent to the agent, or the terminal command to run
- \`projectIds\` — array of project IDs this quick command is scoped to (empty array = available everywhere)
- \`order\` — display order (lower numbers appear first)
- \`lastUsedAt\` — ISO timestamp updated automatically when the quick command is used
- \`lastUserInput\` — last value the user entered for \`{{user_input}}\`, auto-managed

Quick AI commands for this file:
- "Create a quick command for reviewing security vulnerabilities in new code"
- "Add a quick command that asks for a {{user_input}} ticket number and writes a focused branch review"

Changes to these files are applied immediately — no restart required!
`;

const AGENTS_CONTENT = `# Komla Settings — AI Context

You are operating inside the Komla settings directory. This folder contains JSON configuration files that control the appearance and behaviour of the Komla application.

## Important Rules

- **Never delete files** — only edit them. The application expects all files to exist.
- To reset a file to its defaults, copy the contents from the \`defaults/\` folder.
- Changes are applied immediately — no restart required.
- Komla records every change to these files. The user can revert any of them from Settings → General → Settings history, so tell them your change can be undone there.

## Files

### theme.json

Controls the application's visual appearance. Read \`defaults/theme.json\` to see the full schema and all available properties. Colors use the OKLCH color space: \`"oklch(L C H)"\` where L=lightness (0-1), C=chroma (0-0.4), H=hue (0-360).

### terminal.json

Controls the terminal emulator appearance. Read \`defaults/terminal.json\` to see the full schema and all available properties.

### shortcuts.json

Controls keyboard shortcuts. Use "Cmd" in the config — it maps to ⌘ on Mac and Ctrl on Windows/Linux.

| Action | Default | Description |
|--------|---------|-------------|
| workspace.next | Cmd+ArrowDown | Switch to next running workspace |
| workspace.previous | Cmd+ArrowUp | Switch to previous running workspace |
| workspace.select.1-9 | Cmd+1-9 | Jump to workspace by position |
| workspace.new | Cmd+N | Open new workspace dialog |
| workspace.openFolder | Cmd+O (macOS), unbound (Windows/Linux) | Open a folder as a workspace |
| workspace.overview | Cmd+Shift+O | Show workspace overview |
| diff.toggle | Cmd+Shift+G (macOS), Cmd+Shift+D (Windows/Linux) | Toggle diff viewer |
| history.toggle | Cmd+Shift+H | Toggle commit history |
| pane.close | Cmd+W (macOS), Cmd+Alt+W (Windows/Linux) | Close current pane |
| pane.splitRight | Cmd+D (macOS), Cmd+\\ (Windows/Linux) | Split pane vertically |
| pane.splitDown | Cmd+Shift+D (macOS), Cmd+Shift+\\ (Windows/Linux) | Split pane horizontally |
| pane.focusNext | Cmd+K | Focus next pane |
| pane.focusPrev | Cmd+J | Focus previous pane |
| terminal.new | Cmd+T | New terminal in workspace |
| tab.next | Cmd+Shift+] | Switch to next tab |
| tab.previous | Cmd+Shift+[ | Switch to previous tab |
| file.open | DoubleTap+Shift | Open file search |
| file.tree | Cmd+Shift+E | Toggle file tree |
| terminal.scrollToBottom | Cmd+Shift+ArrowDown | Scroll terminal to bottom |
| terminal.search | Cmd+F | Open terminal search |
| newWorkspace.cycleAgent | Ctrl+Tab (macOS), Cmd+. (Windows/Linux) | Next agent, in the new workspace dialog |
| newWorkspace.cycleLaunchMode | Shift+Tab | Next launch mode, from the dialog's prompt |
| newWorkspace.cycleEffort, cycleProject, cycleEnvironment | unbound | Next effort level, project or environment, in the dialog |
| newWorkspace.agentMenu, effortMenu, environmentMenu, branchMenu, projectSearch | unbound | Open that menu, in the dialog |

\`newWorkspace.*\` shortcuts act only in the new workspace dialog, so they can reuse keys used elsewhere, and may use Shift+Tab. In the dialog, the \`workspace.select.1-9\` keys pick a project. An empty string (\`""\`) leaves an action unbound.

Avoid key combinations that conflict with terminal signals: Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L, Ctrl+R, Ctrl+A/E.

### actions.json

Stores reusable quick commands (Saved Prompts and Terminal Commands) shown when creating workspaces.

**Quick command types:**
- \`"prompt"\` (default) — Saved Prompt; the content is sent to the AI agent when the workspace launches
- \`"command"\` — Terminal Command; the content is executed as a raw command (no AI agent involved)

Supported placeholders:
- \`{{user_input}}\` — prompts the user for text input at workspace launch
- \`{{target_branch}}\` — resolves to the workspace/project target branch

Schema — full example with both types:
\`\`\`json
{
  "actions": [
    {
      "id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      "type": "prompt",
      "title": "PR Review",
      "content": "Review the changes in this workspace against {{target_branch}}.",
      "projectIds": [],
      "order": 0,
      "lastUsedAt": null
    },
    {
      "id": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
      "type": "command",
      "title": "Run Tests",
      "content": "npm test",
      "projectIds": [],
      "order": 1,
      "lastUsedAt": null
    }
  ]
}
\`\`\`

Field reference:
- \`id\` — unique UUID (generate one or let the app create it)
- \`type\` — \`"prompt"\` for a Saved Prompt or \`"command"\` for a Terminal Command
- \`title\` — short label shown in menus
- \`content\` — the prompt text sent to the agent, or the terminal command to run
- \`projectIds\` — array of project IDs this quick command is scoped to (empty array = available everywhere)
- \`order\` — display order (lower numbers appear first)
- \`lastUsedAt\` — ISO timestamp, updated automatically (do not set manually)
- \`lastUserInput\` — last value the user entered for \`{{user_input}}\`, auto-managed (do not set manually)

**How to create or edit quick commands:**
1. Read the current \`actions.json\` file
2. Parse the JSON to get the existing \`actions\` array
3. Append a new quick command object (or edit an existing one) — generate a new UUID for the \`id\`
4. Write the full JSON back to \`actions.json\`

### status-items.json

Defines custom status bar items: commands Komla runs on an interval in the open workspace, locally in its folder or on its SSH host, or with \`runOn: "local"\` on this computer for every workspace, whose output becomes the item.

Komla also has built-in items, such as the branch's pull request with its CI checks (it can notify the workspace when CI finishes), Claude Code and Codex plan usage, the commit graph or resource usage; the user turns them on from the status bar's right-click menu. Suggest a built-in item when one shows what the user asks for, and write an item here when none does.

\`\`\`json
{
  "_version": 1,
  "items": [
    {
      "id": "pr",
      "command": "gh pr view --json number,url --jq '{text: \\"PR #\\\\(.number)\\", link: .url}'",
      "intervalSeconds": 120,
      "label": "Pull request",
      "projects": ["komla"]
    }
  ]
}
\`\`\`

Field reference:
- \`id\` — up to 40 letters, digits, dots, dashes and underscores; unique in the file
- \`command\` — run with the user's shell; plain output shows its first line, with the rest as the tooltip, or print JSON \`{"text", "tone", "tooltip", "link"}\` where \`tone\` is \`success\`, \`warning\`, \`error\` or \`info\` and \`link\` an http(s) URL the item opens; empty output hides the item
- \`intervalSeconds\` — how often it runs while the workspace is open, 10 or more (default 60); \`komla status refresh <id>\`, as from a hook, runs it again at once
- \`timeoutSeconds\` — how long the command and popover command may run, 1 to 600 (default 15)
- \`runOn\` — \`workspace\` (default) runs it where the workspace's files are; \`local\` runs it on this computer in the home folder, showing the same output in every workspace, for items that don't depend on the workspace
- \`label\` — shown in place of the output while the command fails
- \`projects\` — project names or ids it runs in; leave it out to run in every workspace

At most 30 items. A file Komla can't read shows a warning item in the status bar saying what is wrong. Agents can also set an item for their own workspace without this file: \`komla status set <id> <text>\`.

### hooks.json

Commands Komla runs when something happens in a workspace, or on an interval: in the workspace's folder or on its SSH host, or once on this computer.

\`\`\`json
{
  "_version": 1,
  "hooks": [
    {
      "id": "lint-after-turn",
      "event": "agent.done",
      "command": "if npm run lint --silent; then komla status set lint 'Lint passes' --tone success; else komla status set lint 'Lint fails' --tone error; fi",
      "timeoutSeconds": 120,
      "projects": ["komla"]
    }
  ]
}
\`\`\`

Field reference:
- \`id\` — up to 40 letters, digits, dots, dashes and underscores; unique in the file
- \`event\` — \`agent.done\` (an agent finished its turn), \`agent.needs-input\` (it asks for permission or an answer), \`agent.error\` (it reported an error), \`agent.prompt\` (a prompt was sent to it), \`workspace.created\` (a new workspace's terminals started and it has its name; setup steps may still be running), \`workspace.trashed\` (it moved to the Trash) or \`interval\` (on a timer)
- \`intervalSeconds\` — \`interval\` hooks only: how often they run, 10 to 86,400; also when Komla starts and after this file changes, a few at a time
- \`runOn\` — \`workspace\` (default) runs it in the workspace's folder, so an \`interval\` hook runs in every workspace outside the Trash; \`local\` runs it on this computer in the home folder, once for an \`interval\` hook. Scripts act on other workspaces with \`komla workspace list --json\` and \`--workspace <id>\`
- \`command\` — run with the user's shell, which has the \`komla\` CLI, such as \`komla tag "CI running" --spinner\`, which keeps a tag on the card until it's replaced (a new tag joins the user's list); output is discarded, and its own notifications set off no hooks. It gets \`KOMLA_EVENT\`, \`KOMLA_HOOK_ID\`, and for a workspace \`KOMLA_WORKSPACE_ID\`, \`KOMLA_WORKSPACE_NAME\`, \`KOMLA_BRANCH\`, \`KOMLA_PROJECT\`, and for agent events \`KOMLA_TERMINAL_ID\`, \`KOMLA_AGENT\` and \`KOMLA_MESSAGE\` (the agent's last answer, what it asks for, or the prompt, up to 4,000 characters) when Komla has them
- \`timeoutSeconds\` — how long it may run, 1 to 3,600 (default 60); past it, Komla stops the hook and everything it started
- \`projects\` — project names or ids it runs in; leave it out to run in every workspace

At most 50 hooks. A hook still running for a terminal isn't started again for it. Komla says once why a hook failed in a workspace or why it can't read the file, until that's fixed.
`;

function buildWelcomeContent(accentColor: string): string {
  const a = oklchToAnsi(accentColor);
  const ab = '\x1b[1m' + oklchToAnsi(accentColor);
  const r = '\x1b[0m';
  const d = '\x1b[90m';
  const di = '\x1b[3;90m';

  return `
  ${ab}Komla Settings${r}
  ${d}Edit the files directly or describe what you want.${r}

  ${a}▸${r} ${ab}Styling${r}
    ${di}"Fallout-style terminal + UI theme"${r}
    ${di}"Cozy late-night coding with warm colors"${r}

  ${a}▸${r} ${ab}Shortcuts${r}
    ${di}"Shortcuts for pane and tab navigation"${r}
    ${di}"Alternative layouts for a Norwegian keyboard"${r}

  ${a}▸${r} ${ab}Quick Commands${r}  ${d}Saved Prompts & Terminal Commands${r}
    ${di}"Standup summary quick command using {{user_input}}"${r}
    ${di}"Terminal Command that runs 'npm test'"${r}

  ${a}▸${r} ${ab}Resetting${r}
    ${di}"Reset my theme to defaults"${r}

  ${d}Changes apply immediately · See README.md for details${r}

`;
}

class CustomizationService {
  private settingsPath: string;
  private themePath: string;
  private terminalPath: string;
  private readmePath: string;
  private welcomePath: string;
  private agentsMdPath: string;
  private geminiMdPath: string;
  private claudeMdPath: string;
  private defaultsPath: string;
  private defaultThemePath: string;
  private defaultTerminalPath: string;
  private watcher: MultiFileWatcher | null = null;
  private theme: ThemeConfig;
  private terminal: TerminalConfig;
  private initialized = false;
  private themeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private terminalDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SAVE_DEBOUNCE_MS = 500;

  constructor() {
    this.settingsPath = join(getKomlaBasePath(), 'settings');
    this.themePath = join(this.settingsPath, 'theme.json');
    this.terminalPath = join(this.settingsPath, 'terminal.json');
    this.readmePath = join(this.settingsPath, 'README.md');
    this.welcomePath = join(this.settingsPath, 'WELCOME');
    this.agentsMdPath = join(this.settingsPath, 'AGENTS.md');
    this.geminiMdPath = join(this.settingsPath, 'GEMINI.md');
    this.claudeMdPath = join(this.settingsPath, 'CLAUDE.md');
    this.defaultsPath = join(this.settingsPath, 'defaults');
    this.defaultThemePath = join(this.defaultsPath, 'theme.json');
    this.defaultTerminalPath = join(this.defaultsPath, 'terminal.json');

    this.ensureSettingsDirectory();
    this.theme = this.loadTheme();
    this.terminal = this.loadTerminal();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.startWatcher();
  }

  private ensureSettingsDirectory(): void {
    // Create settings directory
    if (!existsSync(this.settingsPath)) {
      mkdirSync(this.settingsPath, { recursive: true });
    }

    // Create presets directory
    const presetsPath = join(this.settingsPath, 'presets');
    if (!existsSync(presetsPath)) {
      mkdirSync(presetsPath, { recursive: true });
    }

    // Create defaults directory
    if (!existsSync(this.defaultsPath)) {
      mkdirSync(this.defaultsPath, { recursive: true });
    }
    if (!existsSync(this.defaultThemePath)) {
      writeFileSync(this.defaultThemePath, JSON.stringify(DEFAULT_THEME, null, 2), 'utf-8');
    }
    if (!existsSync(this.defaultTerminalPath)) {
      writeFileSync(
        this.defaultTerminalPath,
        JSON.stringify(DEFAULT_TERMINAL_CONFIG, null, 2),
        'utf-8'
      );
    }

    // Write default theme if not exists
    if (!existsSync(this.themePath)) {
      this.writeTheme(DEFAULT_THEME);
    }

    // Write default terminal config if not exists
    if (!existsSync(this.terminalPath)) {
      this.writeTerminal(DEFAULT_TERMINAL_CONFIG);
    }

    // Write docs/context files on first run only.
    if (!existsSync(this.readmePath)) {
      writeFileSync(this.readmePath, README_CONTENT, 'utf-8');
    }
    if (!existsSync(this.welcomePath)) {
      const accentColor = this.readAccentColor();
      writeFileSync(this.welcomePath, buildWelcomeContent(accentColor), 'utf-8');
    }
    if (!existsSync(this.agentsMdPath)) {
      writeFileSync(this.agentsMdPath, AGENTS_CONTENT, 'utf-8');
    }
    if (!existsSync(this.geminiMdPath)) {
      writeFileSync(this.geminiMdPath, AGENTS_CONTENT, 'utf-8');
    }
    if (!existsSync(this.claudeMdPath)) {
      writeFileSync(this.claudeMdPath, AGENTS_CONTENT, 'utf-8');
    }
  }

  private readAccentColor(): string {
    try {
      if (existsSync(this.themePath)) {
        const data = readFileSync(this.themePath, 'utf-8');
        const parsed = JSON.parse(data);
        if (typeof parsed?.colors?.accent === 'string') {
          return parsed.colors.accent;
        }
      }
    } catch {
      /* ignore */
    }
    return DEFAULT_THEME.colors.accent;
  }

  private loadTheme(): ThemeConfig {
    try {
      if (existsSync(this.themePath)) {
        const data = readFileSync(this.themePath, 'utf-8');
        const { _version: _v, ...rest } = migrate(
          JSON.parse(data) as Record<string, unknown>,
          THEME_VERSION,
          THEME_MIGRATIONS
        );
        return this.mergeWithDefaults(rest as Partial<ThemeConfig>, DEFAULT_THEME);
      }
    } catch (error) {
      console.error('Failed to load theme config:', error);
    }
    return { ...DEFAULT_THEME };
  }

  private loadTerminal(): TerminalConfig {
    try {
      if (existsSync(this.terminalPath)) {
        const data = readFileSync(this.terminalPath, 'utf-8');
        const { _version: _v, ...rest } = migrate(
          JSON.parse(data) as Record<string, unknown>,
          TERMINAL_VERSION,
          TERMINAL_MIGRATIONS
        );
        return this.mergeWithDefaults(rest as Partial<TerminalConfig>, DEFAULT_TERMINAL_CONFIG);
      }
    } catch (error) {
      console.error('Failed to load terminal config:', error);
    }
    return { ...DEFAULT_TERMINAL_CONFIG };
  }

  private mergeWithDefaults<T extends object>(partial: ConfigUpdate<T>, defaults: T): T {
    const result = { ...defaults };
    for (const key in partial) {
      if (partial[key] !== undefined) {
        const defaultVal = defaults[key];
        if (
          typeof partial[key] === 'object' &&
          partial[key] !== null &&
          !Array.isArray(partial[key]) &&
          typeof defaultVal === 'object' &&
          defaultVal !== null &&
          !Array.isArray(defaultVal)
        ) {
          result[key] = this.mergeWithDefaults(
            partial[key] as object,
            defaultVal as object
          ) as T[Extract<keyof T, string>];
        } else {
          result[key] = partial[key] as T[Extract<keyof T, string>];
        }
      }
    }
    return result;
  }

  private writeTheme(theme: ThemeConfig): void {
    // Debounce writes to prevent cascading freezes during rapid updates
    if (this.themeDebounceTimer) {
      clearTimeout(this.themeDebounceTimer);
    }
    this.themeDebounceTimer = setTimeout(() => {
      try {
        writeFileAtomicSync(
          this.themePath,
          JSON.stringify({ _version: THEME_VERSION, ...theme }, null, 2)
        );
      } catch (error) {
        console.error('Failed to write theme config:', error);
      }
    }, this.SAVE_DEBOUNCE_MS);
  }

  private writeTerminal(terminal: TerminalConfig): void {
    // Debounce writes to prevent cascading freezes during rapid updates
    if (this.terminalDebounceTimer) {
      clearTimeout(this.terminalDebounceTimer);
    }
    this.terminalDebounceTimer = setTimeout(() => {
      try {
        writeFileAtomicSync(
          this.terminalPath,
          JSON.stringify({ _version: TERMINAL_VERSION, ...terminal }, null, 2)
        );
      } catch (error) {
        console.error('Failed to write terminal config:', error);
      }
    }, this.SAVE_DEBOUNCE_MS);
  }

  private async startWatcher(): Promise<void> {
    this.watcher = new MultiFileWatcher([this.themePath, this.terminalPath], (path) => {
      if (
        path === this.themePath ||
        path.endsWith('/theme.json') ||
        path.endsWith('\\theme.json')
      ) {
        const newTheme = this.loadTheme();
        this.theme = newTheme;
        this.notifyRenderer(IPC.CUSTOMIZATION_THEME_CHANGED, newTheme);
        this.syncTitleBarOverlay();
      } else if (
        path === this.terminalPath ||
        path.endsWith('/terminal.json') ||
        path.endsWith('\\terminal.json')
      ) {
        const newTerminal = this.loadTerminal();
        this.terminal = newTerminal;
        this.notifyRenderer(IPC.CUSTOMIZATION_TERMINAL_CHANGED, newTerminal);
      }
    });
    await this.watcher.start();
  }

  private notifyRenderer(channel: string, data: unknown): void {
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, data);
      }
    }
  }

  // Public API

  getTheme(): ThemeConfig {
    return { ...this.theme };
  }

  getTerminal(): TerminalConfig {
    return JSON.parse(JSON.stringify(this.terminal));
  }

  updateTheme(updates: ConfigUpdate<ThemeConfig>): ThemeConfig {
    this.theme = this.withCustomAccentSaved(this.mergeWithDefaults(updates, this.theme));
    this.writeTheme(this.theme);
    return this.getTheme();
  }

  /**
   * Replaces the theme, accent and corner radius. A customPalette left out is removed. With
   * followSystem, a light theme and its accent replace the light theme, and any other the dark one.
   */
  setAppearance({ palette, customPalette, accent, borderRadius }: AppearanceSettings): ThemeConfig {
    const { customPalette: _previous, ...theme } = this.theme;
    this.theme = this.withCustomAccentSaved(
      withoutStaleCustomTheme({
        ...theme,
        ...themeChoice(theme, palette, themeMode(palette, customPalette), accent),
        ...(customPalette && { customPalette }),
        typography: { ...theme.typography, borderRadius },
      })
    );
    this.writeTheme(this.theme);
    return this.getTheme();
  }

  // Switching away from the custom theme saves its accent with it, so choosing it again brings
  // the accent back the way a built-in theme does.
  private withCustomAccentSaved(next: ThemeConfig): ThemeConfig {
    const accent = customThemeAccent(this.theme);
    if (
      accent === undefined ||
      customThemeAccent(next) !== undefined ||
      next.customPalette === undefined
    ) {
      return next;
    }
    return { ...next, customPalette: { ...next.customPalette, accent } };
  }

  updateTerminal(updates: ConfigUpdate<TerminalConfig>): TerminalConfig {
    this.terminal = this.mergeWithDefaults(updates, this.terminal);
    this.writeTerminal(this.terminal);
    return this.getTerminal();
  }

  resetTheme(): ThemeConfig {
    // A custom theme is the user's own work, so a reset switches away from it but keeps it.
    const { customPalette } = this.theme;
    this.theme = this.withCustomAccentSaved({
      ...DEFAULT_THEME,
      ...(customPalette && { customPalette }),
    });
    this.writeTheme(this.theme);
    return this.getTheme();
  }

  syncTitleBarOverlay(): void {
    windowService.updateTitleBarOverlay(true);
  }

  async dispose(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
  }
}

export const customizationService = new CustomizationService();
