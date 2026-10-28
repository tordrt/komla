/**
 * A title an agent CLI shows while working: a braille spinner, or Claude's ◐◑◒◓. A spinner
 * right before " | " is Codex naming a new thread, which can outlast its turn.
 */
const WORKING_TITLE = /^\s*[⠀-⣿◐-◓](?! \| )/;

/** How long after an Escape the title may take to stop spinning. */
export const ESCAPE_CONFIRMATION_MS = 5000;

export function isWorkingTitle(title: string): boolean {
  return WORKING_TITLE.test(title);
}

/**
 * Escape interrupts a working agent, but it also closes menus while the agent keeps working,
 * and no hook reports either. While the terminal title shows the agent working, an Escape is
 * confirmed once the title stops spinning soon after. Otherwise it counts at once, unconfirmed,
 * as it does when the title stays frozen: an agent that is drawing updates its spinner.
 */
export class EscapeInterrupts {
  private titles = new Map<string, string>();
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; drawn: boolean }>();

  constructor(private readonly interrupt: (terminalId: string, confirmed: boolean) => void) {}

  escape(terminalId: string): void {
    if (!isWorkingTitle(this.titles.get(terminalId) ?? '')) {
      this.interrupt(terminalId, false);
      return;
    }
    this.cancel(terminalId);
    const pending = {
      drawn: false,
      timer: setTimeout(() => {
        this.pending.delete(terminalId);
        if (!pending.drawn) this.interrupt(terminalId, false);
      }, ESCAPE_CONFIRMATION_MS),
    };
    this.pending.set(terminalId, pending);
  }

  /** null ends the terminal's process. */
  title(terminalId: string, title: string | null): void {
    if (title === null) {
      this.cancel(terminalId);
      this.titles.delete(terminalId);
      return;
    }
    this.titles.set(terminalId, title);
    const pending = this.pending.get(terminalId);
    if (!pending) return;
    if (isWorkingTitle(title)) {
      pending.drawn = true;
      return;
    }
    this.cancel(terminalId);
    this.interrupt(terminalId, true);
  }

  private cancel(terminalId: string): void {
    clearTimeout(this.pending.get(terminalId)?.timer);
    this.pending.delete(terminalId);
  }
}
