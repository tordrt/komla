/** Whether `shell`, a path such as `$SHELL`, is zsh. */
export function isZshShell(shell: string): boolean {
  return shell.endsWith('/zsh') || shell.endsWith('/zsh5');
}

/** Whether `shell`, a path such as `$SHELL`, is bash. */
export function isBashShell(shell: string): boolean {
  return shell.endsWith('/bash');
}
