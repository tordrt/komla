/**
 * Closes a menu in the new workspace dialog back to `target`, usually the
 * prompt, unless the user already moved focus to another control, such as
 * another menu, the project search or the branch name.
 */
export function focusPromptOnMenuClose(event: Event, target: HTMLElement | null): void {
  event.preventDefault();
  const active = document.activeElement;
  if (
    active &&
    active !== document.body &&
    // A click on the dialog's background leaves focus on the dialog itself,
    active.getAttribute('role') !== 'dialog' &&
    // and a click on an open menu's own button closes it and focuses that button.
    !(
      active.getAttribute('aria-haspopup') === 'menu' &&
      active.getAttribute('aria-expanded') === 'false'
    )
  ) {
    return;
  }
  target?.focus();
}
