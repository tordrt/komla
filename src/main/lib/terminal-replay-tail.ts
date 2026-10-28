import {
  MAX_PENDING_SEQUENCE,
  replayStart,
  TerminalModeTracker,
} from '../../shared/lib/terminal-mode-tracker';

import { OutputTailBuffer } from './output-tail-buffer';

/**
 * A terminal's recent output, replayable into a fresh xterm (a window move, reload or Remote
 * Control). A raw tail starts wherever the cut fell, possibly inside an escape sequence, and has
 * lost the modes the program set before it. Once output has been dropped, the replay starts past
 * any escape sequence the cut fell inside and restores the modes in effect there.
 */
export class TerminalReplayTail {
  private readonly tail: OutputTailBuffer;
  // Modes as of the start of the retained output, and the output just before it, where an
  // escape sequence spanning the cut may begin. Empty until output is dropped.
  private readonly droppedModes = new TerminalModeTracker();
  private droppedTail = '';

  constructor(private readonly limit: number) {
    this.tail = new OutputTailBuffer(limit, (chunk) => {
      this.droppedModes.consume(chunk);
      this.droppedTail = (this.droppedTail + chunk.slice(-MAX_PENDING_SEQUENCE)).slice(
        -MAX_PENDING_SEQUENCE
      );
    });
  }

  append(data: string): void {
    this.tail.append(data);
  }

  /** A replay of at most the last `maxChars` characters, plus the modes to restore first. */
  toString(maxChars = this.limit): string {
    const text = this.tail.retained();
    const cut = Math.max(0, text.length - maxChars);
    if (cut === 0 && !this.droppedTail) return text;
    const modes = this.droppedModes.clone();
    modes.consume(text.slice(0, cut));
    const before = this.droppedTail.length;
    const start = replayStart(this.droppedTail + text, before + cut, modes.inString) - before;
    modes.consume(text.slice(cut, start));
    return modes.restoreSequence() + text.slice(start);
  }
}
