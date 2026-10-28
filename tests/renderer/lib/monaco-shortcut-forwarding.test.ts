import { describe, expect, it, vi } from 'vitest';

import { addMonacoShortcutForwarding } from '../../../src/renderer/lib/monaco-shortcut-forwarding';
import { registerShortcutAction } from '../../../src/renderer/lib/shortcut-actions';

vi.mock('../../../src/renderer/stores/shortcuts.store', () => ({
  isDoubleTapShortcut: (shortcut: string) => shortcut.startsWith('DoubleTap+'),
  useShortcutsStore: {
    getState: () => ({
      config: { shortcuts: { 'commandCenter.open': 'Cmd+P' } },
      matchesEvent: (action: string, event: { key: string }) =>
        action === 'commandCenter.open' && event.key === 'p',
    }),
  },
}));

describe('addMonacoShortcutForwarding', () => {
  it('opens the command center from inside the editor', () => {
    let listener: ((event: unknown) => void) | undefined;
    const editor = {
      onKeyDown: (handler: (event: unknown) => void) => {
        listener = handler;
        return { dispose: () => {} };
      },
    };
    const openCommandCenter = vi.fn();
    const unregister = registerShortcutAction('commandCenter.open', openCommandCenter);
    addMonacoShortcutForwarding(editor as never);

    const event = { browserEvent: { key: 'p' }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    listener?.(event);

    expect(openCommandCenter).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalled();
    unregister();
  });
});
