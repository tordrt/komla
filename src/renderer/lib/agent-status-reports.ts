// One-click agents whose recent versions report their own status (OSC 7501), so the spinner and
// notifications work without their hooks.
const REPORTS_OWN_STATUS: ReadonlySet<string> = new Set(['claude', 'codex', 'antigravity']);

/** Whether agents' status reports reach Komla: it doesn't answer their status query on Windows. */
export function agentStatusReportsWork(): boolean {
  return window.api.platform !== 'win32';
}

/** Whether the agent tells Komla when it works, finishes or needs you without hooks. */
export function reportsOwnStatus(agent: string | null | undefined): boolean {
  return !!agent && agentStatusReportsWork() && REPORTS_OWN_STATUS.has(agent);
}
