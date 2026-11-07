import { shellQuotePosix } from '../../shared/lib/shell-quote';

import { isBashShell, isZshShell } from './shell-kind';

/**
 * A command for an interactive zsh or bash that adds `command` to its history and appends it to
 * `$HISTFILE`, as though the user had typed it. A command passed with `-c` never reaches the line
 * editor, so it's otherwise missing from the history of the shell Komla hands the terminal to.
 * It leaves the history alone where the user turned saving off, and returns null for shells whose
 * history it doesn't know.
 */
export function addToShellHistoryCommand(shell: string, command: string): string | null {
  const quoted = shellQuotePosix(command);
  if (isZshShell(shell)) {
    // -r keeps backslashes as typed; -I appends only the entries this shell hasn't written yet.
    return `{ [ -n "$HISTFILE" ] && [ "\${SAVEHIST:-0}" -gt 0 ] && print -rs -- ${quoted} && fc -AI; } 2>/dev/null`;
  }
  if (isBashShell(shell)) {
    // `set +o history` turns bash's history off, though history -s and -a still work, and a
    // HISTFILESIZE of 0 keeps none of it on disk.
    return `{ [ -n "$HISTFILE" ] && [ -o history ] && [ "\${HISTFILESIZE:-1}" != 0 ] && history -s ${quoted} && history -a; } 2>/dev/null`;
  }
  return null;
}
