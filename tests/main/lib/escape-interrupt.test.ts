import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ESCAPE_CONFIRMATION_MS,
  EscapeInterrupts,
  isWorkingTitle,
} from '../../../src/main/lib/escape-interrupt';

describe('EscapeInterrupts', () => {
  let interrupt: ReturnType<typeof vi.fn<(terminalId: string, confirmed: boolean) => void>>;
  let escapes: EscapeInterrupts;
  beforeEach(() => {
    vi.useFakeTimers();
    interrupt = vi.fn<(terminalId: string, confirmed: boolean) => void>();
    escapes = new EscapeInterrupts(interrupt);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Recorded from Claude Code 2.1.301: under tmux its title stays `✳` while it works.
  it('counts Escape at once, unconfirmed, when the title shows no working agent', () => {
    escapes.escape('t1');
    escapes.title('t2', '✳ Claude Code');
    escapes.escape('t2');
    expect(interrupt.mock.calls).toEqual([
      ['t1', false],
      ['t2', false],
    ]);
  });

  // Recorded from Claude Code 2.1.296: an interrupting Escape turns the title idle within 70 ms.
  it('confirms Escape over a working title once the title stops spinning', () => {
    escapes.title('t1', '◐ Foreground sleep command test');
    escapes.escape('t1');
    expect(interrupt).not.toHaveBeenCalled();
    escapes.title('t1', '✳ Foreground sleep command test');
    expect(interrupt).toHaveBeenCalledWith('t1', true);
  });

  // An Escape that closes a menu while the agent works leaves the title spinning.
  it('ignores Escape when the title keeps spinning', () => {
    escapes.title('t1', '⠋ Running tests');
    escapes.escape('t1');
    escapes.title('t1', '⠙ Running tests');
    vi.advanceTimersByTime(ESCAPE_CONFIRMATION_MS);
    escapes.title('t1', 'Running tests');
    expect(interrupt).not.toHaveBeenCalled();
  });

  // Claude redraws its spinner about every second while it works; a title nothing redraws was
  // left behind by an agent that is gone.
  it('counts Escape, unconfirmed, when a working title stays frozen', () => {
    escapes.title('t1', '◐ Fix tests');
    escapes.escape('t1');
    vi.advanceTimersByTime(ESCAPE_CONFIRMATION_MS - 1);
    expect(interrupt).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(interrupt).toHaveBeenCalledWith('t1', false);
  });

  // Recorded from Codex 0.162.1: a new thread's title slot spins until Codex names the thread.
  it('confirms Escape when only the spinner of an unnamed Codex thread keeps going', () => {
    escapes.title('t1', '⠋ ⠋ | project');
    escapes.escape('t1');
    escapes.title('t1', '⠴ | project');
    expect(interrupt).toHaveBeenCalledWith('t1', true);
  });

  it("forgets a terminal's title when its process ends", () => {
    escapes.title('t1', '◑ Claude Code');
    escapes.escape('t1');
    escapes.title('t1', null);
    escapes.escape('t1');
    vi.advanceTimersByTime(ESCAPE_CONFIRMATION_MS);
    expect(interrupt.mock.calls).toEqual([['t1', false]]);
  });

  it.each([
    ['◐ Fix tests', true],
    ['⠋ Running tests', true],
    ['⠋ ⠋ | project', true],
    ['⠴ | project', false],
    ['✳ Fix tests', false],
    ['Running tests', false],
    ['', false],
  ])('recognises %j as a working title: %s', (title, working) => {
    expect(isWorkingTitle(title)).toBe(working);
  });
});
