/** The Codex hooks Komla's notifications install. */
export const CODEX_NOTIFICATION_HOOK_EVENTS = [
  'Stop',
  'UserPromptSubmit',
  'PermissionRequest',
  'PreToolUse',
  // The only hook an Esc-cancelled turn runs; older Codex ignores it.
  'Interrupt',
] as const;
