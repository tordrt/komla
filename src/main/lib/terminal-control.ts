// Komla-private OSC emitted by the remote launcher once SSH has started the
// remote command. Main strips it before terminal output reaches the renderer.
export const REMOTE_READY_SHELL_COMMAND = "printf '\\033]7337;remote-ready\\007'";
export const MANAGED_REMOTE_TERMINAL_SESSION_REPLACED_SHELL_COMMAND =
  "printf '\\033]7337;managed-remote-terminal-session-replaced\\007'";
export const SSH_TERMINAL_POOL_ASSIGNMENT_OSC_PREFIX = '\\033]7337;ssh-terminal-pool=';
// Candidates are introduced lazily; this ceiling only guards against an
// unbounded connection loop if capacity failures are repeatedly misreported.
export const SSH_TERMINAL_POOL_INDICES = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
] as const;

export type SshTerminalPoolIndex = (typeof SSH_TERMINAL_POOL_INDICES)[number];
export type SshTerminalPoolAssignment =
  | { kind: 'pooled'; poolIndex: SshTerminalPoolIndex }
  | { kind: 'standalone' };

// oxlint-disable-next-line no-control-regex
const REMOTE_READY_OSC_REGEX = /\x1b\]7337;remote-ready(?:\x07|\x1b\\)/g;
const MANAGED_REMOTE_TERMINAL_SESSION_REPLACED_OSC_REGEX = new RegExp(
  '\\u001b\\]7337;managed-remote-terminal-session-replaced(?:\\u0007|\\u001b\\\\)', // oxlint-disable-line no-control-regex
  'g'
);
const SSH_TERMINAL_POOL_ASSIGNMENT_OSC_REGEX = new RegExp(
  '\\u001b\\]7337;ssh-terminal-pool=([^\\u0007\\u001b]*)(?:\\u0007|\\u001b\\\\)', // oxlint-disable-line no-control-regex
  'g'
);

export function extractRemoteReadyOsc(data: string): {
  remoteReady: boolean;
  cleaned: string;
} {
  let remoteReady = false;
  const cleaned = data.replace(REMOTE_READY_OSC_REGEX, () => {
    remoteReady = true;
    return '';
  });
  return { remoteReady, cleaned };
}

export function extractManagedRemoteTerminalSessionReplacedOsc(data: string): {
  replaced: boolean;
  cleaned: string;
} {
  let replaced = false;
  const cleaned = data.replace(MANAGED_REMOTE_TERMINAL_SESSION_REPLACED_OSC_REGEX, () => {
    replaced = true;
    return '';
  });
  return { replaced, cleaned };
}

export function extractSshTerminalPoolAssignmentOsc(data: string): {
  assignments: SshTerminalPoolAssignment[];
  cleaned: string;
} {
  const assignments: SshTerminalPoolAssignment[] = [];
  const cleaned = data.replace(SSH_TERMINAL_POOL_ASSIGNMENT_OSC_REGEX, (_, value: string) => {
    if (value === 'standalone') {
      assignments.push({ kind: 'standalone' });
    } else {
      const poolIndex = SSH_TERMINAL_POOL_INDICES.find((candidate) => String(candidate) === value);
      if (poolIndex !== undefined) {
        assignments.push({ kind: 'pooled', poolIndex });
      }
    }
    return '';
  });
  return { assignments, cleaned };
}
