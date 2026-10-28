import { win32 as pathWin32 } from 'path';

import { shellQuotePosix, shellQuotePowerShell } from '../../../shared/lib/shell-quote';
import {
  escapeNativeArgument,
  withLegacyNativeArguments,
} from '../../lib/powershell-native-arguments';
import { sshTarget } from '../../lib/ssh-client';
import {
  SSH_TERMINAL_POOL_ASSIGNMENT_OSC_PREFIX,
  SSH_TERMINAL_POOL_INDICES,
} from '../../lib/terminal-control';
import { isWslMode, windowsPathToWsl } from '../../lib/wsl';

import { SSH_CONTROL_PERSIST_SECONDS, sshControlPath, sshOptionArgs } from './policy';

import type { SshHost } from '../../../shared/types';
import type { SshTerminalPoolAssignment, SshTerminalPoolIndex } from '../../lib/terminal-control';

interface TerminalPoolMember {
  terminalIds: Set<string>;
  saturated: boolean;
}

interface TerminalPoolReservation {
  poolKey: string;
  assignment: SshTerminalPoolAssignment;
}

export class SshTerminalPool {
  private pools = new Map<string, Map<SshTerminalPoolIndex, TerminalPoolMember>>();
  private assignments = new Map<string, TerminalPoolReservation>();

  buildCommand(
    host: SshHost,
    terminalId: string,
    remoteCommand: string,
    reconnect: boolean,
    /** Variables for the local ssh, such as Komla's askpass. Ignored on native Windows. */
    env: NodeJS.ProcessEnv = {},
    /** Options for every ssh it runs, after the host's own. */
    connectionArgs: string[] = []
  ): string {
    const poolIndices = sshControlPath(host, { kind: 'terminal', poolIndex: 0 })
      ? this.reserveCandidates(host, terminalId)
      : [];
    const controlPaths = poolIndices
      .map((poolIndex) => ({
        poolIndex,
        path: sshControlPath(host, { kind: 'terminal', poolIndex }),
      }))
      .filter((candidate): candidate is { poolIndex: SshTerminalPoolIndex; path: string } =>
        Boolean(candidate.path)
      );
    const controlPath = controlPaths[0]?.path;
    const standaloneArgs = [
      ...sshOptionArgs(host, true),
      ...connectionArgs,
      ...(controlPath ? ['-o', 'ControlPath=none'] : []),
      sshTarget(host),
      remoteCommand,
    ];
    const standaloneSshCommand = ['ssh', ...standaloneArgs.map(shellQuotePosix)].join(' ');
    let terminalCommand = standaloneSshCommand;

    if (controlPath) {
      const pooledSshCommand = (
        tty: boolean,
        createMaster: boolean,
        trailingArgs: string[]
      ): string => {
        const argsBeforeControlPath = [
          'ssh',
          ...sshOptionArgs(host, tty),
          ...connectionArgs,
          '-o',
          `ControlMaster=${createMaster ? 'auto' : 'no'}`,
          ...(createMaster ? ['-o', `ControlPersist=${SSH_CONTROL_PERSIST_SECONDS}`] : []),
          '-o',
        ];
        return [
          ...argsBeforeControlPath.map(shellQuotePosix),
          '"ControlPath=$komla_control_path"',
          ...trailingArgs.map(shellQuotePosix),
        ].join(' ');
      };
      const pooledCheckCommand = pooledSshCommand(false, false, ['-O', 'check', sshTarget(host)]);
      const pooledExistingCommand = pooledSshCommand(true, !reconnect, [
        sshTarget(host),
        remoteCommand,
      ]);
      const pooledCreateCommand = pooledSshCommand(true, true, [sshTarget(host), remoteCommand]);
      const poolAssignmentCommand = `printf '${SSH_TERMINAL_POOL_ASSIGNMENT_OSC_PREFIX}%s\\007' "$komla_pool_index"`;
      const capacityAwareAttempt = (sshCommand: string): string[] => [
        `    ${poolAssignmentCommand};`,
        '    komla_ssh_stderr=$(mktemp "${TMPDIR:-/tmp}/komla-ssh-terminal.XXXXXX") || exit 1;',
        `    trap 'rm -f "$komla_ssh_stderr"' 0;`,
        `    ${sshCommand} 2>"$komla_ssh_stderr";`,
        '    komla_ssh_status=$?;',
        `    if [ "$komla_ssh_status" -eq 255 ] && grep -F -e 'Session open refused by peer' -e 'mux_client_request_session: send fds failed' "$komla_ssh_stderr" >/dev/null 2>&1; then`,
        '      rm -f "$komla_ssh_stderr";',
        '      continue;',
        '    fi;',
        '    cat "$komla_ssh_stderr" >&2;',
        '    rm -f "$komla_ssh_stderr";',
        '    exit "$komla_ssh_status";',
      ];
      const poolCandidates = controlPaths
        .map(({ poolIndex, path }) => shellQuotePosix(`${poolIndex}:${path}`))
        .join(' ');
      const multiplexedLaunch = [
        'komla_missing_pool_candidates=;',
        `for komla_pool_candidate in ${poolCandidates}; do`,
        '  komla_pool_index=${komla_pool_candidate%%:*};',
        '  komla_control_path=${komla_pool_candidate#*:};',
        `  if ${pooledCheckCommand} >/dev/null 2>&1; then`,
        ...capacityAwareAttempt(pooledExistingCommand),
        '  else',
        '    komla_missing_pool_candidates="${komla_missing_pool_candidates}${komla_missing_pool_candidates:+ }$komla_pool_candidate";',
        '  fi;',
        'done;',
        'for komla_pool_candidate in $komla_missing_pool_candidates; do',
        '  komla_pool_index=${komla_pool_candidate%%:*};',
        '  komla_control_path=${komla_pool_candidate#*:};',
        ...capacityAwareAttempt(pooledCreateCommand),
        'done;',
        'komla_pool_index=standalone;',
        `${poolAssignmentCommand};`,
        `exec ${standaloneSshCommand}`,
      ].join(' ');
      terminalCommand = `/bin/sh -c ${shellQuotePosix(multiplexedLaunch)}`;
    }

    const windowsClient = process.platform === 'win32';
    const nativeWindows = windowsClient && !isWslMode();
    if (nativeWindows) {
      // The remote script is full of double quotes, which ssh.exe must receive intact.
      terminalCommand = `${withLegacyNativeArguments(
        `& ${['ssh', ...standaloneArgs]
          .map((arg) => shellQuotePowerShell(escapeNativeArgument(arg)))
          .join(' ')}`
      )}; exit $LASTEXITCODE`;
    } else if (windowsClient) {
      const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
      const windowsSshPath = windowsPathToWsl(
        pathWin32.join(windowsDirectory, 'System32', 'OpenSSH', 'ssh.exe')
      );
      const windowsSshCommand = [windowsSshPath, ...standaloneArgs].map(shellQuotePosix).join(' ');
      const wslSshCommand = ['ssh', ...standaloneArgs].map(shellQuotePosix).join(' ');
      terminalCommand = `/bin/sh -c ${shellQuotePosix(
        `if [ -x ${shellQuotePosix(windowsSshPath)} ] && [ -e /proc/sys/fs/binfmt_misc/WSLInterop ]; then exec ${windowsSshCommand}; else exec ${wslSshCommand}; fi`
      )}`;
    }
    const assignments = Object.entries(env).map(([name, value]) =>
      shellQuotePosix(`${name}=${value}`)
    );
    const launchCommand =
      assignments.length > 0 ? ['env', ...assignments, terminalCommand].join(' ') : terminalCommand;
    return nativeWindows
      ? terminalCommand
      : `printf '\\033]7337;host=ssh:%s\\007' ${shellQuotePosix(host.id)}; exec ${launchCommand}`;
  }

  recordAssignment(terminalId: string, nextAssignment: SshTerminalPoolAssignment): void {
    const reservation = this.assignments.get(terminalId);
    if (!reservation) return;
    if (reservation.assignment.kind === 'standalone' && nextAssignment.kind === 'standalone') {
      return;
    }
    if (
      reservation.assignment.kind === 'pooled' &&
      nextAssignment.kind === 'pooled' &&
      reservation.assignment.poolIndex === nextAssignment.poolIndex
    ) {
      return;
    }

    const members = this.pools.get(reservation.poolKey);
    if (!members) return;
    if (reservation.assignment.kind === 'pooled') {
      const previous = members.get(reservation.assignment.poolIndex);
      if (previous) {
        previous.terminalIds.delete(terminalId);
        previous.saturated = true;
      }
    }
    if (nextAssignment.kind === 'pooled') {
      const next = members.get(nextAssignment.poolIndex) ?? {
        terminalIds: new Set<string>(),
        saturated: false,
      };
      next.terminalIds.add(terminalId);
      members.set(nextAssignment.poolIndex, next);
    }
    this.assignments.set(terminalId, { ...reservation, assignment: nextAssignment });
  }

  releaseAssignment(terminalId: string): void {
    const reservation = this.assignments.get(terminalId);
    if (!reservation) return;
    this.assignments.delete(terminalId);
    if (reservation.assignment.kind === 'standalone') return;

    const member = this.pools.get(reservation.poolKey)?.get(reservation.assignment.poolIndex);
    if (!member) return;
    member.terminalIds.delete(terminalId);
    member.saturated = false;
  }

  private reserveCandidates(host: SshHost, terminalId: string): SshTerminalPoolIndex[] {
    const poolKey = sshControlPath(host, { kind: 'terminal', poolIndex: 0 });
    if (!poolKey) return [];

    const current = this.assignments.get(terminalId);
    if (current?.poolKey === poolKey && current.assignment.kind === 'pooled') {
      const members = this.pools.get(poolKey);
      if (members) return this.candidates(members, current.assignment.poolIndex);
    }
    if (current) this.releaseAssignment(terminalId);

    let members = this.pools.get(poolKey);
    if (!members) {
      members = new Map();
      this.pools.set(poolKey, members);
    }
    if (!members.has(0)) members.set(0, { terminalIds: new Set(), saturated: false });

    const available = [...members.entries()]
      .filter(([, member]) => !member.saturated)
      .sort(
        ([leftIndex, left], [rightIndex, right]) =>
          left.terminalIds.size - right.terminalIds.size || leftIndex - rightIndex
      );
    let poolIndex: SshTerminalPoolIndex | undefined = available[0]?.[0];
    if (poolIndex === undefined) {
      poolIndex = SSH_TERMINAL_POOL_INDICES.find((index) => !members.has(index));
    }
    if (poolIndex === undefined) {
      poolIndex =
        [...members.entries()].sort(
          ([leftIndex, left], [rightIndex, right]) =>
            left.terminalIds.size - right.terminalIds.size || leftIndex - rightIndex
        )[0]?.[0] ?? 0;
    }

    const member = members.get(poolIndex) ?? { terminalIds: new Set<string>(), saturated: false };
    member.terminalIds.add(terminalId);
    members.set(poolIndex, member);
    this.assignments.set(terminalId, {
      poolKey,
      assignment: { kind: 'pooled', poolIndex },
    });
    return this.candidates(members, poolIndex);
  }

  private candidates(
    members: Map<SshTerminalPoolIndex, TerminalPoolMember>,
    preferredIndex: SshTerminalPoolIndex
  ): SshTerminalPoolIndex[] {
    const candidates = [...members.entries()]
      .filter(([index, member]) => index === preferredIndex || !member.saturated)
      .sort(
        ([leftIndex, left], [rightIndex, right]) =>
          Number(rightIndex === preferredIndex) - Number(leftIndex === preferredIndex) ||
          left.terminalIds.size - right.terminalIds.size ||
          leftIndex - rightIndex
      )
      .map(([index]) => index);
    const expansionIndex = SSH_TERMINAL_POOL_INDICES.find((index) => !members.has(index));
    if (expansionIndex !== undefined) candidates.push(expansionIndex);
    return candidates;
  }
}
