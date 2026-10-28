import type { ChildProcess } from 'child_process';

export const SSH_LEASE_HEARTBEAT_INTERVAL_MS = 30_000;
const SSH_LEASE_TIMEOUT_SECONDS = 90;

/**
 * Remote command for an SSH process that holds a reverse forward. Closing
 * stdin ends it, as with `cat`. When the connection drops without a FIN (a
 * network change, a sleeping laptop), sshd has no client alive check by
 * default and keeps the remote listener bound for up to TCP keepalive's two
 * hours, so every reconnect fails with "remote port forwarding failed". Missing
 * heartbeats end the owning sshd session instead, which frees the port.
 *
 * Runs under `sh` because the login shell may be fish, and dash has no `read
 * -t`. The script contains no single quotes or backslashes so every login
 * shell passes it through unchanged. Only a parent named sshd is signaled.
 */
export function sshHeartbeatLeaseCommand(timeoutSeconds = SSH_LEASE_TIMEOUT_SECONDS): string {
  // Each heartbeat replaces the timer `w`. Its trap is set before it forks
  // `sleep`, and it runs on /dev/null, so a timer killed mid-start cannot leave
  // a process holding the session's output open. The trap uses SIGKILL because
  // dash loses a TERM that reaches the child before it execs `sleep`. A timer
  // that fired stays alive until the lease ends, so `kill $t` never reaches a
  // reused pid.
  const script = [
    'p=$PPID',
    'k() { kill -9 $! 2>/dev/null; exit; }',
    `w() { trap k TERM; sleep ${timeoutSeconds} & wait $! || exit; case $(cat /proc/$p/comm 2>/dev/null || ps -o comm= -p $p 2>/dev/null) in *sshd*) kill $p;; esac; while :; do sleep 3600 & wait $!; done; }`,
    'w </dev/null >/dev/null 2>&1 & t=$!',
    'while read l; do kill $t 2>/dev/null; w </dev/null >/dev/null 2>&1 & t=$!; done',
    'kill $t 2>/dev/null',
    'exit 0',
  ].join('; ');
  return `exec sh -c '${script}'`;
}

/** Feeds the remote {@link sshHeartbeatLeaseCommand} until ssh exits. */
export function keepSshLeaseAlive(
  child: ChildProcess,
  intervalMs = SSH_LEASE_HEARTBEAT_INTERVAL_MS
): void {
  const stdin = child.stdin;
  if (!stdin) return;
  // A write can race ssh's exit; the exit handler reports why it ended.
  stdin.on('error', () => undefined);
  const timer = setInterval(() => {
    if (stdin.writable) stdin.write('\n');
  }, intervalMs);
  timer.unref?.();
  const stop = () => clearInterval(timer);
  child.once('exit', stop);
  child.once('error', stop);
}
