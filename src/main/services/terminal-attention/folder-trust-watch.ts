import type { FolderTrustAgent } from '../../../shared/types';

/** How long after a Terminal starts Komla looks for a folder trust prompt on its screen. */
export const FOLDER_TRUST_LOOK_MS = 60_000;
/** How long the Terminal stays quiet before its screen is read, so a redraw is read once. */
export const FOLDER_TRUST_QUIET_MS = 300;

export const FOLDER_TRUST_AGENT_NAMES: Record<FolderTrustAgent, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

const FOLDER_TRUST_AGENTS = Object.keys(FOLDER_TRUST_AGENT_NAMES) as FolderTrustAgent[];

/**
 * Each agent's prompt: an option only it offers, and the keys it lists below its options, which end
 * the screen while it asks. Text that quotes the prompt, such as a file a shell lists, or a prompt
 * left above the shell by an agent the user declined, ends with what follows it instead.
 */
const FOLDER_TRUST_PROMPTS: Record<FolderTrustAgent, { option: string; keys: string }> = {
  'claude-code': { option: 'Yes, I trust this folder', keys: 'Enter to confirm · Esc to cancel' },
  codex: { option: 'Trust and continue', keys: 'enter continue · esc back' },
};

function isFolderTrustAgent(source: string | undefined): source is FolderTrustAgent {
  return !!source && Object.hasOwn(FOLDER_TRUST_AGENT_NAMES, source);
}

/**
 * The agent whose folder trust prompt the screen shows. An agent wraps its own lines in a narrow
 * pane, so any run of spaces and line breaks counts as one space.
 */
export function findFolderTrustPrompt(screen: string): FolderTrustAgent | undefined {
  const text = screen.replace(/\s+/g, ' ').trim();
  return FOLDER_TRUST_AGENTS.find((agent) => {
    const { option, keys } = FOLDER_TRUST_PROMPTS[agent];
    return text.endsWith(keys) && text.includes(option);
  });
}

export interface FolderTrustWatchDependencies {
  /** The project of the Terminal's workspace; undefined for a workspace without one. */
  projectOf(terminalId: string): string | undefined;
  /** The agent has started in the project, so its prompt is no longer looked for there. */
  isDone(projectId: string, agent: FolderTrustAgent): boolean;
  /** Marks the agent done in the project; a no-op when it already is. */
  markDone(projectId: string, agent: FolderTrustAgent): void;
  /** What the Terminal shows as plain text; undefined once it isn't running here. */
  readScreen(terminalId: string): Promise<string | undefined>;
  /** The Terminal's agent asks the user to trust its folder. */
  asked(terminalId: string, agent: FolderTrustAgent): void;
  /** The prompt is gone: answered, or its Terminal ended. */
  answered(terminalId: string, agent: FolderTrustAgent): void;
}

interface Watch {
  quiet?: ReturnType<typeof setTimeout>;
  look?: ReturnType<typeof setTimeout>;
  /** The agent whose prompt the Terminal shows, as asked. */
  shown?: FolderTrustAgent;
  /** The agents done in the project as the Terminal started, whose prompts it doesn't look for. */
  done: Set<FolderTrustAgent>;
  reading: boolean;
  /** Output came while the screen was read, so it's read again. */
  readAgain: boolean;
  /** The output said "trust", so its screen is worth reading. Most Terminals never say it. */
  mentionedTrust: boolean;
  /** The end of the output so far, for a "trust" split across two chunks. */
  tail: string;
}

/**
 * Claude Code and Codex ask whether the user trusts a folder before they start in it. They run no
 * hook and report no status until the user answers, so the workspace would show nothing while they
 * wait. For a while after each Terminal starts, Komla reads its screen for that prompt, until the
 * agent has started once in the project.
 */
export class FolderTrustWatch {
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly deps: FolderTrustWatchDependencies) {}

  /** A Terminal's program started, or started again. */
  started(terminalId: string): void {
    this.ended(terminalId);
    const projectId = this.deps.projectOf(terminalId);
    const done = new Set(
      projectId ? FOLDER_TRUST_AGENTS.filter((agent) => this.deps.isDone(projectId, agent)) : []
    );
    if (done.size === FOLDER_TRUST_AGENTS.length) return;
    const watch: Watch = {
      reading: false,
      readAgain: false,
      mentionedTrust: false,
      tail: '',
      done,
    };
    watch.look = setTimeout(() => {
      watch.look = undefined;
      if (!watch.shown) this.stop(terminalId, watch);
    }, FOLDER_TRUST_LOOK_MS);
    this.watches.set(terminalId, watch);
  }

  /** The Terminal printed `data`. */
  output(terminalId: string, data: string): void {
    const watch = this.watches.get(terminalId);
    if (!watch) return;
    if (!watch.mentionedTrust) {
      const text = watch.tail + data;
      if (!/trust/i.test(text)) {
        watch.tail = text.slice(-4);
        return;
      }
      watch.mentionedTrust = true;
      watch.tail = '';
    }
    this.readWhenQuiet(terminalId, watch);
  }

  private readWhenQuiet(terminalId: string, watch: Watch): void {
    if (watch.reading) {
      watch.readAgain = true;
      return;
    }
    clearTimeout(watch.quiet);
    watch.quiet = setTimeout(() => void this.read(terminalId, watch), FOLDER_TRUST_QUIET_MS);
  }

  /** The Terminal's program exited, or the Terminal closed. */
  ended(terminalId: string): void {
    const watch = this.watches.get(terminalId);
    if (!watch) return;
    if (watch.shown) this.deps.answered(terminalId, watch.shown);
    this.stop(terminalId, watch);
  }

  /**
   * An agent ran a hook or reported its status, so it got past any folder trust prompt: it's done
   * in the project, and its Terminal is no longer watched.
   */
  agentReported(
    projectId: string | null | undefined,
    source: string | undefined,
    terminalId?: string
  ): void {
    if (!isFolderTrustAgent(source)) return;
    if (projectId) this.deps.markDone(projectId, source);
    if (terminalId) this.ended(terminalId);
  }

  dispose(): void {
    for (const [terminalId, watch] of this.watches) this.stop(terminalId, watch);
  }

  private async read(terminalId: string, watch: Watch): Promise<void> {
    watch.quiet = undefined;
    watch.reading = true;
    const screen = await this.deps.readScreen(terminalId).catch(() => undefined);
    watch.reading = false;
    if (this.watches.get(terminalId) !== watch) return;

    let agent = screen === undefined ? undefined : findFolderTrustPrompt(screen);
    // Another Terminal's agent starting since doesn't answer this one's prompt.
    if (agent && watch.done.has(agent)) agent = undefined;
    if (agent !== watch.shown) {
      if (watch.shown) this.deps.answered(terminalId, watch.shown);
      if (!agent) {
        // Answered: what follows is the agent's.
        this.stop(terminalId, watch);
        return;
      }
      watch.shown = agent;
      this.deps.asked(terminalId, agent);
    }
    if (watch.readAgain && this.watches.get(terminalId) === watch) {
      watch.readAgain = false;
      this.readWhenQuiet(terminalId, watch);
    }
  }

  private stop(terminalId: string, watch: Watch): void {
    clearTimeout(watch.quiet);
    clearTimeout(watch.look);
    if (this.watches.get(terminalId) === watch) this.watches.delete(terminalId);
  }
}
