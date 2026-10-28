/**
 * Single-quote a string for safe interpolation into a posix shell command line.
 * Embedded single quotes are closed, escaped via "'", then reopened.
 */
export function shellQuotePosix(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Single-quote a string for PowerShell. PowerShell also ends single-quoted
 * strings at typographic single quotes, so every quote character is doubled.
 */
export function shellQuotePowerShell(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
}
