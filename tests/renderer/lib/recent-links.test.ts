/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { scanWorkspaceTerminalsForLinks } = vi.hoisted(() => ({
  scanWorkspaceTerminalsForLinks: vi.fn(),
}));

vi.mock('../../../src/renderer/lib/scan-terminal-urls', () => ({
  scanWorkspaceTerminalsForLinks,
}));

import {
  notePrintedHyperlink,
  recordOpenedRecentLink,
  rememberTerminalLinks,
} from '../../../src/renderer/lib/recent-links';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

import type { Workspace, WorkspaceRecentLink } from '../../../src/shared/types';

const updateWorkspace = vi.fn();

function setLinks(recentLinks?: WorkspaceRecentLink[]): void {
  useWorkspacesStore.setState({
    workspaces: [{ id: 'ws-1', recentLinks } as unknown as Workspace],
  });
}

function links(): WorkspaceRecentLink[] | undefined {
  return useWorkspacesStore.getState().workspaces[0]?.recentLinks;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  updateWorkspace.mockReset().mockResolvedValue(undefined);
  scanWorkspaceTerminalsForLinks.mockReset().mockReturnValue([]);
  (window as unknown as { api: unknown }).api = { updateWorkspace };
  setLinks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('recordOpenedRecentLink', () => {
  it('saves the link as opened', () => {
    recordOpenedRecentLink('ws-1', 'https://github.com/acme/app/pull/1');

    const expected = [{ url: 'https://github.com/acme/app/pull/1', openedAt: 1_000 }];
    expect(links()).toEqual(expected);
    expect(updateWorkspace).toHaveBeenCalledWith('ws-1', { recentLinks: expected });
  });

  it('saves nothing for a local page', () => {
    recordOpenedRecentLink('ws-1', 'http://localhost:5173/');

    expect(links()).toBeUndefined();
    expect(updateWorkspace).not.toHaveBeenCalled();
  });
});

describe('notePrintedHyperlink', () => {
  it('saves the hyperlinks a burst of output prints together, newest first', () => {
    notePrintedHyperlink('ws-1', 'https://a.example/');
    notePrintedHyperlink('ws-1', 'file:///tmp/x.txt');
    notePrintedHyperlink('ws-1', 'https://b.example/');
    expect(updateWorkspace).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);

    expect(links()).toEqual([
      { url: 'https://b.example/', printedAt: 1_000 },
      { url: 'https://a.example/', printedAt: 1_000 },
    ]);
    expect(updateWorkspace).toHaveBeenCalledTimes(1);
  });

  it('saves nothing when the links are already listed in that order', () => {
    setLinks([{ url: 'https://a.example/', printedAt: 1_000 }]);
    notePrintedHyperlink('ws-1', 'https://a.example/');
    vi.advanceTimersByTime(2_000);

    expect(updateWorkspace).not.toHaveBeenCalled();
  });

  it('saves a link that a program keeps redrawing about once a minute', () => {
    for (let i = 0; i < 30; i++) {
      notePrintedHyperlink('ws-1', 'https://a.example/');
      vi.advanceTimersByTime(2_000);
    }

    expect(updateWorkspace).toHaveBeenCalledTimes(1);
    expect(links()).toEqual([{ url: 'https://a.example/', printedAt: 1_000 }]);

    notePrintedHyperlink('ws-1', 'https://a.example/');
    vi.advanceTimersByTime(2_000);

    expect(updateWorkspace).toHaveBeenCalledTimes(2);
    expect(links()).toEqual([{ url: 'https://a.example/', printedAt: 61_000 }]);
  });
});

describe('rememberTerminalLinks', () => {
  it('adds the URLs on screen, leaving out a piece of a link the program wrapped', () => {
    setLinks([{ url: 'https://claude.ai/artifact/abc-def-123' }]);
    scanWorkspaceTerminalsForLinks.mockReturnValue([
      { url: 'https://claude.ai/artifact/abc-', continuation: 'def-123' },
      { url: 'https://github.com/acme/app/pull/7' },
      { url: 'https://github.com/acme/app', continuation: 'Merged' },
    ]);

    rememberTerminalLinks('ws-1');

    expect(links()).toEqual([
      { url: 'https://github.com/acme/app/pull/7', printedAt: 1_000 },
      { url: 'https://github.com/acme/app', printedAt: 1_000 },
      { url: 'https://claude.ai/artifact/abc-def-123' },
    ]);
  });

  it('orders the URLs by when their lines were printed', () => {
    scanWorkspaceTerminalsForLinks.mockReturnValue([
      { url: 'https://b.example/', printedAt: 400 },
      { url: 'https://a.example/', printedAt: 900 },
    ]);

    rememberTerminalLinks('ws-1');

    expect(links()).toEqual([
      { url: 'https://a.example/', printedAt: 900 },
      { url: 'https://b.example/', printedAt: 400 },
    ]);
  });

  it('first saves hyperlinks still waiting to be saved', () => {
    notePrintedHyperlink('ws-1', 'https://a.example/');

    rememberTerminalLinks('ws-1');

    expect(links()).toEqual([{ url: 'https://a.example/', printedAt: 1_000 }]);
  });
});
