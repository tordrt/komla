/** A Markdown note kept outside the project, for drafting prompts and taking notes. */
export interface NoteSummary {
  /** The note's file name, which identifies it among its workspace's notes. */
  name: string;
  /** The note's first line of text; empty while the note is blank. */
  title: string;
  /** Where the note is on disk. */
  path: string;
  /** When the note was last changed, in milliseconds since the epoch. */
  modifiedMs: number;
}
