import { createLogger } from '../../lib/logger';

import type { SshRunPurpose } from './policy';
import type { SshHost } from '../../../shared/types';
import type { ChildProcess } from 'child_process';

const logger = createLogger('SshConnectionHolds');

/**
 * The remote command of a hold: it reads until Komla closes its stdin, as when Komla quits, and
 * prints nothing, since Komla sends it nothing. Every login shell runs it unchanged.
 */
export const SSH_CONNECTION_HOLD_COMMAND = 'cat';
// A hold that ended this soon never joined the connection, so trying again on every command
// would only fail the same way.
export const SSH_CONNECTION_HOLD_SETTLE_MS = 5_000;
export const SSH_CONNECTION_HOLD_RETRY_MS = 60_000;
// After the host refused a session on the connection, which a hold would take from commands.
export const SSH_CONNECTION_HOLD_REFUSED_RETRY_MS = 10 * 60_000;
const SESSION_REFUSED = 'Session open refused by peer';
const CLOSE_GRACE_MS = 5_000;

export type SshConnectionHoldLane = SshRunPurpose['kind'];

export interface SshConnectionHoldStarter {
  /**
   * Starts a session on the shared connection at `controlPath` that never logs in itself, or
   * nothing when no connection is open there.
   */
  start(host: SshHost, controlPath: string): Promise<ChildProcess | undefined>;
}

/** A connection Komla holds open. */
export interface SshHeldConnection {
  host: SshHost;
  controlPath: string;
}

interface Lane {
  host: SshHost;
  controlPath: string;
  child?: ChildProcess;
  starting: boolean;
  retryAt: number;
  refusedUntil: number;
}

/** Whether ssh failed because the host refused a session on a shared connection. */
export function isSshSessionRefusal(sshErrors: string): boolean {
  return sshErrors.includes(SESSION_REFUSED);
}

function release(child: ChildProcess): void {
  child.stdin?.end();
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }, CLOSE_GRACE_MS).unref();
}

/**
 * One idle session on each lane's shared connection to a host, so the connection stays open
 * while Komla runs instead of closing once its commands stop. Every login can ask the SSH agent
 * to approve the key, as with a fingerprint, so a connection that closed between commands asks
 * again; terminals don't, because their own sessions hold theirs. A hold only joins a connection
 * a command opened, and ends when the connection drops, Komla quits, or the host is forgotten.
 */
export class SshConnectionHolds {
  private readonly hosts = new Map<string, Map<SshConnectionHoldLane, Lane>>();
  // Each time a host is forgotten, so a command that started before can't hold for it after.
  private readonly generations = new Map<string, number>();

  constructor(private readonly starter: SshConnectionHoldStarter) {}

  /** What a command starting now passes to {@link hold} once it ran. */
  generation(hostId: string): number {
    return this.generations.get(hostId) ?? 0;
  }

  /**
   * Holds the shared connection at `controlPath` open, which a command that started at
   * `generation` just ran on.
   */
  hold(
    host: SshHost,
    laneKind: SshConnectionHoldLane,
    controlPath: string,
    generation: number
  ): void {
    if (generation !== this.generation(host.id)) return;
    const lane = this.lane(host, laneKind, controlPath);
    const now = Date.now();
    if (lane.child || lane.starting || now < lane.retryAt || now < lane.refusedUntil) return;
    void this.start(lane, laneKind);
  }

  /**
   * The host refused a session on the lane's connection, at its limit of sessions: lets go of it
   * there for a while, so the hold doesn't take a session a command needs.
   */
  refused(host: SshHost, laneKind: SshConnectionHoldLane, controlPath: string): void {
    const lane = this.lane(host, laneKind, controlPath);
    lane.refusedUntil = Date.now() + SSH_CONNECTION_HOLD_REFUSED_RETRY_MS;
    const child = lane.child;
    lane.child = undefined;
    if (child) release(child);
    logger.debug('Stopped holding an SSH connection the host refused a session on', {
      hostId: host.id,
      laneKind,
    });
  }

  /** The connections held open now. */
  held(): SshHeldConnection[] {
    return Array.from(this.hosts.values()).flatMap((lanes) =>
      Array.from(lanes.values())
        .filter((lane) => lane.child)
        .map(({ host, controlPath }) => ({ host, controlPath }))
    );
  }

  /** Lets go of the host's connections, which close once nothing else uses them. */
  forget(hostId: string): void {
    this.generations.set(hostId, this.generation(hostId) + 1);
    const lanes = this.hosts.get(hostId);
    if (!lanes) return;
    this.hosts.delete(hostId);
    for (const lane of lanes.values()) {
      const child = lane.child;
      lane.child = undefined;
      if (child) release(child);
    }
  }

  private lane(host: SshHost, laneKind: SshConnectionHoldLane, controlPath: string): Lane {
    let lanes = this.hosts.get(host.id);
    if (!lanes) {
      lanes = new Map();
      this.hosts.set(host.id, lanes);
    }
    const existing = lanes.get(laneKind);
    if (existing?.controlPath === controlPath) return existing;
    // The host changed; its old connection closes once nothing holds it.
    if (existing?.child) release(existing.child);
    const lane: Lane = { host, controlPath, starting: false, retryAt: 0, refusedUntil: 0 };
    lanes.set(laneKind, lane);
    return lane;
  }

  private isCurrent(lane: Lane, laneKind: SshConnectionHoldLane): boolean {
    return this.hosts.get(lane.host.id)?.get(laneKind) === lane;
  }

  private async start(lane: Lane, laneKind: SshConnectionHoldLane): Promise<void> {
    const hostId = lane.host.id;
    lane.starting = true;
    let child: ChildProcess | undefined;
    try {
      child = await this.starter.start(lane.host, lane.controlPath);
    } catch (error) {
      logger.debug('Could not hold an SSH connection open', { hostId, laneKind, error });
    } finally {
      lane.starting = false;
    }
    if (!child) {
      lane.retryAt = Date.now() + SSH_CONNECTION_HOLD_RETRY_MS;
      return;
    }
    // Forgotten, replaced or refused while it started.
    if (!this.isCurrent(lane, laneKind) || Date.now() < lane.refusedUntil) {
      release(child);
      return;
    }
    const held = child;
    const startedAt = Date.now();
    let sshErrors = '';
    held.stderr?.on('data', (chunk: Buffer | string) => {
      sshErrors = (sshErrors + chunk.toString()).slice(-2048);
    });
    held.stdin?.on('error', () => undefined);
    const ended = (reason: Record<string, unknown>) => {
      if (lane.child !== held) return;
      lane.child = undefined;
      const endedAt = Date.now();
      if (isSshSessionRefusal(sshErrors)) {
        lane.refusedUntil = endedAt + SSH_CONNECTION_HOLD_REFUSED_RETRY_MS;
      }
      lane.retryAt =
        endedAt - startedAt < SSH_CONNECTION_HOLD_SETTLE_MS
          ? endedAt + SSH_CONNECTION_HOLD_RETRY_MS
          : 0;
      logger.debug('Stopped holding an SSH connection open', {
        hostId,
        laneKind,
        heldMs: endedAt - startedAt,
        sshError: sshErrors.trim().split('\n').pop(),
        ...reason,
      });
    };
    held.once('exit', (code, signal) => ended({ code, signal }));
    held.once('error', (error) => ended({ error }));
    lane.child = held;
    logger.debug('Holding an SSH connection open', { hostId, laneKind });
  }
}
