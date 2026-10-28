export function buildTerminalApiUrl(origin: string, terminalId: string): string {
  return `${origin.replace(/\/+$/, '')}/terminals/${encodeURIComponent(terminalId)}`;
}
