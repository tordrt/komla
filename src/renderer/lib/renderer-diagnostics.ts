import { getTerminalRendererDiagnostics } from './terminal-renderer-runtime';

const REPORT_INTERVAL_MS = 30_000;

let intervalId: ReturnType<typeof setInterval> | null = null;

function collectAndReport(): void {
  const runtime = getTerminalRendererDiagnostics();
  const stats = {
    terminalCacheSize: runtime.runtimeCount,
    parkedTerminalCount: runtime.parkedCount,
    activeWebglContexts: runtime.activeWebglContexts,
    timestamp: Date.now(),
  };

  window.api.reportRendererDiagnostics(stats);
}

export function startRendererDiagnostics(): void {
  if (intervalId) return;
  if (!window.api.isDiagnosticsEnabled) return;

  // Send initial report
  collectAndReport();

  intervalId = setInterval(collectAndReport, REPORT_INTERVAL_MS);
}

export function stopRendererDiagnostics(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}
