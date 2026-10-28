import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOLD_TO_QUIT_MS, createHoldToQuit } from '../../../src/main/lib/hold-to-quit';

const key = (
  type: 'keyDown' | 'keyUp',
  key: string,
  modifiers: { meta?: boolean; control?: boolean; shift?: boolean; code?: string } = {}
) => ({
  type,
  key,
  code: modifiers.code ?? `Key${key.toUpperCase()}`,
  meta: modifiers.meta ?? false,
  control: modifiers.control ?? false,
  alt: false,
  shift: modifiers.shift ?? false,
});
const cmdQ = key('keyDown', 'q', { meta: true });

describe('createHoldToQuit', () => {
  let quit: ReturnType<typeof vi.fn<() => void>>;
  let showHint: ReturnType<typeof vi.fn<() => void>>;
  let holdToQuit: ReturnType<typeof createHoldToQuit>;

  beforeEach(() => {
    vi.useFakeTimers();
    quit = vi.fn<() => void>();
    showHint = vi.fn<() => void>();
    holdToQuit = createHoldToQuit({ modifier: 'meta', quit, showHint });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('quits once the shortcut has been held, through its key repeats', () => {
    holdToQuit.press();
    expect(showHint).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(HOLD_TO_QUIT_MS / 2);
    holdToQuit.press();
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS / 2 - 1);
    expect(quit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(showHint).toHaveBeenCalledTimes(1);
  });

  it('stays open when Cmd or Q comes up early', () => {
    for (const released of [key('keyUp', 'Meta'), key('keyUp', 'q'), key('keyUp', 'Q')]) {
      holdToQuit.press();
      vi.advanceTimersByTime(HOLD_TO_QUIT_MS - 1);
      holdToQuit.handleInput(released);
      vi.advanceTimersByTime(HOLD_TO_QUIT_MS);
    }
    expect(quit).not.toHaveBeenCalled();
    expect(showHint).toHaveBeenCalledTimes(3);
  });

  it('stays open when the press is cancelled, as when focus leaves', () => {
    holdToQuit.handleInput(cmdQ);
    holdToQuit.press();
    holdToQuit.cancel();
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS);
    expect(quit).not.toHaveBeenCalled();
    expect(holdToQuit.isShortcutDown()).toBe(false);
  });

  it('keeps holding through other keys', () => {
    holdToQuit.press();
    holdToQuit.handleInput(key('keyUp', 'Shift'));
    holdToQuit.handleInput(key('keyUp', 'Control'));
    holdToQuit.handleInput(key('keyDown', 'Meta', { meta: true, code: 'MetaLeft' }));
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('knows the shortcut is down from its keyDown until a key comes up', () => {
    for (const other of [
      key('keyDown', 'q'),
      key('keyDown', 'q', { meta: true, shift: true }),
      key('keyDown', 'q', { control: true }),
      key('keyDown', 'w', { meta: true }),
    ]) {
      holdToQuit.handleInput(other);
      expect(holdToQuit.isShortcutDown()).toBe(false);
    }
    holdToQuit.handleInput(cmdQ);
    expect(holdToQuit.isShortcutDown()).toBe(true);
    holdToQuit.handleInput(key('keyUp', 'Meta'));
    expect(holdToQuit.isShortcutDown()).toBe(false);
  });

  it('finds the Q key on layouts without Latin letters', () => {
    holdToQuit.handleInput(key('keyDown', 'й', { meta: true, code: 'KeyQ' }));
    expect(holdToQuit.isShortcutDown()).toBe(true);
    holdToQuit.press();
    holdToQuit.handleInput(key('keyUp', 'й', { code: 'KeyQ' }));
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS);
    expect(quit).not.toHaveBeenCalled();
  });

  it('takes Ctrl+Q on Linux, where Ctrl coming up ends the press', () => {
    holdToQuit = createHoldToQuit({ modifier: 'control', quit, showHint });
    holdToQuit.handleInput(cmdQ);
    expect(holdToQuit.isShortcutDown()).toBe(false);
    holdToQuit.handleInput(key('keyDown', 'q', { control: true }));
    expect(holdToQuit.isShortcutDown()).toBe(true);

    holdToQuit.press();
    holdToQuit.handleInput(key('keyUp', 'Meta'));
    expect(holdToQuit.isShortcutDown()).toBe(true);
    holdToQuit.handleInput(key('keyUp', 'Control'));
    vi.advanceTimersByTime(HOLD_TO_QUIT_MS);
    expect(quit).not.toHaveBeenCalled();
  });
});
