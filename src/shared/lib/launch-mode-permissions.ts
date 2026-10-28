import type { DesiredWorkspaceEnvironment } from './agent-environment';
import type { AgentLaunchPolicy, LaunchMode } from '../types/agent-preset';
import type { SshHost } from '../types/ssh';

const AGENT_LAUNCH_POLICIES: readonly unknown[] = ['never', 'isolated', 'always'];

// Flags of the built-in launch modes that let an agent act without asking first
// (Claude Code, Codex, Amp, Grok, Antigravity, Gemini, Qwen, Copilot, Cursor,
// OpenCode, Hermes, Factory Droid, Devin, Kiro), plus Gemini's and Qwen's `-y`
// and Codex's sandbox off. Droid's `--auto low` and `--auto medium` still ask
// before riskier commands, like the other agents' middle tiers, and Codex's
// `--ask-for-approval never` stays inside its sandbox.
const PERMISSION_SKIPPING_FLAGS =
  /--dangerously-|bypass|danger-full-access|--yolo\b|(?:^|\s)-y(?=\s|$)|approval-mode[= ]yolo\b|--allow-all|--trust-all-tools\b|--force(?=[\s=]|$)|--auto(?![\s=]+(?:low|medium)\b)(?=[\s=]|$)/i;

export function skipsPermissionPrompts(mode: Pick<LaunchMode, 'arguments'>): boolean {
  return PERMISSION_SKIPPING_FLAGS.test(mode.arguments ?? '');
}

/**
 * Where an agent may start this mode itself, through `komla agent launch` or the
 * MCP spawn tools. The user's choice on the mode decides; without one, agents may
 * start modes that still ask before acting anywhere, and the others only isolated.
 */
export function agentLaunchPolicy(
  mode: Pick<LaunchMode, 'arguments' | 'agentLaunch'>
): AgentLaunchPolicy {
  // A hand-edited presets file can hold any value.
  if (AGENT_LAUNCH_POLICIES.includes(mode.agentLaunch)) return mode.agentLaunch!;
  return skipsPermissionPrompts(mode) ? 'isolated' : 'always';
}

/** Whether an agent may start a mode with this policy where the new agent would run. */
export function agentsMayLaunch(policy: AgentLaunchPolicy, isolated: boolean): boolean {
  return policy === 'always' || (policy === 'isolated' && isolated);
}

/** Whether an agent there runs apart from this computer: on a host the user marked isolated. */
export function isIsolatedEnvironment(
  environment: DesiredWorkspaceEnvironment,
  places: { sshHosts: ReadonlyArray<Pick<SshHost, 'id' | 'isolated'>> }
): boolean {
  if (environment.kind === 'ssh') {
    return places.sshHosts.some((host) => host.id === environment.hostId && host.isolated === true);
  }
  return false;
}
