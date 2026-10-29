/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/double-tap-detector', async () => {
  const actual = await vi.importActual<typeof import('@/lib/double-tap-detector')>(
    '@/lib/double-tap-detector'
  );
  return {
    ...actual,
    getDetector: vi.fn(),
  };
});

vi.mock('@/lib/shortcut-actions', () => ({
  executeShortcutAction: vi.fn(),
  registerShortcutAction: vi.fn(() => () => {}),
}));

const runtimeMocks = vi.hoisted(() => ({
  focusTerminalRenderer: vi.fn(),
  pasteIntoTerminalRenderer: vi.fn(),
}));
vi.mock('@/lib/terminal-renderer-runtime', () => ({
  attachTerminalRenderer: vi.fn(),
  clearTerminalRendererClipboard: vi.fn(),
  clearTerminalRendererSearch: vi.fn(),
  configureTerminalRendererClipboard: vi.fn(),
  detachTerminalRenderer: vi.fn(),
  focusTerminalRenderer: runtimeMocks.focusTerminalRenderer,
  getTerminalRendererHoveredLink: vi.fn(),
  getTerminalRendererSelection: vi.fn(() => ''),
  pasteIntoTerminalRenderer: runtimeMocks.pasteIntoTerminalRenderer,
  refreshTerminalRenderer: vi.fn(),
  setTerminalRendererVisible: vi.fn(),
  updateTerminalRendererConfiguration: vi.fn(),
  updateTerminalRendererContext: vi.fn(),
}));

const voiceState = { isRecording: false, isStarting: false };
vi.mock('@/stores/voice.store', () => ({
  useVoiceStore: { getState: () => voiceState },
}));

const shortcutsState: { config: { shortcuts: Record<string, string> } | null } = {
  config: { shortcuts: {} },
};
vi.mock('@/stores/shortcuts.store', async () => {
  const actual = await vi.importActual<typeof import('@/stores/shortcuts.store')>(
    '@/stores/shortcuts.store'
  );
  return {
    ...actual,
    useShortcutsStore: { getState: () => shortcutsState },
  };
});

import { getDetector } from '@/lib/double-tap-detector';
import { executeShortcutAction } from '@/lib/shortcut-actions';
import { consumeTreeDragActive, isTreeDragActive, setTreeDragActive } from '@/lib/tree-drag-token';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { stripTerminalFocusReports } from '../../../../src/shared/lib/terminal-escape';
import { createSshWorkspace } from '../../../factories';

import {
  feedDoubleTapDetectors,
  getAltArrowWordJumpInput,
  getDroppedFileAtPathInput,
  getTerminalClipboardShortcutAction,
  isDroppedRegularFile,
  isTerminalTypingKey,
  pasteClipboardIntoTerminal,
  resolveTerminalFileOpenTarget,
  resolveTerminalUrlOpenTarget,
  shortcutKeyMatches,
  shouldOpenTerminalFileLink,
  shouldOpenTerminalUrlLink,
  shouldSendMacBackwardKillWord,
  syncTerminalLinkHoverTitle,
  tryExecuteModifierShortcut,
  xtermKeyHandler,
} from '../../../../src/renderer/components/terminal/TerminalView';

const mockGetDetector = vi.mocked(getDetector);
const mockExecuteShortcutAction = vi.mocked(executeShortcutAction);

describe('resolveTerminalFileOpenTarget', () => {
  it('marks paths in the home folder as external, as printed', () => {
    expect(resolveTerminalFileOpenTarget('~/.claude/plans/', '/repo/project', 'linux')).toEqual({
      type: 'external',
      fullPath: '~/.claude/plans/',
    });
    expect(resolveTerminalFileOpenTarget('~/notes.md', '/repo/project', 'win32')).toBeNull();
  });

  it('marks absolute paths outside the workspace as external', () => {
    expect(
      resolveTerminalFileOpenTarget(
        '/tmp/architecture-review-20260813T163234Z.html',
        '/repo/project',
        'darwin'
      )
    ).toEqual({
      type: 'external',
      fullPath: '/tmp/architecture-review-20260813T163234Z.html',
    });
  });

  it('keeps workspace paths in the inline file viewer', () => {
    expect(
      resolveTerminalFileOpenTarget('/repo/project/src/main.ts', '/repo/project', 'linux')
    ).toEqual({
      type: 'workspace',
      filePath: 'src/main.ts',
    });
  });

  it('matches local macOS workspace paths case-insensitively', () => {
    expect(
      resolveTerminalFileOpenTarget(
        '/Users/dev/project/src/main.ts',
        '/Users/dev/Project',
        'darwin',
        'local'
      )
    ).toEqual({
      type: 'workspace',
      filePath: 'src/main.ts',
    });
  });

  it('keeps SSH workspace path matching case-sensitive on macOS', () => {
    expect(
      resolveTerminalFileOpenTarget(
        '/home/dev/project/src/main.ts',
        '/home/dev/Project',
        'darwin',
        'ssh'
      )
    ).toEqual({
      type: 'external',
      fullPath: '/home/dev/project/src/main.ts',
    });
  });

  it('does not open host-external paths on Windows', () => {
    expect(
      resolveTerminalFileOpenTarget('C:\\tmp\\report.html', 'C:\\repo\\project', 'win32')
    ).toBeNull();
    expect(
      resolveTerminalFileOpenTarget('\\Users\\me\\report.html', 'C:\\repo\\project', 'win32')
    ).toBeNull();
  });

  it('rejects Windows path syntax on POSIX hosts', () => {
    expect(
      resolveTerminalFileOpenTarget('C:\\tmp\\report.html', '/repo/project', 'linux')
    ).toBeNull();
    expect(
      resolveTerminalFileOpenTarget('\\Users\\me\\report.html', '/repo/project', 'darwin')
    ).toBeNull();
  });
});

function makeKeyEvent(overrides: Partial<KeyboardEvent> & { type: string }): KeyboardEvent {
  return {
    key: 'a',
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe('shouldSendMacBackwardKillWord', () => {
  it('matches macOS Option+Backspace key events', () => {
    expect(
      shouldSendMacBackwardKillWord('darwin', {
        type: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        altKey: true,
        metaKey: false,
        ctrlKey: false,
      })
    ).toBe(true);
  });

  it('matches macOS Option+Delete events reported with Backspace code', () => {
    expect(
      shouldSendMacBackwardKillWord('darwin', {
        type: 'keydown',
        key: 'Delete',
        code: 'Backspace',
        altKey: true,
        metaKey: false,
        ctrlKey: false,
      })
    ).toBe(true);
  });

  it('does not match when Command is also pressed', () => {
    expect(
      shouldSendMacBackwardKillWord('darwin', {
        type: 'keydown',
        key: 'Backspace',
        code: 'Backspace',
        altKey: true,
        metaKey: true,
        ctrlKey: false,
      })
    ).toBe(false);
  });

  it('does not match on non-macOS platforms', () => {
    expect(
      shouldSendMacBackwardKillWord('linux', {
        type: 'keydown',
        key: 'Delete',
        code: 'Backspace',
        altKey: true,
        metaKey: false,
        ctrlKey: false,
      })
    ).toBe(false);
  });
});

describe('shouldOpenTerminalFileLink', () => {
  it('requires the platform modifier with a primary click', () => {
    expect(shouldOpenTerminalFileLink('darwin', { button: 0, ctrlKey: false, metaKey: true })).toBe(
      true
    );
    expect(shouldOpenTerminalFileLink('linux', { button: 0, ctrlKey: true, metaKey: false })).toBe(
      true
    );
    expect(shouldOpenTerminalFileLink('win32', { button: 0, ctrlKey: true, metaKey: false })).toBe(
      true
    );
  });

  it('rejects ordinary clicks without the platform modifier', () => {
    expect(
      shouldOpenTerminalFileLink('darwin', { button: 0, ctrlKey: false, metaKey: false })
    ).toBe(false);
    expect(shouldOpenTerminalFileLink('linux', { button: 0, ctrlKey: false, metaKey: false })).toBe(
      false
    );
  });

  it('rejects non-primary clicks', () => {
    expect(shouldOpenTerminalFileLink('linux', { button: 1, ctrlKey: true, metaKey: false })).toBe(
      false
    );
    expect(shouldOpenTerminalFileLink('linux', { button: 2, ctrlKey: true, metaKey: false })).toBe(
      false
    );
  });

  it('rejects macOS Control-click', () => {
    expect(shouldOpenTerminalFileLink('darwin', { button: 0, ctrlKey: true, metaKey: false })).toBe(
      false
    );
  });
});

describe('syncTerminalLinkHoverTitle', () => {
  it('shows the platform file-open shortcut while hovering a file link', () => {
    const element = document.createElement('div');

    syncTerminalLinkHoverTitle(element, 'darwin', { type: 'file', filePath: 'src/main.ts' });
    expect(element.title).toBe('⌘Click to open file');

    syncTerminalLinkHoverTitle(element, 'linux', { type: 'file', filePath: 'src/main.ts' });
    expect(element.title).toBe('Ctrl+Click to open file');
  });

  it('says whether a file link opens a file or a folder', () => {
    const element = document.createElement('div');

    syncTerminalLinkHoverTitle(element, 'linux', { type: 'file', filePath: '/tmp/shot.PNG' });
    expect(element.title).toBe('Ctrl+Click to open file');

    syncTerminalLinkHoverTitle(element, 'linux', { type: 'file', filePath: 'out/report.html' });
    expect(element.title).toBe('Ctrl+Click to open file');

    syncTerminalLinkHoverTitle(element, 'linux', { type: 'file', filePath: '/tmp/shots/' });
    expect(element.title).toBe('Ctrl+Click to open folder');

    syncTerminalLinkHoverTitle(element, 'linux', {
      type: 'file',
      filePath: 'docs/NOTES.md',
      lineNumber: 4,
    });
    expect(element.title).toBe('Ctrl+Click to open file');
  });

  it('shows where a click on a web link opens while hovering it', () => {
    const element = document.createElement('div');

    syncTerminalLinkHoverTitle(element, 'darwin', {
      type: 'url',
      url: 'http://localhost:5173',
    });
    expect(element.title).toBe('Click to open externally · ⇧Click to open in Komla');

    syncTerminalLinkHoverTitle(
      element,
      'darwin',
      { type: 'url', url: 'http://localhost:5173' },
      { webLinkOpenTarget: 'auto' }
    );
    expect(element.title).toBe('Click to open in Komla · ⇧Click to open externally');

    syncTerminalLinkHoverTitle(element, 'win32', { type: 'url', url: 'https://example.com' });
    expect(element.title).toBe('Click to open externally · Shift+Click to open in Komla');

    syncTerminalLinkHoverTitle(
      element,
      'win32',
      { type: 'url', url: 'https://example.com' },
      { webLinkOpenTarget: 'komla' }
    );
    expect(element.title).toBe('Click to open in Komla · Shift+Click to open externally');

    syncTerminalLinkHoverTitle(
      element,
      'win32',
      { type: 'url', url: 'https://example.com' },
      { webLinkOpenTarget: 'external' }
    );
    expect(element.title).toBe('Click to open externally · Shift+Click to open in Komla');
  });

  it('says when a link opens externally because it is a sign-in page', () => {
    const element = document.createElement('div');

    syncTerminalLinkHoverTitle(element, 'darwin', {
      type: 'url',
      url: 'https://github.com/login/device',
    });
    expect(element.title).toBe(
      'Click to open this sign-in page externally · ⇧Click to open in Komla'
    );

    syncTerminalLinkHoverTitle(
      element,
      'darwin',
      { type: 'url', url: 'http://localhost:3000/login' },
      { webLinkOpenTarget: 'external' }
    );
    expect(element.title).toBe('Click to open externally · ⇧Click to open in Komla');
  });

  it('offers no choice for a web link in a terminal without a workspace', () => {
    const element = document.createElement('div');
    element.title = '⌘-click to open file';

    syncTerminalLinkHoverTitle(
      element,
      'darwin',
      { type: 'url', url: 'http://localhost:5173' },
      { canOpenInKomla: false }
    );
    expect(element.hasAttribute('title')).toBe(false);
  });

  it('clears the hint when leaving a link or hovering a link that is not a web page', () => {
    const element = document.createElement('div');
    element.title = '⌘-click to open file';

    syncTerminalLinkHoverTitle(element, 'darwin', { type: 'url', url: 'mailto:dev@example.com' });
    expect(element.hasAttribute('title')).toBe(false);

    element.title = '⌘-click to open file';
    syncTerminalLinkHoverTitle(element, 'darwin', null);
    expect(element.hasAttribute('title')).toBe(false);
  });
});

describe('resolveTerminalUrlOpenTarget', () => {
  it('opens every web link in the default browser out of the box, and in Komla on Shift-click', () => {
    expect(resolveTerminalUrlOpenTarget('http://localhost:5173', false)).toBe('external');
    expect(resolveTerminalUrlOpenTarget('http://localhost:5173', true)).toBe('preview');
    expect(resolveTerminalUrlOpenTarget('https://example.com/docs', false)).toBe('external');
    expect(resolveTerminalUrlOpenTarget('https://example.com/docs', true)).toBe('preview');
  });

  it('opens loopback URLs in Komla on an ordinary click when set to Automatic', () => {
    const auto = { webLinkOpenTarget: 'auto' } as const;
    expect(resolveTerminalUrlOpenTarget('http://localhost:5173', false, auto)).toBe('preview');
    expect(resolveTerminalUrlOpenTarget('https://127.0.0.1:8443/app', false, auto)).toBe('preview');
    expect(resolveTerminalUrlOpenTarget('http://0.0.0.0:3000', false, auto)).toBe('preview');
    expect(resolveTerminalUrlOpenTarget('http://[::]:8000/', false, auto)).toBe('preview');
  });

  it('opens loopback URLs where the setting says, and the other way on Shift-click', () => {
    expect(
      resolveTerminalUrlOpenTarget('http://localhost:5173', true, { webLinkOpenTarget: 'auto' })
    ).toBe('external');
    const external = { webLinkOpenTarget: 'external' } as const;
    expect(resolveTerminalUrlOpenTarget('http://localhost:5173', false, external)).toBe('external');
    expect(resolveTerminalUrlOpenTarget('http://[::1]:5173', false, external)).toBe('external');
    expect(resolveTerminalUrlOpenTarget('http://localhost:5173', true, external)).toBe('preview');
    const komla = { webLinkOpenTarget: 'komla' } as const;
    expect(resolveTerminalUrlOpenTarget('http://localhost:5173', false, komla)).toBe('preview');
    expect(resolveTerminalUrlOpenTarget('http://localhost:5173', true, komla)).toBe('external');
  });

  it('counts no page on this computer as a sign-in page', () => {
    const auto = { webLinkOpenTarget: 'auto' } as const;
    expect(resolveTerminalUrlOpenTarget('http://localhost:3000/login', false, auto)).toBe(
      'preview'
    );
    expect(resolveTerminalUrlOpenTarget('http://app.localhost:3000/auth', false, auto)).toBe(
      'preview'
    );
    expect(
      resolveTerminalUrlOpenTarget('http://127.0.0.2:8080/oauth/authorize?client_id=x', false, auto)
    ).toBe('preview');
  });

  it('opens other websites externally unless set otherwise, and the other way on Shift-click', () => {
    const auto = { webLinkOpenTarget: 'auto' } as const;
    expect(resolveTerminalUrlOpenTarget('https://example.com/docs', false, auto)).toBe('external');
    expect(resolveTerminalUrlOpenTarget('https://example.com/docs', true, auto)).toBe('preview');
    expect(resolveTerminalUrlOpenTarget('http://192.168.1.20:3000', false, auto)).toBe('external');
    const komla = { webLinkOpenTarget: 'komla' } as const;
    expect(resolveTerminalUrlOpenTarget('https://example.com/docs', false, komla)).toBe('preview');
    expect(resolveTerminalUrlOpenTarget('https://example.com/docs', true, komla)).toBe('external');
    const external = { webLinkOpenTarget: 'external' } as const;
    expect(resolveTerminalUrlOpenTarget('https://example.com/docs', false, external)).toBe(
      'external'
    );
    expect(resolveTerminalUrlOpenTarget('https://example.com/docs', true, external)).toBe(
      'preview'
    );
  });

  it('opens sign-in pages externally, where you are signed in, and in Komla on Shift-click', () => {
    const signIn =
      'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_1&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback';
    expect(resolveTerminalUrlOpenTarget(signIn, false)).toBe('external');
    expect(resolveTerminalUrlOpenTarget(signIn, true)).toBe('preview');
    expect(resolveTerminalUrlOpenTarget(signIn, false, { webLinkOpenTarget: 'external' })).toBe(
      'external'
    );
    expect(resolveTerminalUrlOpenTarget(signIn, false, { webLinkOpenTarget: 'komla' })).toBe(
      'external'
    );
  });

  it('opens every link externally from a terminal without a workspace', () => {
    const noWorkspace = { canOpenInKomla: false };
    expect(resolveTerminalUrlOpenTarget('http://localhost:5173', false, noWorkspace)).toBe(
      'external'
    );
    expect(resolveTerminalUrlOpenTarget('https://example.com/docs', true, noWorkspace)).toBe(
      'external'
    );
  });

  it('always opens links that are not web pages externally', () => {
    expect(resolveTerminalUrlOpenTarget('mailto:dev@example.com', false)).toBe('external');
    expect(resolveTerminalUrlOpenTarget('vscode://file/tmp/a.ts', true)).toBe('external');
  });
});

describe('shouldOpenTerminalUrlLink', () => {
  it('only opens URLs with the primary mouse button', () => {
    expect(shouldOpenTerminalUrlLink('linux', { button: 0, ctrlKey: false })).toBe(true);
    expect(shouldOpenTerminalUrlLink('linux', { button: 1, ctrlKey: false })).toBe(false);
    expect(shouldOpenTerminalUrlLink('linux', { button: 2, ctrlKey: false })).toBe(false);
  });

  it('rejects macOS Control-click', () => {
    expect(shouldOpenTerminalUrlLink('darwin', { button: 0, ctrlKey: true })).toBe(false);
  });
});

describe('getAltArrowWordJumpInput', () => {
  it('uses zle/readline meta bindings for macOS Option+Arrow', () => {
    expect(
      getAltArrowWordJumpInput(
        'darwin',
        makeKeyEvent({ type: 'keydown', key: 'ArrowLeft', altKey: true })
      )
    ).toBe('\x1bb');
    expect(
      getAltArrowWordJumpInput(
        'darwin',
        makeKeyEvent({ type: 'keydown', key: 'ArrowRight', altKey: true })
      )
    ).toBe('\x1bf');
  });

  it('keeps Ctrl+Arrow CSI mappings on non-macOS platforms', () => {
    expect(
      getAltArrowWordJumpInput(
        'linux',
        makeKeyEvent({ type: 'keydown', key: 'ArrowLeft', altKey: true })
      )
    ).toBe('\x1b[1;5D');
    expect(
      getAltArrowWordJumpInput(
        'win32',
        makeKeyEvent({ type: 'keydown', key: 'ArrowRight', altKey: true })
      )
    ).toBe('\x1b[1;5C');
  });

  it('does not match non-arrow or extra-modifier events', () => {
    expect(
      getAltArrowWordJumpInput(
        'darwin',
        makeKeyEvent({ type: 'keydown', key: 'ArrowLeft', altKey: true, shiftKey: true })
      )
    ).toBeNull();
    expect(
      getAltArrowWordJumpInput('darwin', makeKeyEvent({ type: 'keydown', key: 'b', altKey: true }))
    ).toBeNull();
  });
});

describe('getTerminalClipboardShortcutAction', () => {
  it('uses Ctrl+Shift for terminal clipboard shortcuts on Windows and Linux', () => {
    expect(
      getTerminalClipboardShortcutAction(
        'win32',
        makeKeyEvent({ type: 'keydown', key: 'c', ctrlKey: true, shiftKey: true })
      )
    ).toBe('copy');
    expect(
      getTerminalClipboardShortcutAction(
        'linux',
        makeKeyEvent({ type: 'keydown', key: 'V', ctrlKey: true, shiftKey: true })
      )
    ).toBe('paste');
  });

  it('does not steal plain Ctrl terminal control keys on Windows and Linux', () => {
    expect(
      getTerminalClipboardShortcutAction(
        'win32',
        makeKeyEvent({ type: 'keydown', key: 'c', ctrlKey: true })
      )
    ).toBeNull();
    expect(
      getTerminalClipboardShortcutAction(
        'linux',
        makeKeyEvent({ type: 'keydown', key: 'v', ctrlKey: true })
      )
    ).toBeNull();
  });

  it('uses Command for terminal clipboard shortcuts on macOS', () => {
    expect(
      getTerminalClipboardShortcutAction(
        'darwin',
        makeKeyEvent({ type: 'keydown', key: 'c', metaKey: true })
      )
    ).toBe('copy');
    expect(
      getTerminalClipboardShortcutAction(
        'darwin',
        makeKeyEvent({ type: 'keydown', key: 'v', metaKey: true })
      )
    ).toBe('paste');
  });

  it('leaves find and other terminal input to the configured shortcut path', () => {
    expect(
      getTerminalClipboardShortcutAction(
        'linux',
        makeKeyEvent({ type: 'keydown', key: 'f', ctrlKey: true, shiftKey: true })
      )
    ).toBeNull();
    expect(
      getTerminalClipboardShortcutAction(
        'linux',
        makeKeyEvent({ type: 'keydown', key: 'a', ctrlKey: true, shiftKey: true })
      )
    ).toBeNull();
  });
});

describe('stripTerminalFocusReports', () => {
  it('removes xterm focus-in and focus-out reports', () => {
    expect(stripTerminalFocusReports('\x1b[I')).toBe('');
    expect(stripTerminalFocusReports('\x1b[O')).toBe('');
    expect(stripTerminalFocusReports('\x1b[Ihello\x1b[O')).toBe('hello');
  });

  it('leaves other terminal input unchanged', () => {
    expect(stripTerminalFocusReports('\x1b[Ahello\r')).toBe('\x1b[Ahello\r');
  });
});

describe('shortcutKeyMatches', () => {
  it('matches identical keys', () => {
    expect(shortcutKeyMatches('a', 'a')).toBe(true);
    expect(shortcutKeyMatches('1', '1')).toBe(true);
  });

  it('returns false for different keys', () => {
    expect(shortcutKeyMatches('a', 'b')).toBe(false);
  });

  it('maps backslash shortcut to backslash or pipe key', () => {
    expect(shortcutKeyMatches('\\', '\\')).toBe(true);
    expect(shortcutKeyMatches('\\', '|')).toBe(true);
    expect(shortcutKeyMatches('\\', 'a')).toBe(false);
  });

  it('matches arrow keys exactly', () => {
    expect(shortcutKeyMatches('arrowleft', 'arrowleft')).toBe(true);
    expect(shortcutKeyMatches('arrowright', 'arrowright')).toBe(true);
    expect(shortcutKeyMatches('arrowleft', 'arrowright')).toBe(false);
  });

  it('matches bracket keys', () => {
    expect(shortcutKeyMatches('[', '[')).toBe(true);
    expect(shortcutKeyMatches(']', ']')).toBe(true);
  });
});

describe('feedDoubleTapDetectors', () => {
  beforeEach(() => {
    mockGetDetector.mockReset();
  });

  it('feeds keydown to detector and returns false', () => {
    const handleKeyDown = vi.fn();
    const handleKeyUp = vi.fn();
    mockGetDetector.mockReturnValue({ handleKeyDown, handleKeyUp } as never);

    const event = makeKeyEvent({ type: 'keydown', key: 'Shift' });
    const result = feedDoubleTapDetectors(event, { 'voice.toggle': 'DoubleTap+Shift' });

    expect(result).toBe(false);
    expect(handleKeyDown).toHaveBeenCalledWith(event);
    expect(handleKeyUp).not.toHaveBeenCalled();
  });

  it('returns true on keyup when a detector fires', () => {
    const handleKeyUp = vi.fn().mockReturnValue(true);
    mockGetDetector.mockReturnValue({ handleKeyDown: vi.fn(), handleKeyUp } as never);

    const event = makeKeyEvent({ type: 'keyup', key: 'Shift' });
    expect(feedDoubleTapDetectors(event, { 'voice.toggle': 'DoubleTap+Shift' })).toBe(true);
    expect(handleKeyUp).toHaveBeenCalledWith(event);
  });

  it('returns false on keyup when no detector fires', () => {
    const handleKeyUp = vi.fn().mockReturnValue(false);
    mockGetDetector.mockReturnValue({ handleKeyDown: vi.fn(), handleKeyUp } as never);

    const event = makeKeyEvent({ type: 'keyup', key: 'Shift' });
    expect(feedDoubleTapDetectors(event, { 'voice.toggle': 'DoubleTap+Shift' })).toBe(false);
  });

  it('forwards keyup so repeated workspace navigation can settle', () => {
    shortcutsState.config = { shortcuts: { 'workspace.next': 'Cmd+ArrowDown' } };
    const event = makeKeyEvent({ type: 'keyup', key: 'ArrowDown', metaKey: true });

    xtermKeyHandler(event);

    expect(mockExecuteShortcutAction).toHaveBeenCalledWith('workspace.navigation.release', event);
  });

  it('skips non-double-tap shortcuts', () => {
    const event = makeKeyEvent({ type: 'keydown', key: 'j' });
    feedDoubleTapDetectors(event, { 'workspace.next': 'Cmd+J' });
    expect(mockGetDetector).not.toHaveBeenCalled();
  });

  it('returns false when no detector is registered for the key', () => {
    mockGetDetector.mockReturnValue(undefined);
    const event = makeKeyEvent({ type: 'keyup', key: 'Shift' });
    expect(feedDoubleTapDetectors(event, { 'voice.toggle': 'DoubleTap+Shift' })).toBe(false);
  });
});

describe('isTerminalTypingKey', () => {
  const shortcuts = { 'terminal.search': 'Cmd+F' };

  it('counts keys the terminal sends to its program', () => {
    for (const event of [
      makeKeyEvent({ type: 'keydown', key: 'a' }),
      makeKeyEvent({ type: 'keydown', key: 'Enter' }),
      makeKeyEvent({ type: 'keydown', key: 'c', ctrlKey: true }),
    ]) {
      expect(isTerminalTypingKey(event, 'linux', shortcuts)).toBe(true);
    }
  });

  it('leaves out releases, lone modifiers, and Komla shortcuts', () => {
    expect(isTerminalTypingKey(makeKeyEvent({ type: 'keyup' }), 'linux', shortcuts)).toBe(false);
    expect(
      isTerminalTypingKey(makeKeyEvent({ type: 'keydown', key: 'Shift' }), 'linux', shortcuts)
    ).toBe(false);
    expect(
      isTerminalTypingKey(
        makeKeyEvent({ type: 'keydown', key: 'f', ctrlKey: true }),
        'linux',
        shortcuts
      )
    ).toBe(false);
    expect(
      isTerminalTypingKey(
        makeKeyEvent({ type: 'keydown', key: 'k', metaKey: true }),
        'darwin',
        shortcuts
      )
    ).toBe(false);
  });
});

describe('tryExecuteModifierShortcut', () => {
  beforeEach(() => {
    mockExecuteShortcutAction.mockReset();
  });

  it('executes action and returns true on cmd+key match (mac)', () => {
    const event = makeKeyEvent({ type: 'keydown', key: 'j', metaKey: true });
    expect(tryExecuteModifierShortcut(event, { 'workspace.next': 'Cmd+J' }, true)).toBe(true);
    expect(mockExecuteShortcutAction).toHaveBeenCalledWith('workspace.next', event);
  });

  it('leaves keys bound only in the new workspace dialog to the terminal', () => {
    const event = makeKeyEvent({ type: 'keydown', key: 'e', ctrlKey: true });
    expect(tryExecuteModifierShortcut(event, { 'newWorkspace.cycleEffort': 'Cmd+E' }, false)).toBe(
      false
    );
    expect(mockExecuteShortcutAction).not.toHaveBeenCalled();
  });

  it('uses ctrl as the cmd-equivalent on non-mac', () => {
    const event = makeKeyEvent({ type: 'keydown', key: 'j', ctrlKey: true });
    expect(tryExecuteModifierShortcut(event, { 'workspace.next': 'Cmd+J' }, false)).toBe(true);
    expect(mockExecuteShortcutAction).toHaveBeenCalledWith('workspace.next', event);
  });

  it('returns false when no modifier key is pressed', () => {
    const event = makeKeyEvent({ type: 'keydown', key: 'j' });
    expect(tryExecuteModifierShortcut(event, { 'workspace.next': 'Cmd+J' }, true)).toBe(false);
    expect(mockExecuteShortcutAction).not.toHaveBeenCalled();
  });

  it('requires shift to match exactly', () => {
    // Cmd+J configured, but event has Cmd+Shift+J
    const event = makeKeyEvent({ type: 'keydown', key: 'j', metaKey: true, shiftKey: true });
    expect(tryExecuteModifierShortcut(event, { 'workspace.next': 'Cmd+J' }, true)).toBe(false);
    expect(mockExecuteShortcutAction).not.toHaveBeenCalled();
  });

  it('requires alt to match exactly', () => {
    const event = makeKeyEvent({ type: 'keydown', key: 'j', metaKey: true, altKey: true });
    expect(tryExecuteModifierShortcut(event, { 'workspace.next': 'Cmd+J' }, true)).toBe(false);
  });

  it('matches the macOS diff shortcut without matching Cmd+G', () => {
    const event = makeKeyEvent({
      type: 'keydown',
      key: 'g',
      metaKey: true,
      shiftKey: true,
    });

    expect(tryExecuteModifierShortcut(event, { 'workspace.next': 'Cmd+G' }, true)).toBe(false);
    expect(mockExecuteShortcutAction).not.toHaveBeenCalled();

    expect(tryExecuteModifierShortcut(event, { 'diff.toggle': 'Cmd+Shift+G' }, true)).toBe(true);
    expect(mockExecuteShortcutAction).toHaveBeenCalledWith('diff.toggle', event);
  });

  it('matches Cmd+Shift+key combinations', () => {
    const event = makeKeyEvent({ type: 'keydown', key: 'p', metaKey: true, shiftKey: true });
    expect(tryExecuteModifierShortcut(event, { 'cmd.palette': 'Cmd+Shift+P' }, true)).toBe(true);
    expect(mockExecuteShortcutAction).toHaveBeenCalledWith('cmd.palette', event);
  });

  it('skips double-tap shortcuts', () => {
    const event = makeKeyEvent({ type: 'keydown', key: 'Shift', metaKey: true });
    expect(tryExecuteModifierShortcut(event, { 'voice.toggle': 'DoubleTap+Shift' }, true)).toBe(
      false
    );
  });

  it('matches Cmd+\\ when event reports the | character', () => {
    const event = makeKeyEvent({ type: 'keydown', key: '|', metaKey: true });
    expect(tryExecuteModifierShortcut(event, { 'split.vertical': 'Cmd+\\' }, true)).toBe(true);
    expect(mockExecuteShortcutAction).toHaveBeenCalledWith('split.vertical', event);
  });
});

describe('xtermKeyHandler', () => {
  beforeEach(() => {
    mockGetDetector.mockReset();
    mockExecuteShortcutAction.mockReset();
    voiceState.isRecording = false;
    voiceState.isStarting = false;
    shortcutsState.config = { shortcuts: {} };
    Object.defineProperty(window, 'api', {
      value: { platform: 'darwin' },
      configurable: true,
      writable: true,
    });
  });

  it('cancels voice recording on keydown Escape and swallows the event', () => {
    voiceState.isRecording = true;
    const event = makeKeyEvent({ type: 'keydown', key: 'Escape' });
    expect(xtermKeyHandler(event)).toBe(false);
    expect(mockExecuteShortcutAction).toHaveBeenCalledWith('voice.cancel');
  });

  it('cancels pending voice start on keydown Escape and swallows the event', () => {
    voiceState.isStarting = true;
    const event = makeKeyEvent({ type: 'keydown', key: 'Escape' });
    expect(xtermKeyHandler(event)).toBe(false);
    expect(mockExecuteShortcutAction).toHaveBeenCalledWith('voice.cancel');
  });

  it('passes Escape through when voice is not recording', () => {
    const event = makeKeyEvent({ type: 'keydown', key: 'Escape' });
    expect(xtermKeyHandler(event)).toBe(true);
    expect(mockExecuteShortcutAction).not.toHaveBeenCalled();
  });

  it('passes events through when no shortcuts config is loaded', () => {
    shortcutsState.config = null;
    const event = makeKeyEvent({ type: 'keydown', key: 'a' });
    expect(xtermKeyHandler(event)).toBe(true);
  });

  it('feeds detectors before checking modifier shortcuts on keydown', () => {
    const handleKeyDown = vi.fn();
    mockGetDetector.mockReturnValue({ handleKeyDown, handleKeyUp: vi.fn() } as never);
    shortcutsState.config = {
      shortcuts: { 'voice.toggle': 'DoubleTap+Shift', 'workspace.next': 'Cmd+J' },
    };

    const event = makeKeyEvent({ type: 'keydown', key: 'j', metaKey: true });
    expect(xtermKeyHandler(event)).toBe(false);
    expect(handleKeyDown).toHaveBeenCalledWith(event);
    expect(mockExecuteShortcutAction).toHaveBeenCalledWith('workspace.next', event);
  });

  it('swallows keyup when a double-tap detector fires', () => {
    const handleKeyUp = vi.fn().mockReturnValue(true);
    mockGetDetector.mockReturnValue({ handleKeyDown: vi.fn(), handleKeyUp } as never);
    shortcutsState.config = { shortcuts: { 'voice.toggle': 'DoubleTap+Shift' } };

    const event = makeKeyEvent({ type: 'keyup', key: 'Shift' });
    expect(xtermKeyHandler(event)).toBe(false);
  });

  it('passes keyup through when no detector fires', () => {
    const handleKeyUp = vi.fn().mockReturnValue(false);
    mockGetDetector.mockReturnValue({ handleKeyDown: vi.fn(), handleKeyUp } as never);
    shortcutsState.config = { shortcuts: { 'voice.toggle': 'DoubleTap+Shift' } };

    const event = makeKeyEvent({ type: 'keyup', key: 'Shift' });
    expect(xtermKeyHandler(event)).toBe(true);
  });

  it('uses ctrl as the modifier on non-darwin platforms', () => {
    Object.defineProperty(window, 'api', {
      value: { platform: 'linux' },
      configurable: true,
      writable: true,
    });
    shortcutsState.config = { shortcuts: { 'workspace.next': 'Cmd+J' } };

    const event = makeKeyEvent({ type: 'keydown', key: 'j', ctrlKey: true });
    expect(xtermKeyHandler(event)).toBe(false);
    expect(mockExecuteShortcutAction).toHaveBeenCalledWith('workspace.next', event);
  });
});

describe('terminal file drops', () => {
  it('consumes the tree drag token when a drop is handled', () => {
    setTreeDragActive(true);

    expect(consumeTreeDragActive()).toBe(true);
    expect(isTreeDragActive()).toBe(false);
  });

  it('detects dropped files by resolved native path', () => {
    expect(isDroppedRegularFile('/tmp/upload')).toBe(true);
    expect(isDroppedRegularFile('')).toBe(false);
  });

  it('imports dropped files and builds @path terminal input', async () => {
    const png = new File([''], 'cat.png', { type: 'image/png' });
    const text = new File([''], 'notes.txt', { type: 'text/plain' });
    const getPathForFile = vi.fn((file: File) =>
      file.name === 'cat.png' ? '/Users/ada/cat.png' : '/Users/ada/notes.txt'
    );
    const importExternalFile = vi
      .fn()
      .mockResolvedValueOnce('.komla-files/cat.png')
      .mockResolvedValueOnce('.komla-files/notes.txt');

    await expect(
      getDroppedFileAtPathInput([png, text], getPathForFile, (sourcePath, preferredName) =>
        importExternalFile('/Users/ada/project', sourcePath, preferredName)
      )
    ).resolves.toBe('@.komla-files/cat.png @.komla-files/notes.txt ');
    expect(importExternalFile).toHaveBeenCalledWith(
      '/Users/ada/project',
      '/Users/ada/cat.png',
      'cat.png'
    );
    expect(importExternalFile).toHaveBeenCalledWith(
      '/Users/ada/project',
      '/Users/ada/notes.txt',
      'notes.txt'
    );
  });

  it('returns null when no dropped file has a native path', async () => {
    const text = new File([''], 'notes.txt', { type: 'text/plain' });
    await expect(
      getDroppedFileAtPathInput(
        [text],
        () => '',
        vi.fn().mockResolvedValue('.komla-files/notes.txt')
      )
    ).resolves.toBeNull();
  });

  it('returns null when the terminal has no workspace importer', async () => {
    const png = new File([''], 'cat.png', { type: 'image/png' });
    await expect(
      getDroppedFileAtPathInput([png], () => '/tmp/cat.png', undefined)
    ).resolves.toBeNull();
  });

  it('lets the user reject an unusually large dropped-file transfer before importing', async () => {
    const largeFile = new File([''], 'archive.zip');
    Object.defineProperty(largeFile, 'size', { value: 150 * 1024 * 1024 });
    const importExternalFile = vi.fn().mockResolvedValue('.komla-files/archive.zip');
    const confirmLargeTransfer = vi.fn().mockResolvedValue(false);

    await expect(
      getDroppedFileAtPathInput(
        [largeFile],
        () => '/tmp/archive.zip',
        importExternalFile,
        confirmLargeTransfer
      )
    ).resolves.toBeNull();

    expect(confirmLargeTransfer).toHaveBeenCalledWith([largeFile], 150 * 1024 * 1024);
    expect(importExternalFile).not.toHaveBeenCalled();
  });

  it('imports an unusually large dropped file after the user confirms', async () => {
    const largeFile = new File([''], 'archive.zip');
    Object.defineProperty(largeFile, 'size', { value: 150 * 1024 * 1024 });
    const importExternalFile = vi.fn().mockResolvedValue('.komla-files/archive.zip');

    await expect(
      getDroppedFileAtPathInput(
        [largeFile],
        () => '/tmp/archive.zip',
        importExternalFile,
        vi.fn().mockResolvedValue(true)
      )
    ).resolves.toBe('@.komla-files/archive.zip ');

    expect(importExternalFile).toHaveBeenCalledWith('/tmp/archive.zip', 'archive.zip');
  });
});

describe('terminal clipboard image fallback', () => {
  it('imports an image for a remote workspace and inserts its @path', async () => {
    runtimeMocks.focusTerminalRenderer.mockClear();
    const api = {
      readFromClipboard: vi.fn().mockResolvedValue(''),
      importClipboardImage: vi.fn().mockResolvedValue('.komla-files/clipboard.png'),
      sendInput: vi.fn(),
    };
    Object.defineProperty(window, 'api', { value: api, configurable: true, writable: true });

    await pasteClipboardIntoTerminal('remote-terminal', {
      workspaceId: 'workspace-1',
      executionLocation: 'workspace',
      canImportClipboardImage: true,
    });

    expect(api.importClipboardImage).toHaveBeenCalledWith('workspace-1', 'workspace');
    expect(api.sendInput).toHaveBeenCalledWith('remote-terminal', '@.komla-files/clipboard.png ');
    expect(runtimeMocks.focusTerminalRenderer).toHaveBeenCalledWith('remote-terminal');
  });

  it('re-lists the file tree after importing an image, since the Remote Companion ignores Komla files', async () => {
    useWorkspacesStore.setState({
      workspaces: [
        createSshWorkspace({ id: 'workspace-1', workingDirectory: 'ssh://ssh-dev/home/dev/repo' }),
      ],
    });
    const api = {
      readFromClipboard: vi.fn().mockResolvedValue(''),
      importClipboardImage: vi.fn().mockResolvedValue('.komla-files/clipboard.png'),
      sendInput: vi.fn(),
      listWorkspaceFiles: vi.fn().mockResolvedValue({
        files: ['.komla-files/clipboard.png'],
        gitIgnoredFiles: [],
        emptyDirs: [],
      }),
    };
    Object.defineProperty(window, 'api', { value: api, configurable: true, writable: true });

    try {
      await pasteClipboardIntoTerminal('remote-terminal', {
        workspaceId: 'workspace-1',
        executionLocation: 'workspace',
        canImportClipboardImage: true,
      });

      expect(api.listWorkspaceFiles).toHaveBeenCalledWith('workspace-1', false);
    } finally {
      useWorkspacesStore.setState({ workspaces: [] });
    }
  });

  it('does not import a clipboard image into a local mirror terminal', async () => {
    const api = {
      readFromClipboard: vi.fn().mockResolvedValue(''),
      importClipboardImage: vi.fn(),
      sendInput: vi.fn(),
    };
    Object.defineProperty(window, 'api', { value: api, configurable: true, writable: true });

    await pasteClipboardIntoTerminal('remote-terminal', {
      workspaceId: 'workspace-1',
      executionLocation: 'local-mirror',
      canImportClipboardImage: true,
    });

    expect(api.importClipboardImage).not.toHaveBeenCalled();
    expect(api.sendInput).not.toHaveBeenCalled();
  });
});
