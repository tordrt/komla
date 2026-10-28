// DEC private modes a program usually sets once at startup, so a replay of its recent output
// would lose them. Each group holds the last mode set in it. Synchronized output (2026) is left
// out so a cut inside an update cannot hold the replay's rendering.
const MOUSE_MODES = [9, 1000, 1002, 1003];
const MOUSE_ENCODINGS = [1006, 1016];
const ALT_SCREENS = [47, 1047, 1049];
// Independent modes and their xterm defaults: cursor keys, wraparound, cursor visibility,
// keypad, focus reports and bracketed paste. A soft reset (DECSTR) returns exactly these.
const FLAG_DEFAULTS = new Map([
  [1, false],
  [7, true],
  [25, true],
  [66, false],
  [1004, false],
  [2004, false],
]);
// An escape sequence cut off at a chunk boundary is carried this far into the next chunk.
export const MAX_PENDING_SEQUENCE = 256;
// The only sequences that change tracked state: DEC private modes, a soft reset, the strings
// that hide other sequences (OSC, DCS, APC, PM), keypad modes and a full reset. Colors and cursor
// moves never reach JS.
// oxlint-disable-next-line no-control-regex -- intentional: matches ESC
const TRACKED_SEQUENCE = /\x1b(?:\[[?!]|[\]P_^=>c])/g;

type StringSequence = 'osc' | 'st';
type ModeGroup = 'altScreen' | 'mouse' | 'mouseEncoding';

/** Where output inside a string sequence returns to normal: after a BEL, or at the ESC of ST. */
function stringEnd(text: string, from: number, kind: StringSequence): number {
  const esc = text.indexOf('\x1b', from);
  const bel = kind === 'osc' ? text.indexOf('\x07', from) : -1;
  return bel >= 0 && (esc < 0 || bel < esc) ? bel + 1 : esc;
}

/** Follows the modes and escape state of a stream of terminal output, chunk by chunk. */
export class TerminalModeTracker {
  private flags = new Map<number, boolean>();
  private mouse: number | null = null;
  private mouseEncoding: number | null = null;
  private altScreen: number | null = null;
  // For a terminal with modes of its own: the groups the stream changed since its last reset.
  private changedGroups = new Set<ModeGroup>();
  private lastReset = '';
  private pending = '';
  // Inside an OSC (ended by BEL or ST) or a DCS, APC or PM (ended by ST).
  inString: StringSequence | null = null;

  clone(): TerminalModeTracker {
    const copy = new TerminalModeTracker();
    copy.flags = new Map(this.flags);
    copy.mouse = this.mouse;
    copy.mouseEncoding = this.mouseEncoding;
    copy.altScreen = this.altScreen;
    copy.changedGroups = new Set(this.changedGroups);
    copy.lastReset = this.lastReset;
    copy.pending = this.pending;
    copy.inString = this.inString;
    return copy;
  }

  consume(data: string): void {
    const text = this.pending + data;
    this.pending = '';
    let i = 0;
    while (i < text.length) {
      if (this.inString) {
        // Any ESC ends the string; ESC \ is its terminator.
        i = stringEnd(text, i, this.inString);
        if (i < 0) return;
        this.inString = null;
      }
      TRACKED_SEQUENCE.lastIndex = i;
      const match = TRACKED_SEQUENCE.exec(text);
      if (!match) {
        this.carryIntroducer(text, i);
        return;
      }
      const end = this.consumeEscape(text, match.index);
      if (end < 0) {
        if (text.length - match.index <= MAX_PENDING_SEQUENCE) {
          this.pending = text.slice(match.index);
        }
        return;
      }
      i = end;
    }
  }

  /** Escape sequences that bring a fresh xterm to the tracked modes. */
  restoreSequence(): string {
    let sequence = this.altScreen === null ? '' : `\x1b[?${this.altScreen}h`;
    for (const [mode, on] of this.flags) {
      if (on !== FLAG_DEFAULTS.get(mode)) sequence += `\x1b[?${mode}${on ? 'h' : 'l'}`;
    }
    if (this.mouse !== null) sequence += `\x1b[?${this.mouse}h`;
    if (this.mouseEncoding !== null) sequence += `\x1b[?${this.mouseEncoding}h`;
    return sequence;
  }

  /**
   * Escape sequences that apply the stream's changes to an xterm that already has modes, so a
   * mode turned off counts as much as one turned on.
   */
  changeSequence(): string {
    let sequence = this.lastReset;
    if (this.changedGroups.has('altScreen')) {
      // 1047, unlike 1049, leaves the alternate screen without restoring a saved cursor.
      sequence += this.altScreen === null ? '\x1b[?1047l' : `\x1b[?${this.altScreen}h`;
    }
    for (const [mode, on] of this.flags) sequence += `\x1b[?${mode}${on ? 'h' : 'l'}`;
    if (this.changedGroups.has('mouse')) {
      sequence += this.mouse === null ? '\x1b[?1000l' : `\x1b[?${this.mouse}h`;
    }
    if (this.changedGroups.has('mouseEncoding')) {
      sequence += this.mouseEncoding === null ? '\x1b[?1006l' : `\x1b[?${this.mouseEncoding}h`;
    }
    return sequence;
  }

  /** Keeps an ESC or ESC [ that ends the chunk; the next chunk may complete a tracked sequence. */
  private carryIntroducer(text: string, from: number): void {
    if (text.endsWith('\x1b') && text.length - 1 >= from) this.pending = '\x1b';
    else if (text.endsWith('\x1b[') && text.length - 2 >= from) this.pending = '\x1b[';
  }

  /** Applies the tracked sequence at `start`; returns the index after it, or -1 if cut off. */
  private consumeEscape(text: string, start: number): number {
    const kind = text[start + 1];
    if (kind === ']') this.inString = 'osc';
    else if (kind === 'P' || kind === '_' || kind === '^') this.inString = 'st';
    else if (kind === '=' || kind === '>') this.flags.set(66, kind === '=');
    else if (kind === 'c') this.reset();
    if (kind !== '[') return start + 2;
    if (text[start + 2] === '!') {
      if (start + 3 >= text.length) return -1;
      if (text[start + 3] === 'p') {
        this.flags.clear();
        // A full reset already returns these flags.
        this.lastReset ||= '\x1b[!p';
      }
      return start + 3;
    }

    let end = start + 3;
    while (end < text.length && text.charCodeAt(end) >= 0x20 && text.charCodeAt(end) <= 0x3f) {
      end++;
    }
    if (end >= text.length) return -1;
    const final = text[end];
    if (final === 'h' || final === 'l') {
      for (const param of text.slice(start + 3, end).split(';')) {
        this.setMode(Number(param), final === 'h');
      }
    }
    return end + 1;
  }

  private setMode(mode: number, on: boolean): void {
    if (MOUSE_MODES.includes(mode)) {
      this.mouse = on ? mode : null;
      this.changedGroups.add('mouse');
    } else if (MOUSE_ENCODINGS.includes(mode)) {
      this.mouseEncoding = on ? mode : null;
      this.changedGroups.add('mouseEncoding');
    } else if (ALT_SCREENS.includes(mode)) {
      this.altScreen = on ? mode : null;
      this.changedGroups.add('altScreen');
    } else if (FLAG_DEFAULTS.has(mode)) {
      this.flags.set(mode, on);
    }
  }

  private reset(): void {
    this.flags.clear();
    this.mouse = null;
    this.mouseEncoding = null;
    this.altScreen = null;
    this.changedGroups.clear();
    this.lastReset = '\x1bc';
  }
}

/** Where the escape sequence starting at `esc` ends, or -1 if `text` ends first. */
function escapeEnd(text: string, esc: number): number {
  const kind = text[esc + 1];
  if (kind === ']') return stringEnd(text, esc + 2, 'osc');
  if (kind === 'P' || kind === '_' || kind === '^') return stringEnd(text, esc + 2, 'st');
  // A CSI runs through parameter and intermediate bytes, other escapes through intermediates;
  // then a final byte.
  const csi = kind === '[';
  const lastInner = csi ? 0x3f : 0x2f;
  let end = csi ? esc + 2 : esc + 1;
  while (end < text.length && text.charCodeAt(end) >= 0x20 && text.charCodeAt(end) <= lastInner) {
    end++;
  }
  return end < text.length ? end + 1 : -1;
}

/** Where to start a replay at `cut`: past an escape sequence or string the cut fell inside. */
export function replayStart(text: string, cut: number, inString: StringSequence | null): number {
  if (inString) {
    const end = stringEnd(text, cut, inString);
    return end < 0 ? text.length : end;
  }
  const esc = text.lastIndexOf('\x1b', cut - 1);
  if (cut > 0 && esc >= 0 && cut - esc <= MAX_PENDING_SEQUENCE) {
    const end = escapeEnd(text, esc);
    if (end < 0) return text.length;
    if (end > cut) return end;
  }
  const code = text.charCodeAt(cut);
  return code >= 0xdc00 && code <= 0xdfff ? cut + 1 : cut;
}

/**
 * The last `keepChars` characters of output an xterm has not parsed yet, for when the rest can be
 * skipped. They start past any escape sequence the cut fell inside, after the mode changes the
 * skipped output made.
 */
export function skipTerminalOutput(text: string, keepChars: number): string {
  const cut = text.length - keepChars;
  if (cut <= 0) return text;
  const modes = new TerminalModeTracker();
  modes.consume(text.slice(0, cut));
  const start = replayStart(text, cut, modes.inString);
  modes.consume(text.slice(cut, start));
  return modes.changeSequence() + text.slice(start);
}
