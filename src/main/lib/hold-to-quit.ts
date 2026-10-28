import type { Input } from 'electron';

/** How long Cmd+Q (Ctrl+Q on Linux) has to be held before Komla quits. */
export const HOLD_TO_QUIT_MS = 1000;

type QuitInput = Pick<Input, 'type' | 'key' | 'code' | 'meta' | 'control' | 'alt' | 'shift'>;

/** Cmd on macOS, Ctrl on Linux. */
type QuitModifier = 'meta' | 'control';

const MODIFIER_KEYS: Record<QuitModifier, string> = { meta: 'Meta', control: 'Control' };

export interface HoldToQuit {
  /** Whether a page saw the quit shortcut go down and not come up again. */
  isShortcutDown(): boolean;
  /** The quit shortcut went down: quits unless it comes up before the hold is over. */
  press(): void;
  /** Watches a page's keys for the shortcut going down and coming up. */
  handleInput(input: QuitInput): void;
  /** Forgets a press in progress, as when focus leaves Komla before the key comes up. */
  cancel(): void;
}

// Layouts without Latin letters still put Q on the Q key, which the menu matches too.
function isQKey(input: QuitInput): boolean {
  return input.key.toLowerCase() === 'q' || input.code === 'KeyQ';
}

/**
 * The quit shortcut quits only after it is held, so a press meant for an app that hands focus
 * to Komla as it closes doesn't take Komla and its agents down too. macOS sends no keyUp for
 * Q while Cmd is down, so letting go of either key ends the press.
 */
export function createHoldToQuit(options: {
  modifier: QuitModifier;
  quit: () => void;
  showHint: () => void;
  holdMs?: number;
}): HoldToQuit {
  const modifierKey = MODIFIER_KEYS[options.modifier];
  let shortcutDown = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    shortcutDown = false;
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  return {
    isShortcutDown: () => shortcutDown,
    press() {
      // Key repeats press it again while it is held.
      if (timer !== null) return;
      options.showHint();
      timer = setTimeout(() => {
        timer = null;
        options.quit();
      }, options.holdMs ?? HOLD_TO_QUIT_MS);
    },
    handleInput(input) {
      if (input.type === 'keyDown') {
        if (
          isQKey(input) &&
          input.meta === (options.modifier === 'meta') &&
          input.control === (options.modifier === 'control') &&
          !input.alt &&
          !input.shift
        ) {
          shortcutDown = true;
        }
      } else if (input.type === 'keyUp' && (input.key === modifierKey || isQKey(input))) {
        cancel();
      }
    },
    cancel,
  };
}
