import { describe, expect, it } from 'vitest';

import { publishHookEvent } from '../../../src/main/lib/hook-events';
import {
  followHookEventsAsKomlaEvents,
  onKomlaEvent,
  publishWorkingTreeEvents,
} from '../../../src/main/lib/komla-events';
import { pageEvent, type KomlaEvent } from '../../../src/shared/types/komla-events';

describe('Komla events', () => {
  it("publishes a watcher's changes as working-tree and branch events", () => {
    const seen: KomlaEvent[] = [];
    const stop = onKomlaEvent((event) => seen.push(event));
    publishWorkingTreeEvents('ws-1', ['file']);
    publishWorkingTreeEvents('ws-2', ['file', 'git-head', 'git-branch']);
    stop();
    expect(seen).toEqual([
      { type: 'working-tree.changed', workspaceId: 'ws-1' },
      { type: 'working-tree.changed', workspaceId: 'ws-2' },
      { type: 'branch.changed', workspaceId: 'ws-2' },
    ]);
  });

  it('publishes the events hooks run on, and gives pages none of what agents said', () => {
    const seen: KomlaEvent[] = [];
    const stopListening = onKomlaEvent((event) => seen.push(event));
    const stopFollowing = followHookEventsAsKomlaEvents();
    publishHookEvent({
      event: 'agent.needs-input',
      workspaceId: 'ws-1',
      agent: 'claude-code',
      message: 'May I run rm?',
    });
    stopFollowing();
    publishHookEvent({ event: 'agent.done', workspaceId: 'ws-1' });
    stopListening();
    expect(seen).toEqual([
      { type: 'agent.needs-input', workspaceId: 'ws-1', agent: 'claude-code', message: 'May I run rm?' },
    ]);
    expect(pageEvent(seen[0])).toEqual({
      type: 'agent.needs-input',
      workspaceId: 'ws-1',
      agent: 'claude-code',
    });
  });

  it("keeps one listener's failure from the others", () => {
    const seen: string[] = [];
    const stops = [
      onKomlaEvent(() => {
        throw new Error('boom');
      }),
      onKomlaEvent((event) => seen.push(event.type)),
    ];
    publishWorkingTreeEvents('ws-1', ['git-head']);
    for (const stop of stops) stop();
    expect(seen).toEqual(['branch.changed']);
  });
});
