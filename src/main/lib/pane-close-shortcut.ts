import { IPC } from '../../shared/constants/ipc-channels';

import type { DevPreviewTabRef } from '../../shared/types/dev-preview';
import type { Input, WebContents } from 'electron';

type ShortcutInput = Pick<Input, 'key' | 'control' | 'meta' | 'alt' | 'shift'>;
type ShortcutEvent = { preventDefault: () => void };
type ShortcutTarget = Pick<WebContents, 'isDestroyed' | 'send'>;
type FocusableShortcutTarget = Pick<WebContents, 'focus' | 'isDestroyed' | 'send'>;

export function shortcutMatchesInput(shortcut: string | undefined, input: ShortcutInput): boolean {
  if (!shortcut || shortcut.startsWith('DoubleTap+')) return false;

  const parts = shortcut.split('+');
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((mod) => mod.toLowerCase());
  const isMac = process.platform === 'darwin';
  const wantsCmd = modifiers.includes('cmd');
  const wantsControl = modifiers.includes('ctrl') || (!isMac && wantsCmd);
  const wantsMeta = modifiers.includes('meta') || (isMac && wantsCmd);

  return (
    key.toLowerCase() === input.key.toLowerCase() &&
    wantsControl === !!input.control &&
    wantsMeta === !!input.meta &&
    modifiers.includes('alt') === !!input.alt &&
    modifiers.includes('shift') === !!input.shift
  );
}

/** `page` names the browser pane the shortcut was pressed in, which closes rather than the focused pane. */
export function interceptPaneCloseShortcut(
  event: ShortcutEvent,
  input: Input,
  shortcut: string | undefined,
  notificationTarget: ShortcutTarget,
  page?: DevPreviewTabRef
): boolean {
  if (input.type !== 'keyDown' || !shortcutMatchesInput(shortcut, input)) return false;
  event.preventDefault();
  if (!notificationTarget.isDestroyed()) {
    if (page) notificationTarget.send(IPC.SHORTCUT_PANE_CLOSE, page);
    else notificationTarget.send(IPC.SHORTCUT_PANE_CLOSE);
  }
  return true;
}

// Custom bindings without Cmd or Ctrl (such as Alt+digit) are ordinary typing
// inside a web page, so they stay with it.
function hasCommandModifier(shortcut: string | undefined): boolean {
  const modifiers = shortcut?.split('+').slice(0, -1) ?? [];
  return modifiers.some((mod) => ['cmd', 'ctrl', 'meta'].includes(mod.toLowerCase()));
}

/**
 * Hands an app shortcut pressed inside separate web contents (such as a native
 * browser preview) to the Komla renderer, moving keyboard focus back to it so
 * any dialog or terminal the action opens can receive typing.
 */
export function interceptForwardedShortcut(
  event: ShortcutEvent,
  input: Input,
  actionIds: readonly string[],
  getShortcut: (actionId: string) => string | undefined,
  target: FocusableShortcutTarget
): boolean {
  if (input.type !== 'keyDown') return false;
  const actionId = actionIds.find((id) => {
    const shortcut = getShortcut(id);
    return hasCommandModifier(shortcut) && shortcutMatchesInput(shortcut, input);
  });
  if (!actionId) return false;
  event.preventDefault();
  if (!target.isDestroyed()) {
    target.focus();
    target.send(IPC.SHORTCUT_FORWARDED, actionId);
  }
  return true;
}
