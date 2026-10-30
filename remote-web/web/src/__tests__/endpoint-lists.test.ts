import { describe, expect, it } from 'vitest';

import {
  combineWorkspaces,
  EndpointLists,
  type ListLink,
  type ListLinkHandlers,
} from '../endpoint-lists';

import { FakeTimers } from './fake-timers';

import type { RemoteWorkspaceSummary } from '@komla/remote-protocol';

function workspace(
  id: string,
  overrides: Partial<RemoteWorkspaceSummary> = {}
): RemoteWorkspaceSummary {
  return {
    id,
    name: id,
    workingDirectory: `/work/${id}`,
    status: 'active',
    provisioning: false,
    terminals: [],
    ...overrides,
  };
}

describe('combineWorkspaces', () => {
  it("lists the page's own workspaces, then those only other endpoints list, opening each there", () => {
    const host = { hostId: 'devbox', workspaces: [workspace('a'), workspace('b')], projects: [] };
    const desktop = {
      hostId: null,
      workspaces: [workspace('b'), workspace('c'), workspace('d')],
      projects: [],
    };

    const combined = combineWorkspaces([workspace('a')], [desktop, host]);

    expect(combined.workspaces.map((listed) => listed.id)).toEqual(['a', 'b', 'c', 'd']);
    // On its host, though the desktop lists it too.
    expect(combined.elsewhere.get('b')).toBe(host);
    expect(combined.elsewhere.get('c')).toBe(desktop);
    expect(combined.elsewhere.has('a')).toBe(false);
  });

  it("takes the desktop's tag over a host's copy", () => {
    const tagged = { name: 'In review', tone: 'info' as const };
    const desktop = {
      hostId: null,
      workspaces: [workspace('a', { tag: tagged }), workspace('b')],
      projects: [],
    };

    const combined = combineWorkspaces(
      [workspace('a'), workspace('b', { tag: { name: 'Blocked', tone: 'error' } })],
      [desktop]
    );

    expect(combined.workspaces.map((listed) => listed.tag)).toEqual([tagged, undefined]);
  });
});

function setup() {
  const timers = new FakeTimers();
  let visible = true;
  let changes = 0;
  const sent: Array<{ hostId: string | null; type: string }> = [];
  const links: Array<{
    hostId: string | null;
    handlers: ListLinkHandlers;
    closed: boolean;
    probes: number;
    takeOver: boolean;
  }> = [];
  const outcomes = new Map<string | null, Array<'link' | 'retry' | 'reload' | 'closes-replaced'>>();
  const lists = new EndpointLists({
    timers,
    isVisible: () => visible,
    changed: () => (changes += 1),
    open: async (hostId, _signal, handlers, takeOver) => {
      const outcome = outcomes.get(hostId)?.shift() ?? 'link';
      if (outcome === 'closes-replaced') {
        handlers.closed(true);
        return 'retry';
      }
      if (outcome !== 'link') return outcome;
      const record = { hostId, handlers, closed: false, probes: 0, takeOver };
      links.push(record);
      const link: ListLink = {
        send: (frame) => sent.push({ hostId, type: frame.type }),
        probe: () => (record.probes += 1),
        close: () => (record.closed = true),
      };
      return link;
    },
  });
  return {
    timers,
    lists,
    sent,
    links,
    outcomes,
    changes: () => changes,
    hide: () => (visible = false),
    show: () => (visible = true),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function listFrame(...ids: string[]) {
  return {
    type: 'app:workspaces' as const,
    requestId: 'push',
    workspaces: ids.map((id) => workspace(id)),
  };
}

describe('EndpointLists', () => {
  it('signs in to each endpoint, asks for its list and projects, and keeps the pushed list', async () => {
    const { lists, sent, links } = setup();

    lists.setEndpoints([null, 'devbox']);
    await settle();

    expect(sent).toEqual([
      { hostId: null, type: 'app:workspaces:list' },
      { hostId: null, type: 'app:launch-options:get' },
      { hostId: 'devbox', type: 'app:workspaces:list' },
      { hostId: 'devbox', type: 'app:launch-options:get' },
    ]);
    links[1]!.handlers.frame(listFrame('a'));
    links[1]!.handlers.frame(listFrame('a', 'b'));
    expect(lists.lists()).toEqual([
      { hostId: 'devbox', workspaces: [workspace('a'), workspace('b')], projects: [] },
    ]);
  });

  it('keeps a list through a dropped connection until reaching the endpoint again fails', async () => {
    const { lists, links, outcomes, timers } = setup();
    lists.setEndpoints(['devbox']);
    await settle();
    links[0]!.handlers.frame(listFrame('a'));
    outcomes.set('devbox', ['retry']);

    links[0]!.handlers.closed(false);
    expect(lists.lists()).toHaveLength(1);
    timers.advance(2_000);
    await settle();

    expect(lists.lists()).toEqual([]);
    timers.advance(4_000);
    await settle();
    expect(links).toHaveLength(2);
  });

  it('stays off while another session has the endpoint, and tries again when looked at', async () => {
    const { lists, links, timers } = setup();
    lists.setEndpoints([null]);
    await settle();
    links[0]!.handlers.frame(listFrame('a'));

    links[0]!.handlers.closed(true);
    timers.advance(120_000);
    await settle();

    expect(lists.lists()).toEqual([]);
    expect(lists.paused()).toEqual([{ hostId: null, reason: 'replaced', takingOver: false }]);
    expect(links).toHaveLength(1);

    lists.wake();
    await settle();
    expect(links).toHaveLength(2);
    expect(links[1]!.takeOver).toBe(false);
    // Still named until it lists something: a session that yields closes without doing so.
    expect(lists.paused()).toHaveLength(1);
    links[1]!.handlers.closed(true);
    expect(lists.paused()).toHaveLength(1);

    lists.wake();
    await settle();
    links[2]!.handlers.frame(listFrame('a'));
    expect(lists.paused()).toEqual([]);
    expect(lists.lists()).toHaveLength(1);
  });

  it('takes the endpoint over only for what the user tapped', async () => {
    const { lists, links } = setup();
    lists.setEndpoints([null]);
    await settle();
    expect(links[0]!.takeOver).toBe(false);
    links[0]!.handlers.closed(true);

    lists.retry(null);
    expect(lists.paused()).toEqual([{ hostId: null, reason: 'replaced', takingOver: true }]);
    await settle();
    expect(links[1]!.takeOver).toBe(true);
    links[1]!.handlers.frame(listFrame('a'));
    expect(lists.paused()).toEqual([]);

    links[1]!.handlers.closed(true);
    lists.wake();
    await settle();
    expect(links[2]!.takeOver).toBe(false);
  });

  it('honours a tap made during an attempt that then yields, however the close arrives', async () => {
    const { lists, links, outcomes, timers } = setup();
    lists.setEndpoints([null]);
    await settle();
    links[0]!.handlers.closed(true);

    // The session closes after the link was handed over.
    lists.wake();
    await settle();
    lists.retry(null);
    links[1]!.handlers.closed(true);
    timers.advance(120_000);
    await settle();
    expect(links[2]!.takeOver).toBe(true);
    links[2]!.handlers.closed(true);

    // The session closes before it was.
    outcomes.set(null, ['closes-replaced']);
    lists.wake();
    lists.retry(null);
    await settle();
    timers.advance(120_000);
    await settle();
    expect(links[3]!.takeOver).toBe(true);
  });

  it('keeps asking after a tap whose attempt failed, but no longer calls it open elsewhere', async () => {
    const { lists, links, outcomes, timers } = setup();
    lists.setEndpoints([null]);
    await settle();
    links[0]!.handlers.closed(true);

    outcomes.set(null, ['retry']);
    lists.retry(null);
    await settle();
    expect(lists.paused()).toEqual([]);
    timers.advance(120_000);
    await settle();
    expect(links[1]!.takeOver).toBe(true);
  });

  it('forgets a tap once the page has been away', async () => {
    const { lists, links, outcomes, timers } = setup();
    lists.setEndpoints([null]);
    await settle();
    links[0]!.handlers.closed(true);
    outcomes.set(null, ['retry']);
    lists.retry(null);
    await settle();

    lists.wake();
    await settle();
    timers.advance(120_000);
    await settle();

    expect(links[1]!.takeOver).toBe(false);
  });

  it('leaves an attempt given up on without effect, and keeps the lists after disposing', async () => {
    const { lists, links, sent } = setup();
    lists.setEndpoints([null]);
    await settle();
    links[0]!.handlers.frame(listFrame('a'));

    lists.dispose();
    await settle();

    expect(links[0]!.closed).toBe(true);
    expect(lists.lists()).toHaveLength(1);
    expect(lists.paused()).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it('names an endpoint whose session closed the moment it signed in, as another has it', async () => {
    const { lists, links, outcomes } = setup();
    outcomes.set(null, ['closes-replaced']);

    lists.setEndpoints([null]);
    await settle();

    expect(lists.paused()).toEqual([{ hostId: null, reason: 'replaced', takingOver: false }]);
    expect(links).toHaveLength(0);
  });

  it('checks a live link when looked at, since a half-open one reports nothing', async () => {
    const { lists, links } = setup();
    lists.setEndpoints([null]);
    await settle();

    lists.wake();
    await settle();

    expect(links).toHaveLength(1);
    expect(links[0]!.probes).toBe(1);
  });

  it('names an endpoint that needs the passkey without trying it again', async () => {
    const { lists, links, outcomes, timers } = setup();
    outcomes.set('devbox', ['reload']);

    lists.setEndpoints(['devbox']);
    await settle();
    timers.advance(120_000);
    lists.wake();
    await settle();

    expect(lists.paused()).toEqual([
      { hostId: 'devbox', reason: 'signed-out', takingOver: false },
    ]);
    expect(links).toHaveLength(0);
  });

  it('closes the session of an endpoint it no longer lists, and ignores its frames', async () => {
    const { lists, links } = setup();
    lists.setEndpoints([null, 'devbox']);
    await settle();

    lists.setEndpoints([null]);
    links[1]!.handlers.frame(listFrame('a'));

    expect(links[1]!.closed).toBe(true);
    expect(lists.lists()).toEqual([]);
  });

  it('tries a hidden page only once it is looked at', async () => {
    const { lists, links, hide, show } = setup();
    hide();

    lists.setEndpoints(['devbox']);
    await settle();
    expect(links).toHaveLength(0);

    show();
    lists.wake();
    await settle();
    expect(links).toHaveLength(1);
  });
});
