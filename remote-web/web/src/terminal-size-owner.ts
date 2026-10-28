// Whose size the attached terminal follows.
//
// Someone using the terminal on the desktop takes its size back, and the desktop says so; this
// device takes it again with a resize, which the desktop confirms. What the desktop said before it
// heard that resize crossed it on the way, so it is ignored until the confirmation arrives.

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalSizeWord extends TerminalSize {
  terminalId: string;
  owner: 'desktop' | 'remote';
}

export class TerminalSizeOwner {
  private desktop: (TerminalSize & { terminalId: string }) | null = null;
  private claiming: string | null = null;

  /** The desktop's size for this terminal while the desktop has it, else null. */
  desktopSize(terminalId: string | null): TerminalSize | null {
    if (!this.desktop || this.desktop.terminalId !== terminalId) return null;
    return { cols: this.desktop.cols, rows: this.desktop.rows };
  }

  /**
   * Follows what the desktop said about the attached terminal: `desktop` to show it at the
   * desktop's size, `remote` to fit it to this screen again, or null when nothing changes.
   */
  follow(word: TerminalSizeWord, attachedTerminalId: string | null): 'desktop' | 'remote' | null {
    if (word.terminalId !== attachedTerminalId) return null;
    if (word.owner === 'remote') {
      if (this.claiming === word.terminalId) this.claiming = null;
      if (this.desktop?.terminalId !== word.terminalId) return null;
      this.desktop = null;
      return 'remote';
    }
    if (this.claiming === word.terminalId) return null;
    this.desktop = { terminalId: word.terminalId, cols: word.cols, rows: word.rows };
    return 'desktop';
  }

  /** Takes the size back for a resize about to be sent: the desktop's size it gave up, or null. */
  claim(terminalId: string | null): TerminalSize | null {
    const given = terminalId ? this.desktopSize(terminalId) : null;
    if (!given || !terminalId) return null;
    this.desktop = null;
    this.claiming = terminalId;
    return given;
  }

  /** The resize couldn't be sent, so the desktop still has the size. */
  unclaim(terminalId: string, size: TerminalSize): void {
    this.desktop = { terminalId, ...size };
    this.claiming = null;
  }

  /** A new attach takes the size with the size it asks for. */
  forget(): void {
    this.desktop = null;
    this.claiming = null;
  }
}
