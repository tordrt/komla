import type { AgentsMenuBarTheme } from './agents-menu-bar';

/** The smallest the prompt draft gets, in the window or popped out, in CSS pixels. */
export const PROMPT_DRAFT_MIN_SIZE = { width: 280, height: 140 } as const;

/**
 * The longest a popped-out draft gets: far more than a prompt needs, short of what would stall the
 * windows it passes between.
 */
export const PROMPT_DRAFT_MAX_LENGTH = 1_000_000;

/** The prompt draft's text, with the cursor or selection in it. */
export interface PromptDraftText {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/** Where the draft was in its Komla window as it popped out, in CSS pixels from the page's top left. */
export interface PromptDraftRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a Komla window offers the popped-out draft, which refers to the window used last. */
export interface PromptDraftWindowContext {
  /** Komla's theme, for the draft's window to match. */
  theme: AgentsMenuBarTheme;
  /** The workspace on screen, where the draft is saved as a note; null for none. */
  workspaceId: string | null;
  /** The name of the file on screen there, which the draft can refer to; null for none. */
  viewedFileName: string | null;
}

/** Whether the draft has popped out of Komla's windows, and whether its window shows. */
export interface PromptDraftWindowStatus {
  poppedOut: boolean;
  visible: boolean;
}
