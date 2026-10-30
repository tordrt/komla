// One list of every workspace this phone can reach. The page holds one endpoint's session, the
// desktop's or an SSH host's; the other endpoints are signed in to in the background with their
// resume grants, only to list their workspaces, so the list doesn't depend on which one the page
// opened. A workspace only another endpoint lists opens there.

import type {
  RemoteAppFrame,
  RemoteProjectSummary,
  RemoteWorkspaceSummary,
} from '@komla/remote-protocol';

import { ReconnectLoop } from './reconnect-loop';
import { WorkspacePages } from './terminal-stream';

import type { WatchdogTimers } from './connection-watchdog';

/** An endpoint's workspaces and projects: `hostId` is the SSH host's, or null for the desktop. */
export interface EndpointWorkspaces {
  hostId: string | null;
  workspaces: RemoteWorkspaceSummary[];
  projects: RemoteProjectSummary[];
}

export interface CombinedWorkspaces {
  workspaces: RemoteWorkspaceSummary[];
  /** Where each workspace the page's own list lacks is listed, and so opens. */
  elsewhere: Map<string, EndpointWorkspaces>;
}

/**
 * The page's own list, then what only other endpoints list: a host's before the desktop's, so a
 * workspace on a host opens there. The desktop sets tags, so its copy's tag wins.
 */
export function combineWorkspaces(
  own: RemoteWorkspaceSummary[],
  others: EndpointWorkspaces[]
): CombinedWorkspaces {
  const desktop = others.find((other) => other.hostId === null);
  const desktopCopies = new Map(desktop?.workspaces.map((workspace) => [workspace.id, workspace]));
  const withDesktopTag = (workspace: RemoteWorkspaceSummary): RemoteWorkspaceSummary => {
    const copy = desktopCopies.get(workspace.id);
    if (!copy || copy.tag === workspace.tag) return workspace;
    const { tag: _, ...rest } = workspace;
    return copy.tag ? { ...rest, tag: copy.tag } : rest;
  };
  const workspaces = own.map(withDesktopTag);
  const listed = new Set(own.map((workspace) => workspace.id));
  const elsewhere = new Map<string, EndpointWorkspaces>();
  const hostsFirst = [...others].sort((a, b) => Number(a.hostId === null) - Number(b.hostId === null));
  for (const other of hostsFirst) {
    for (const workspace of other.workspaces) {
      if (listed.has(workspace.id)) continue;
      listed.add(workspace.id);
      elsewhere.set(workspace.id, other);
      workspaces.push(withDesktopTag(workspace));
    }
  }
  return { workspaces, elsewhere };
}

/** A background session that lists one endpoint's workspaces. */
export interface ListLink {
  send(frame: { type: string; requestId: string }): void;
  /** The page is on screen again: check the connection is still alive. */
  probe(): void;
  close(): void;
}

export interface ListLinkHandlers {
  frame(frame: RemoteAppFrame): void;
  /** The session ended; `replaced` when another session has the endpoint. */
  closed(replaced: boolean): void;
}

export interface EndpointListsOptions {
  /**
   * Signs in with the endpoint's resume grant; 'reload' when only the passkey can. The session
   * leaves one someone is using alone, unless `takeOver`.
   */
  open(
    hostId: string | null,
    signal: AbortSignal,
    handlers: ListLinkHandlers,
    takeOver: boolean
  ): Promise<ListLink | 'retry' | 'reload'>;
  changed(): void;
  isVisible(): boolean;
  timers?: WatchdogTimers;
}

interface Endpoint {
  hostId: string | null;
  loop: ReconnectLoop;
  link: ListLink | null;
  pages: WorkspacePages<RemoteWorkspaceSummary>;
  workspaces: RemoteWorkspaceSummary[] | null;
  projects: RemoteProjectSummary[];
  /** Off for now: signed out, or another session has the endpoint. */
  paused: EndpointPause | null;
  /** The user asked for this endpoint's list, over a session using it. */
  takeOver: boolean;
}

export type EndpointPause = 'signed-out' | 'replaced';

const MAX_RETRY_DELAY_MS = 60_000;

/** The user tapped to take over during an attempt that was leaving the session alone. */
function tappedSince(endpoint: Endpoint, attemptTookOver: boolean): boolean {
  return endpoint.takeOver && !attemptTookOver;
}

export class EndpointLists {
  private readonly endpoints = new Map<string | null, Endpoint>();
  private nextRequestId = 1;

  constructor(private readonly options: EndpointListsOptions) {}

  /** The endpoints to list besides the page's own; others stop. */
  setEndpoints(hostIds: Array<string | null>): void {
    for (const [hostId, endpoint] of this.endpoints) {
      if (hostIds.includes(hostId)) continue;
      this.endpoints.delete(hostId);
      this.stop(endpoint);
      this.options.changed();
    }
    for (const hostId of hostIds) {
      if (this.endpoints.has(hostId)) continue;
      const endpoint: Endpoint = {
        hostId,
        link: null,
        pages: new WorkspacePages(),
        workspaces: null,
        projects: [],
        paused: null,
        takeOver: false,
        loop: new ReconnectLoop({
          attempt: (signal) => this.attempt(endpoint, signal),
          reload: () => this.pause(endpoint, 'signed-out'),
          delayMs: (attempt) => Math.min(MAX_RETRY_DELAY_MS, 2_000 * 2 ** attempt),
          isVisible: () => this.options.isVisible(),
          ...(this.options.timers ? { timers: this.options.timers } : {}),
        }),
      };
      this.endpoints.set(hostId, endpoint);
      this.connect(endpoint);
    }
  }

  /**
   * The page is on screen again: check live links, and retry every endpoint waiting to at once. One
   * another session had may be free now, and trying takes nothing from a session in use. Named as
   * held until it answers, so its note doesn't come and go. A tap made before the page left
   * doesn't count any more: the session it would close may be someone's by now.
   */
  wake(): void {
    for (const endpoint of this.endpoints.values()) {
      endpoint.takeOver = false;
      endpoint.link?.probe();
      if (endpoint.paused === 'replaced') this.connect(endpoint);
      else endpoint.loop.wake();
    }
  }

  /** The user asked to list a paused endpoint, even if that takes it from a session using it. */
  retry(hostId: string | null): void {
    const endpoint = this.endpoints.get(hostId);
    if (!endpoint?.paused) return;
    endpoint.takeOver = true;
    this.options.changed();
    this.connect(endpoint);
  }

  lists(): EndpointWorkspaces[] {
    return [...this.endpoints.values()].flatMap(({ hostId, workspaces, projects }) =>
      workspaces ? [{ hostId, workspaces, projects }] : []
    );
  }

  /**
   * Endpoints that list nothing for now: signed out, needing the passkey, or held by another
   * session, such as another device with the desktop open.
   */
  paused(): Array<{ hostId: string | null; reason: EndpointPause; takingOver: boolean }> {
    return [...this.endpoints.values()].flatMap(({ hostId, paused, takeOver }) =>
      paused ? [{ hostId, reason: paused, takingOver: takeOver }] : []
    );
  }

  /** Ends every session for good. What they last listed stays, for a page that stays on screen. */
  dispose(): void {
    for (const endpoint of this.endpoints.values()) {
      this.stop(endpoint);
      endpoint.paused = null;
      endpoint.takeOver = false;
    }
  }

  private connect(endpoint: Endpoint): void {
    endpoint.loop.start();
    endpoint.loop.wake();
  }

  private async attempt(
    endpoint: Endpoint,
    signal: AbortSignal
  ): Promise<'connected' | 'retry' | 'reload'> {
    let opened: ListLink | null = null;
    // Another session having the endpoint closes this one the moment it signs in.
    let closedOpening = null as { replaced: boolean } | null;
    const takeOver = endpoint.takeOver;
    const link = await this.options.open(
      endpoint.hostId,
      signal,
      {
        frame: (frame) => {
          if (opened && endpoint.link === opened) this.receive(endpoint, frame);
        },
        closed: (replaced) => {
          if (!opened) closedOpening = { replaced };
          else if (endpoint.link === opened) this.closed(endpoint, replaced, takeOver);
        },
      },
      takeOver
    );
    if (signal.aborted || this.endpoints.get(endpoint.hostId) !== endpoint) {
      if (typeof link !== 'string') link.close();
      return 'retry';
    }
    if (closedOpening) {
      if (typeof link !== 'string') link.close();
      if (!closedOpening.replaced || tappedSince(endpoint, takeOver)) return 'retry';
      this.pause(endpoint, 'replaced');
      return 'connected';
    }
    if (typeof link === 'string') {
      // Gone until it answers again, rather than shown as it was.
      this.forget(endpoint);
      return link;
    }
    opened = link;
    endpoint.link = link;
    endpoint.pages.clear();
    link.send({ type: 'app:workspaces:list', requestId: this.requestId() });
    link.send({ type: 'app:launch-options:get', requestId: this.requestId() });
    return 'connected';
  }

  private receive(endpoint: Endpoint, frame: RemoteAppFrame): void {
    if (frame.type === 'app:workspaces') {
      const workspaces = endpoint.pages.add(frame);
      if (!workspaces) return;
      endpoint.workspaces = workspaces;
      // Only now is this session staying: one that yields closes without listing anything.
      endpoint.paused = null;
      endpoint.takeOver = false;
      this.options.changed();
    } else if (frame.type === 'app:launch-options') {
      endpoint.projects = frame.projects;
      if (endpoint.workspaces) this.options.changed();
    }
  }

  private closed(endpoint: Endpoint, replaced: boolean, tookOver: boolean): void {
    endpoint.link = null;
    if (replaced && !tappedSince(endpoint, tookOver)) {
      this.pause(endpoint, 'replaced');
      return;
    }
    // Its list stays until an attempt to reach it again fails.
    endpoint.loop.start();
  }

  private pause(endpoint: Endpoint, reason: EndpointPause): void {
    endpoint.paused = reason;
    endpoint.takeOver = false;
    endpoint.loop.stop();
    endpoint.workspaces = null;
    this.options.changed();
  }

  private forget(endpoint: Endpoint): void {
    if (!endpoint.workspaces && !endpoint.paused) return;
    endpoint.workspaces = null;
    // Out of reach, so no longer known to be open elsewhere.
    endpoint.paused = null;
    this.options.changed();
  }

  private stop(endpoint: Endpoint): void {
    endpoint.loop.stop();
    endpoint.link?.close();
    endpoint.link = null;
  }

  private requestId(): string {
    return `list-${this.nextRequestId++}`;
  }
}
