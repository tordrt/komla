type Status = 'activity' | 'turn-complete';

const SPINNER = '[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]';
const UNNAMED_THREAD_SPINNER = new RegExp(`${SPINNER}(?= \\| )`);
const WORKING_TITLE = new RegExp(`^${SPINNER} (\\S.*)$`);

/**
 * Codex spins in the thread-title slot until it names a new thread, which can
 * outlast the first turn's Stop by seconds. It is not task activity.
 */
function withoutUnnamedThreadSpinner(title: string): string {
  return title.replace(UNNAMED_THREAD_SPINNER, '…');
}

interface TitleState {
  workingTitle?: string;
  working: boolean;
  pending?: ReturnType<typeof setTimeout>;
}

/**
 * Conservative fallback for Codex turns (including /review) without a root Stop.
 * Only a hook-identified Codex terminal and an observed spinner -> same title
 * transition count. Silence, arbitrary text, and unknown title formats do not.
 * Codex's title spinner is driven by its TUI task-running state.
 */
export class CodexTitleStatus {
  private states = new Map<string, TitleState>();

  constructor(private readonly emit: (terminalId: string, status: Status) => void) {}

  hook(terminalId: string, source: string | undefined, kind: string | undefined): void {
    if (source !== 'codex') {
      this.close(terminalId);
      return;
    }
    const state = this.states.get(terminalId) ?? { working: false };
    this.cancel(state);
    // A completed hook owns completion; do not notify again on the title change.
    if (
      kind === 'turn-complete' ||
      kind === 'idle' ||
      kind === 'prompt-submit' ||
      kind === 'interrupted'
    ) {
      state.working = false;
      state.workingTitle = undefined;
    }
    this.states.set(terminalId, state);
  }

  title(terminalId: string, rawTitle: string): void {
    const state = this.states.get(terminalId);
    if (!state) return;
    const title = withoutUnnamedThreadSpinner(rawTitle);
    // Default Codex activity item is a leading braille spinner. Custom layouts
    // are intentionally unsupported instead of broadening the inference.
    const working = WORKING_TITLE.exec(title);
    if (working) {
      this.cancel(state);
      state.working = true;
      state.workingTitle = working[1];
      // Every working frame is evidence against a settling Stop, even when
      // the displayed spinner was already active before that hook arrived.
      this.emit(terminalId, 'activity');
      return;
    }
    if (!state.working || title !== state.workingTitle) {
      this.cancel(state);
      // A shell title, approval title, or empty title invalidates the cycle.
      state.working = false;
      state.workingTitle = undefined;
      return;
    }
    if (state.pending) return;
    state.pending = setTimeout(() => {
      state.pending = undefined;
      state.working = false;
      state.workingTitle = undefined;
      this.emit(terminalId, 'turn-complete');
    }, 2000);
  }

  close(terminalId: string): void {
    const state = this.states.get(terminalId);
    if (state) this.cancel(state);
    this.states.delete(terminalId);
  }

  clear(): void {
    for (const terminalId of this.states.keys()) this.close(terminalId);
  }

  private cancel(state: TitleState): void {
    if (state.pending) clearTimeout(state.pending);
    state.pending = undefined;
  }
}
