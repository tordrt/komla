// What the phone accepts from a terminal's output stream, and pages of a workspace list.
//
// The desktop numbers each PTY read (`seq`) within a generation. A read too large for one frame
// arrives as several frames that share its seq, each but the last marked `more`.

import { encodedJsonBytes, splitJsonString } from '@komla/remote-protocol';

export interface TerminalDataFrameLike {
  generation: number;
  seq: number;
  more?: true;
}

/** Tracks how far the phone's terminal has applied output, so repeats and stale frames are skipped. */
export class TerminalStreamCursor {
  private currentGeneration = 0;
  private lastSeq = -1;
  /** The seq of a split read whose last piece hasn't arrived. */
  private openSeq: number | null = null;

  get generation(): number {
    return this.currentGeneration;
  }

  /** A snapshot or reset: everything up to `seq` of `generation` is on screen. */
  reset(generation: number, seq: number): void {
    this.currentGeneration = generation;
    this.lastSeq = seq;
    this.openSeq = null;
  }

  /** Nothing attached any more. */
  clear(): void {
    this.reset(0, -1);
  }

  /** What the screen shows, for a resumed attach; null mid-way through a split read or unattached. */
  resumePoint(): { generation: number; seq: number } | null {
    if (this.currentGeneration < 1 || this.lastSeq < 0 || this.openSeq !== null) return null;
    return { generation: this.currentGeneration, seq: this.lastSeq };
  }

  /** Whether to write this frame; moves past it if so. */
  accept(frame: TerminalDataFrameLike): boolean {
    if (frame.generation !== this.currentGeneration) return false;
    if (frame.seq <= this.lastSeq && frame.seq !== this.openSeq) return false;
    this.lastSeq = frame.seq;
    this.openSeq = frame.more ? frame.seq : null;
    return true;
  }
}

/** Collects `app:workspaces` pages by requestId until the page without `more` arrives. */
export class WorkspacePages<T> {
  private readonly pending = new Map<string, T[]>();

  /** The whole list once its last page is in, or null while pages are missing. */
  add(page: { requestId: string; workspaces: T[]; more?: true }): T[] | null {
    const collected = [...(this.pending.get(page.requestId) ?? []), ...page.workspaces];
    if (page.more) {
      this.pending.set(page.requestId, collected);
      return null;
    }
    this.pending.delete(page.requestId);
    return collected;
  }

  clear(): void {
    this.pending.clear();
  }
}

/** Splits typed or pasted text into pieces whose input frames each fit `maxBodyBytes`. */
export function splitTerminalInput(
  terminalId: string,
  data: string,
  maxBodyBytes: number
): string[] {
  const overhead = encodedJsonBytes({ type: 'app:terminal:input', terminalId, data: '' });
  return splitJsonString(data, maxBodyBytes - overhead);
}
