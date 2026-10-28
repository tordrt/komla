/**
 * Shared agent profile registry for screenshot generation.
 *
 * Set AGENT=claude|codex|gemini|opencode to target a specific agent.
 * Defaults to claude (unsuffixed output filenames for backwards compatibility).
 */

export type AgentId = 'claude' | 'codex' | 'gemini' | 'opencode';

export interface AgentProfile {
  id: AgentId;
  displayName: string;
  command: string;
  continueCommand: string;
  promptCommand: string;
  utilityCommand: string;
  branchPrefix: string;
  notificationSource: string;
  presetId: string;
  launchModes?: Array<{ id: string; name: string; command: string; color: string }>;
  /**
   * Whether the agent can emit an `input-required` notification (permission prompts,
   * tool approval, etc.). Used to swap the Input badge for the finish badge in
   * screenshots when false.
   */
  supportsInputRequired: boolean;
  /**
   * Whether the agent emits prompt-submit notifications that drive the active/spinner
   * state. When false, the notifications GIF skips the spinner-only phase.
   */
  supportsSpinner: boolean;
  /**
   * The notification kind the agent emits when a turn finishes.
   * - `turn-complete` → renders a Done badge (all agents today)
   * - `idle` → renders an Idle badge (for agents that don't distinguish turn end)
   */
  finishKind: 'turn-complete' | 'idle';
  /**
   * Whether the Fix Nav Bug workspace is pre-seeded with an Idle badge before
   * any frames are captured (so idle is visible from frame 0 and the Phase 2
   * nav transition is skipped). Currently false for every agent — reserved for
   * agents whose real-world flow keeps Idle present throughout a turn.
   */
  navStartsIdle: boolean;
}

export const AGENT_PROFILES: Record<AgentId, AgentProfile> = {
  claude: {
    id: 'claude',
    displayName: 'Claude Code',
    command: 'claude',
    continueCommand: 'claude --continue',
    promptCommand: 'claude {{prompt}}',
    utilityCommand: 'claude -p --model haiku --effort low',
    branchPrefix: '',
    notificationSource: 'claude-code',
    presetId: 'screenshot-claude-preset',
    supportsInputRequired: true,
    supportsSpinner: true,
    finishKind: 'turn-complete',
    navStartsIdle: false,
    launchModes: [
      {
        id: 'claude-plan',
        name: 'Plan',
        command: 'claude --permission-mode plan {{prompt}}',
        color: 'blue',
      },
      {
        id: 'claude-accept-edits',
        name: 'Accept edits',
        command: 'claude --permission-mode acceptEdits {{prompt}}',
        color: 'purple',
      },
      {
        id: 'claude-yolo',
        name: 'Dangerously skip permissions',
        command: 'claude --dangerously-skip-permissions {{prompt}}',
        color: 'red',
      },
    ],
  },
  codex: {
    id: 'codex',
    displayName: 'Codex',
    command: 'codex',
    continueCommand: 'codex resume --last',
    promptCommand: 'codex {{prompt}}',
    utilityCommand: 'codex exec --model gpt-5.4-mini -c model_reasoning_effort="none"',
    branchPrefix: 'codex/',
    notificationSource: 'codex-cli',
    presetId: 'screenshot-codex-preset',
    supportsInputRequired: true,
    supportsSpinner: true,
    finishKind: 'turn-complete',
    navStartsIdle: false,
    launchModes: [
      {
        id: 'codex-full-auto',
        name: 'Full auto',
        command: 'codex --sandbox workspace-write --ask-for-approval never {{prompt}}',
        color: 'purple',
      },
      {
        id: 'codex-yolo',
        name: 'Dangerously skip permissions',
        command: 'codex --dangerously-bypass-approvals-and-sandbox {{prompt}}',
        color: 'red',
      },
    ],
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini CLI',
    command: 'gemini',
    continueCommand: 'gemini --resume latest',
    promptCommand: 'gemini -- {{prompt}}',
    utilityCommand: 'gemini -p -m gemini-2.5-flash',
    branchPrefix: 'gemini/',
    notificationSource: 'gemini-cli',
    presetId: 'screenshot-gemini-preset',
    supportsInputRequired: true,
    supportsSpinner: true,
    finishKind: 'turn-complete',
    navStartsIdle: false,
    launchModes: [
      {
        id: 'gemini-plan',
        name: 'Plan',
        command: 'gemini --approval-mode plan -- {{prompt}}',
        color: 'blue',
      },
      {
        id: 'gemini-accept-edits',
        name: 'Accept edits',
        command: 'gemini --approval-mode auto_edit -- {{prompt}}',
        color: 'purple',
      },
      {
        id: 'gemini-yolo',
        name: 'YOLO',
        command: 'gemini --approval-mode yolo -- {{prompt}}',
        color: 'red',
      },
    ],
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    continueCommand: 'opencode --continue',
    promptCommand: 'opencode --prompt {{prompt}}',
    utilityCommand: 'opencode --prompt',
    branchPrefix: 'oc/',
    notificationSource: 'opencode',
    presetId: 'screenshot-opencode-preset',
    supportsInputRequired: true,
    supportsSpinner: true,
    finishKind: 'turn-complete',
    navStartsIdle: false,
    launchModes: [
      {
        id: 'opencode-plan',
        name: 'Plan',
        command: 'opencode --agent plan --prompt {{prompt}}',
        color: 'blue',
      },
    ],
  },
};

const rawId = (process.env.AGENT as AgentId) || 'claude';
if (!AGENT_PROFILES[rawId]) {
  throw new Error(`Unknown AGENT: ${rawId}. Valid: ${Object.keys(AGENT_PROFILES).join(', ')}`);
}

export const AGENT = AGENT_PROFILES[rawId];
export const AGENT_SUFFIX = AGENT.id === 'claude' ? '' : `-${AGENT.id}`;

/** Build the presets array for agent-presets.json, with the active agent marked as most recent. */
export function buildPresetsJson(now: number = Date.now()) {
  const presets = Object.values(AGENT_PROFILES).map((profile) => {
    // IS_DEMO=1 hides the active user's email and other PII in Claude Code's
    // UI — important since these screenshots ship to the marketing site.
    const command = profile.id === 'claude' ? `IS_DEMO=1 ${profile.command}` : profile.command;
    return {
      id: profile.presetId,
      name: profile.displayName,
      openCommand: command,
      // Seeded workspaces have no prior agent session, so resume uses the
      // plain open command instead of profile.continueCommand (e.g. claude
      // --continue would fail with "no conversation found").
      continueCommand: command,
      promptCommand: profile.promptCommand,
      utilityCommand: profile.utilityCommand,
      ...(profile.launchModes ? { launchModes: profile.launchModes } : {}),
      isBuiltin: true,
    };
  });
  const activePresets = Object.values(AGENT_PROFILES).map((profile, index) => ({
    presetId: profile.presetId,
    lastUsedAt: profile.id === AGENT.id ? now : now - (index + 1) * 1000,
  }));
  return { presets, activePresets };
}
