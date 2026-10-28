// Single source of truth for agent-name groupings shared across the setup
// wizard, settings, and main-process IPC handlers.

// Agents with a one-click Komla integration. Any other agent relies on the
// self-integration skill instead.
export const AGENTS_WITH_AUTO_INTEGRATIONS = [
  'Claude Code',
  'Codex',
  'Antigravity CLI',
  'OpenCode',
];

// Agents surfaced as recommended/featured in the setup wizard and settings.
export const RECOMMENDED_AGENTS = ['Claude Code', 'Codex'];

// The best-known self-integration agents — shown first within the "Other
// agents" group, ahead of the remaining presets.
export const POPULAR_OTHER_AGENTS = [
  'Grok Build',
  'Cursor CLI',
  'GitHub Copilot CLI',
  'Hermes Agent',
  'Factory Droid',
  'Amp',
  'Mistral Vibe',
  'Pi',
];
