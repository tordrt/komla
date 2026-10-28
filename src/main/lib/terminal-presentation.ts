import { SerializeAddon } from '@xterm/addon-serialize';
import headless from '@xterm/headless';

import type { Terminal as HeadlessTerminal } from '@xterm/headless';

const { Terminal } = headless;

export interface TerminalPresentationSnapshot {
  buffer: string;
  cols: number;
  rows: number;
  generation: number;
  seq: number;
}

export type TerminalPresentationMetadata = Omit<TerminalPresentationSnapshot, 'buffer'>;

export interface TerminalOutputChunk {
  data: string;
  seq: number;
}

// Recent output kept per terminal for a phone that reconnects, in UTF-16 units.
const REPLAY_LIMIT_CHARS = 256 * 1024;

export interface TerminalPresentationSnapshotOptions {
  /** Scrollback rows to include; 0 serializes only the visible screen. Defaults to all. */
  scrollback?: number;
}

interface TerminalPresentationOptions {
  cols: number;
  rows: number;
  generation: number;
  seq: number;
}

/**
 * Maintains the authoritative parsed screen for one PTY generation. Raw PTY
 * output is queued through xterm's parser so snapshots never begin halfway
 * through an ANSI state transition. xterm parses writes in order, and a
 * write's callback runs once everything before it is parsed, so resizes and
 * snapshots wait behind the output already queued.
 */
export class TerminalPresentation {
  private readonly terminal: HeadlessTerminal;
  private readonly serializeAddon = new SerializeAddon();
  private parsedSeq: number;
  private disposed = false;
  private writtenSeq: number;
  private size: { cols: number; rows: number };
  private readonly recent: TerminalOutputChunk[] = [];
  private recentChars = 0;
  /** Output up to this seq can't be replayed: it came before the log, or before a resize. */
  private replayFloorSeq: number;
  // SerializeAddon restores mouse tracking but not its encoding, and a program that reads SGR
  // reports (a fullscreen agent scrolling by wheel) can't read the default one.
  private mouseEncoding: 1006 | 1016 | null = null;

  constructor(private readonly options: TerminalPresentationOptions) {
    this.parsedSeq = options.seq;
    this.writtenSeq = options.seq;
    this.replayFloorSeq = options.seq;
    this.size = { cols: options.cols, rows: options.rows };
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: 2000,
      convertEol: false,
      // SerializeAddon reads the headless buffer through xterm's proposed API.
      allowProposedApi: true,
    });
    this.terminal.loadAddon(this.serializeAddon);
    // Returning false lets xterm apply each sequence too.
    this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) =>
      this.trackMouseEncoding(params, true)
    );
    this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) =>
      this.trackMouseEncoding(params, false)
    );
    this.terminal.parser.registerEscHandler({ final: 'c' }, () => {
      this.mouseEncoding = null;
      return false;
    });
  }

  private trackMouseEncoding(params: (number | number[])[], on: boolean): boolean {
    for (const mode of params) {
      if (mode === 1006 || mode === 1016) this.mouseEncoding = on ? mode : null;
    }
    return false;
  }

  write(data: string, seq: number): void {
    if (this.disposed) return;
    this.writtenSeq = seq;
    this.recent.push({ data, seq });
    this.recentChars += data.length;
    while (this.recentChars > REPLAY_LIMIT_CHARS) {
      const dropped = this.recent.shift()!;
      this.recentChars -= dropped.data.length;
      this.replayFloorSeq = dropped.seq;
    }
    this.terminal.write(data, () => {
      this.parsedSeq = seq;
    });
  }

  /**
   * Output written after `seq`, oldest first, or null when some of it is no
   * longer kept or was laid out for another size.
   */
  outputSince(seq: number): TerminalOutputChunk[] | null {
    if (this.disposed || seq < this.replayFloorSeq || seq > this.writtenSeq) return null;
    return this.recent.filter((chunk) => chunk.seq > seq);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    if (cols !== this.size.cols || rows !== this.size.rows) {
      this.size = { cols, rows };
      this.replayFloorSeq = this.writtenSeq;
      this.recent.length = 0;
      this.recentChars = 0;
    }
    this.terminal.write('', () => {
      if (!this.disposed) this.terminal.resize(cols, rows);
    });
  }

  async snapshot(
    options: TerminalPresentationSnapshotOptions = {}
  ): Promise<TerminalPresentationSnapshot> {
    await new Promise<void>((resolve) => this.terminal.write('', resolve));
    const encoding = this.mouseEncoding === null ? '' : `\x1b[?${this.mouseEncoding}h`;
    return {
      buffer: this.serializeAddon.serialize(options) + encoding,
      ...this.metadata(),
    };
  }

  metadata(): TerminalPresentationMetadata {
    return {
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      generation: this.options.generation,
      seq: this.parsedSeq,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminal.dispose();
  }
}
