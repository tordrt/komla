// Windows PowerShell 5.1, PowerShell 7.0-7.2, and PowerShell 7.3+ launching
// .cmd/.bat files pass arguments to native programs without escaping embedded
// double quotes, so the program drops them. Escaping for the C runtime under
// pinned Legacy passing delivers the same argument on every version.

// PowerShell also starts and ends strings at typographic quotes: ‘ ’ ‚ ‛ like ',
// and “ ” „ like ". Doubling escapes any of the single ones, a backtick the double.

export function isPowerShellSingleQuote(character: string): boolean {
  return /^['\u2018-\u201b]$/.test(character);
}

export function isPowerShellDoubleQuote(character: string): boolean {
  return /^["\u201c-\u201e]$/.test(character);
}

/** Escapes text for inside a PowerShell single-quoted string. */
export function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/['\u2018-\u201b]/g, '$&$&');
}

/** Escapes text for inside a PowerShell double-quoted string. */
export function escapePowerShellDoubleQuoted(value: string): string {
  return value.replace(/[`$"\u201c-\u201e]/g, '`$&');
}

/** A PowerShell single-quoted string, which is literal. */
export function powerShellSingleQuote(value: string): string {
  return `'${escapePowerShellSingleQuoted(value)}'`;
}

/** Escapes a native program argument for PowerShell's Legacy argument passing. */
export function escapeNativeArgument(value: string): string {
  let escaped = value.replace(/(\\*)"/g, '$1$1\\"');
  const firstWhitespace = escaped.search(/\s/);
  if (firstWhitespace === -1) return escaped;
  // PowerShell wraps an argument in quotes only when it sees whitespace outside
  // quotes, and older versions may count an escaped quote as a real one.
  const firstQuote = escaped.indexOf('"');
  if (firstQuote !== -1 && firstQuote < firstWhitespace) escaped = ` ${escaped}`;
  // Not every PowerShell version escapes a trailing backslash before the
  // closing quote it adds.
  return escaped.endsWith('\\') ? `${escaped} ` : escaped;
}

/** Runs a PowerShell command with Legacy native argument passing on every version. */
export function withLegacyNativeArguments(command: string): string {
  return `& { $PSNativeCommandArgumentPassing = 'Legacy'; ${command} }`;
}

// CreateProcess limit for a whole Windows command line, in UTF-16 code units.
const MAX_WINDOWS_COMMAND_LINE_LENGTH = 32_767;

/**
 * Arguments that make PowerShell run `script` itself, so it is never typed into
 * the line editor. Returns null when the command line would exceed the Windows
 * limit.
 */
export function powerShellCommandArgs(
  shell: string,
  shellArgs: string[],
  script: string
): string[] | null {
  const args = [...shellArgs, '-Command', script];
  // node-pty quotes each argument that has spaces and escapes double quotes
  // and the backslashes before them; this counts those characters generously.
  const commandLineLength = [shell, ...args].reduce(
    (length, arg) => length + arg.length + 3 + (arg.match(/["\\]/g)?.length ?? 0),
    0
  );
  return commandLineLength < MAX_WINDOWS_COMMAND_LINE_LENGTH ? args : null;
}
