import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FOLDER_TRUST_LOOK_MS,
  FOLDER_TRUST_QUIET_MS,
  FolderTrustWatch,
  findFolderTrustPrompt,
} from '../../../src/main/services/terminal-attention/folder-trust-watch';

import type { FolderTrustAgent } from '../../../src/shared/types';

// Rendered from Claude Code 2.1.319 at 120 columns, as a new folder first opens it.
const CLAUDE_TRUST_SCREEN = `────────────────────────────────────────────────────────────────────────
 Accessing workspace:
 /home/me/.komla/worktrees/app/wise-quartz
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`;

// The same prompt in a narrow pane, where Claude Code wraps every line itself.
const NARROW_CLAUDE_TRUST_SCREEN = ` Quick safety check: Is this a project you created or
 one you trust?
 ❯ No, exit
   Yes, I trust
   this folder
 Enter to confirm · Esc
 to cancel`;

// Rendered from Codex 0.166 at 120 columns.
const CODEX_TRUST_SCREEN = `
  Folder access
  /home/me/.komla/worktrees/app/wise-quartz

  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings
  can run code automatically, even without a model request. Continue only if you trust these files. Your trust
  decision will be saved.

› 1. Trust and continue
  2. Back to Agent Command Center

  enter continue · esc back`;


describe('findFolderTrustPrompt', () => {
  it("finds Claude Code's prompt", () => {
    expect(findFolderTrustPrompt(CLAUDE_TRUST_SCREEN)).toBe('claude-code');
  });

  it("finds Claude Code's prompt wrapped in a narrow pane", () => {
    expect(findFolderTrustPrompt(NARROW_CLAUDE_TRUST_SCREEN)).toBe('claude-code');
  });

  it("finds Codex's prompt", () => {
    expect(findFolderTrustPrompt(CODEX_TRUST_SCREEN)).toBe('codex');
  });

  it('finds nothing on a shell or an agent that already started', () => {
    expect(findFolderTrustPrompt('')).toBeUndefined();
    expect(findFolderTrustPrompt('me@host ~/app $ claude')).toBeUndefined();
    expect(
      findFolderTrustPrompt(' ✻ Welcome to Claude Code!\n\n > Try "fix lint errors"\n')
    ).toBeUndefined();
    // An answer that mentions trust is no prompt.
    expect(findFolderTrustPrompt('Do you trust this folder? I can check that for you.')).toBe(
      undefined
    );
  });

  it('finds nothing in a listing that quotes a prompt, which ends with what follows it', () => {
    expect(findFolderTrustPrompt(`me@host ~/app $ cat prompts.txt\n${CODEX_TRUST_SCREEN}\nme@host ~/app $`)).toBe(
      undefined
    );
    expect(findFolderTrustPrompt(`${CLAUDE_TRUST_SCREEN}\n:`)).toBeUndefined();
  });

  it('finds nothing once the agent declined and left its prompt above the shell', () => {
    expect(findFolderTrustPrompt(`$ claude\n${CLAUDE_TRUST_SCREEN}\n$`)).toBeUndefined();
  });
});

/** A watch over Terminals t1 (project p1) and t2 (no project), whose screens the test sets. */
function harness() {
  const screens = new Map<string, string | undefined>();
  const done = new Map<string, Set<FolderTrustAgent>>();
  const projects = new Map<string, string | undefined>([
    ['t1', 'p1'],
    ['t2', undefined],
  ]);
  const deps = {
    projectOf: vi.fn((terminalId: string) => projects.get(terminalId)),
    isDone: vi.fn(
      (projectId: string, agent: FolderTrustAgent) => done.get(projectId)?.has(agent) ?? false
    ),
    markDone: vi.fn((projectId: string, agent: FolderTrustAgent) => {
      done.set(projectId, new Set([...(done.get(projectId) ?? []), agent]));
    }),
    readScreen: vi.fn((terminalId: string) => Promise.resolve(screens.get(terminalId))),
    asked: vi.fn<(terminalId: string, agent: FolderTrustAgent) => void>(),
    answered: vi.fn<(terminalId: string, agent: FolderTrustAgent) => void>(),
  };
  const watch = new FolderTrustWatch(deps);
  return {
    watch,
    deps,
    projects,
    done,
    /** The Terminal prints, then goes quiet showing `screen`. */
    shows: async (terminalId: string, screen: string) => {
      screens.set(terminalId, screen);
      watch.output(terminalId, screen);
      await vi.advanceTimersByTimeAsync(FOLDER_TRUST_QUIET_MS);
    },
  };
}

describe('FolderTrustWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks once the prompt shows and the Terminal goes quiet', async () => {
    const { watch, deps, shows } = harness();
    watch.started('t1');
    await shows('t1', 'Loading…');
    expect(deps.asked).not.toHaveBeenCalled();

    await shows('t1', CLAUDE_TRUST_SCREEN);
    expect(deps.asked).toHaveBeenCalledExactlyOnceWith('t1', 'claude-code');

    // The prompt redraws as the user moves between its options.
    await shows('t1', CLAUDE_TRUST_SCREEN.replace('❯ No', '  No'));
    expect(deps.asked).toHaveBeenCalledOnce();
  });

  it('reads the screen once the output stops, not on every chunk', async () => {
    const { watch, deps } = harness();
    watch.started('t1');
    for (let chunk = 0; chunk < 10; chunk += 1) {
      watch.output('t1', 'Do you trust this folder?');
      await vi.advanceTimersByTimeAsync(FOLDER_TRUST_QUIET_MS / 2);
    }
    expect(deps.readScreen).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FOLDER_TRUST_QUIET_MS);
    expect(deps.readScreen).toHaveBeenCalledOnce();
  });

  it('reads no screen until the output mentions trust, as a shell or dev server never does', async () => {
    const { watch, deps } = harness();
    watch.started('t1');
    watch.output('t1', 'me@host ~/app $ npm run dev\r\n');
    watch.output('t1', '\x1b[32mready\x1b[0m in 312 ms\r\n');
    await vi.advanceTimersByTimeAsync(FOLDER_TRUST_QUIET_MS);
    expect(deps.readScreen).not.toHaveBeenCalled();

    // A word split across two chunks still counts, in any case.
    watch.output('t1', '\x1b[1mYes, I TR');
    watch.output('t1', 'UST this folder');
    await vi.advanceTimersByTimeAsync(FOLDER_TRUST_QUIET_MS);
    expect(deps.readScreen).toHaveBeenCalledOnce();
  });

  it('takes the request back once the prompt is answered', async () => {
    const { watch, deps, shows } = harness();
    watch.started('t1');
    await shows('t1', CODEX_TRUST_SCREEN);
    await shows('t1', ' >_ OpenAI Codex (v0.166.0)\n\n › ');
    expect(deps.answered).toHaveBeenCalledExactlyOnceWith('t1', 'codex');

    // It stopped watching: the Terminal is the agent's now.
    deps.readScreen.mockClear();
    await shows('t1', CODEX_TRUST_SCREEN);
    expect(deps.readScreen).not.toHaveBeenCalled();
    expect(deps.asked).toHaveBeenCalledOnce();
  });

  it('takes the request back when the Terminal ends or starts again', async () => {
    const { watch, deps, shows } = harness();
    watch.started('t1');
    await shows('t1', CLAUDE_TRUST_SCREEN);
    watch.ended('t1');
    expect(deps.answered).toHaveBeenCalledExactlyOnceWith('t1', 'claude-code');

    watch.started('t1');
    await shows('t1', CLAUDE_TRUST_SCREEN);
    watch.started('t1');
    expect(deps.answered).toHaveBeenCalledTimes(2);
  });

  it('stops looking a while after the Terminal started', async () => {
    const { watch, deps, shows } = harness();
    watch.started('t1');
    await vi.advanceTimersByTimeAsync(FOLDER_TRUST_LOOK_MS);
    await shows('t1', CLAUDE_TRUST_SCREEN);
    expect(deps.readScreen).not.toHaveBeenCalled();
    expect(deps.asked).not.toHaveBeenCalled();
  });

  it('keeps a prompt it found past that time until it is answered', async () => {
    const { watch, deps, shows } = harness();
    watch.started('t1');
    await shows('t1', CLAUDE_TRUST_SCREEN);
    await vi.advanceTimersByTimeAsync(FOLDER_TRUST_LOOK_MS);
    expect(deps.answered).not.toHaveBeenCalled();
    await shows('t1', ' ✻ Welcome to Claude Code!');
    expect(deps.answered).toHaveBeenCalledExactlyOnceWith('t1', 'claude-code');
  });

  it("marks the project done once its agent reports, and takes back that Terminal's request", async () => {
    const { watch, deps, shows } = harness();
    watch.started('t1');
    await shows('t1', CLAUDE_TRUST_SCREEN);

    watch.agentReported('p1', 'claude-code', 't1');
    expect(deps.markDone).toHaveBeenCalledExactlyOnceWith('p1', 'claude-code');
    expect(deps.answered).toHaveBeenCalledExactlyOnceWith('t1', 'claude-code');

  });

  it("still asks in a Terminal whose prompt shows after another Terminal's agent started", async () => {
    const { watch, deps, shows, projects } = harness();
    projects.set('t3', 'p1');
    watch.started('t1');
    watch.started('t3');
    // Both agents ask; the user answers in t1 before t3 went quiet.
    watch.agentReported('p1', 'claude-code', 't1');
    await shows('t3', CLAUDE_TRUST_SCREEN);
    expect(deps.asked).toHaveBeenCalledExactlyOnceWith('t3', 'claude-code');
  });

  it("never asks again for an agent that's done in the project", async () => {
    const { watch, deps, shows, done } = harness();
    done.set('p1', new Set(['claude-code']));
    watch.started('t1');
    await shows('t1', CLAUDE_TRUST_SCREEN);
    expect(deps.asked).not.toHaveBeenCalled();

    // Codex still asks the first time.
    await shows('t1', CODEX_TRUST_SCREEN);
    expect(deps.asked).toHaveBeenCalledExactlyOnceWith('t1', 'codex');
  });

  it("doesn't watch a project's Terminals once every agent is done there", async () => {
    const { watch, deps, shows, done } = harness();
    done.set('p1', new Set(['claude-code', 'codex']));
    watch.started('t1');
    await shows('t1', CLAUDE_TRUST_SCREEN);
    expect(deps.readScreen).not.toHaveBeenCalled();
  });

  it('asks every time in a workspace without a project, which has nothing to remember it in', async () => {
    const { watch, deps, shows } = harness();
    watch.started('t2');
    await shows('t2', CLAUDE_TRUST_SCREEN);
    watch.agentReported(undefined, 'claude-code', 't2');
    expect(deps.markDone).not.toHaveBeenCalled();

    watch.started('t2');
    await shows('t2', CLAUDE_TRUST_SCREEN);
    expect(deps.asked).toHaveBeenCalledTimes(2);
  });

  it("ignores reports from sources that ask no folder trust, such as a command's", () => {
    const { watch, deps } = harness();
    watch.agentReported('p1', 'command', 't1');
    watch.agentReported('p1', undefined, 't1');
    expect(deps.markDone).not.toHaveBeenCalled();
  });

  it("drops a screen read that finishes after the Terminal's watch ended", async () => {
    const { watch, deps } = harness();
    let finish: (screen: string) => void = () => {};
    deps.readScreen.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    watch.started('t1');
    watch.output('t1', CLAUDE_TRUST_SCREEN);
    await vi.advanceTimersByTimeAsync(FOLDER_TRUST_QUIET_MS);
    watch.ended('t1');
    finish(CLAUDE_TRUST_SCREEN);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.asked).not.toHaveBeenCalled();
  });
});
