/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openTerminalUrl = vi.hoisted(() => vi.fn());
const notePrintedHyperlink = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/lib/open-terminal-url', () => ({
  openTerminalUrl,
}));
vi.mock('../../../src/renderer/lib/recent-links', () => ({
  notePrintedHyperlink,
}));

import {
  browserOfferTargets,
  offerDevPreview,
  offerVirtualDesktop,
  openBrowserOffer,
  followBrowserOffers,
} from '../../../src/renderer/lib/dev-preview-offers';
import {
  settleDevPreviewOffer,
  settleVirtualDesktopOffer,
  useDevPreviewOffersStore,
  useRememberedOfferTargetsStore,
} from '../../../src/renderer/stores/dev-preview-offers.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

import type { Workspace } from '../../../src/shared/types';

const openVirtualDesktopInVncApp = vi.fn();
const desktop = {
  vncPort: 5901,
  url: 'http://127.0.0.1:6081/vnc.html?password=pa55word',
  app: 'xterm',
  vncApp: 'Screen Sharing',
  shownAt: 1,
};
let stopFollowing: () => void;

function pending(workspaceId: string) {
  return useDevPreviewOffersStore.getState().pending[workspaceId];
}

function show(workspaceId: string | null, showDashboard = false): void {
  useWorkspacesStore.setState({
    selectedWorkspaceId: workspaceId,
    showDashboard,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useToastStore.setState({ toasts: [] });
  useDevPreviewOffersStore.setState({ offers: {}, pending: {}, held: {} });
  useRememberedOfferTargetsStore.setState({ byScope: {} });
  useWorkspacesStore.setState({
    workspaces: [
      { id: 'ws-1', name: 'pricing', projectId: 'project-1', terminals: [] },
      {
        id: 'ws-2',
        name: 'billing-fix',
        projectId: 'project-1',
        terminals: [],
      },
      { id: 'ws-3', name: 'scratch', projectId: null, terminals: [] },
    ] as unknown as Workspace[],
  });
  show('ws-1');
  openVirtualDesktopInVncApp.mockResolvedValue(undefined);
  (window as unknown as { api: unknown }).api = { openVirtualDesktopInVncApp };
  stopFollowing = followBrowserOffers();
});

afterEach(() => stopFollowing());

describe('offerDevPreview', () => {
  it('asks in the workspace where to open the page, opening nothing and showing no toast', () => {
    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');

    expect(pending('ws-1')).toEqual({
      kind: 'page',
      page: { url: 'http://localhost:5173/', executionLocation: 'workspace' },
    });
    expect(openTerminalUrl).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it("waits for another workspace's page without a toast over the one on screen", () => {
    offerDevPreview('ws-2', 'http://localhost:3000/pricing', 'workspace');

    expect(pending('ws-2')).toBeDefined();
    expect(useToastStore.getState().toasts).toEqual([]);
    expect(openTerminalUrl).not.toHaveBeenCalled();
  });

  it('opens the page where the user picks, forwarded from its machine, and stops asking', () => {
    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');

    openBrowserOffer('ws-1', 'external');

    expect(openTerminalUrl).toHaveBeenCalledWith('http://localhost:5173/', 'external', {
      workspaceId: 'ws-1',
      executionLocation: 'workspace',
    });
    expect(pending('ws-1')).toBeUndefined();
  });

  it("replaces the workspace's earlier offer instead of asking twice", () => {
    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');
    offerDevPreview('ws-1', 'http://localhost:5174/', 'workspace');

    expect(pending('ws-1')).toMatchObject({
      page: { url: 'http://localhost:5174/' },
    });
  });

  it("lists a page on another site among the workspace's links", () => {
    offerDevPreview('ws-1', 'https://preview.example.com/', 'workspace');

    expect(notePrintedHyperlink).toHaveBeenCalledWith('ws-1', 'https://preview.example.com/');
  });
});

describe('a remembered choice', () => {
  it("opens the project's later pages there without asking, in its other workspaces too", () => {
    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');
    openBrowserOffer('ws-1', 'preview', { remember: true });
    show('ws-2');

    offerDevPreview('ws-2', 'http://localhost:4000/', 'workspace');

    expect(openTerminalUrl).toHaveBeenLastCalledWith('http://localhost:4000/', 'preview', {
      workspaceId: 'ws-2',
      executionLocation: 'workspace',
    });
    expect(pending('ws-2')).toBeUndefined();
  });

  it('opens the page once when the user picks with Remember ticked', () => {
    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');

    openBrowserOffer('ws-1', 'external', { remember: true });

    expect(openTerminalUrl).toHaveBeenCalledTimes(1);
  });

  it('waits for the workspace to show before opening, then opens it on arrival', () => {
    useRememberedOfferTargetsStore.getState().remember('project:project-1', 'page', 'external');

    offerDevPreview('ws-2', 'http://localhost:4000/', 'workspace');
    expect(openTerminalUrl).not.toHaveBeenCalled();

    show('ws-2');

    expect(openTerminalUrl).toHaveBeenCalledWith('http://localhost:4000/', 'external', {
      workspaceId: 'ws-2',
      executionLocation: 'workspace',
    });
    expect(pending('ws-2')).toBeUndefined();
  });

  it('opens nothing under the overview, which shows every workspace', () => {
    useRememberedOfferTargetsStore.getState().remember('project:project-1', 'page', 'external');
    show('ws-2', true);

    offerDevPreview('ws-2', 'http://localhost:4000/', 'workspace');

    expect(openTerminalUrl).not.toHaveBeenCalled();
  });

  it('keeps to the workspace when it has no project', () => {
    show('ws-3');
    offerDevPreview('ws-3', 'http://localhost:5173/', 'workspace');
    openBrowserOffer('ws-3', 'external', { remember: true });

    expect(useRememberedOfferTargetsStore.getState().byScope).toEqual({
      'workspace:ws-3': { page: 'external' },
    });
  });

  it('asks again once forgotten', () => {
    useRememberedOfferTargetsStore.getState().remember('project:project-1', 'page', 'external');
    useRememberedOfferTargetsStore.getState().forget('project:project-1', 'page');

    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');

    expect(openTerminalUrl).not.toHaveBeenCalled();
    expect(pending('ws-1')).toBeDefined();
  });

  it('follows a choice another window remembers', () => {
    const remembered = JSON.stringify({ 'project:project-1': { page: 'external' } });
    window.localStorage.setItem('komla:browser-offer-targets', remembered);
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'komla:browser-offer-targets', newValue: remembered })
    );

    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');

    expect(openTerminalUrl).toHaveBeenCalledWith('http://localhost:5173/', 'external', {
      workspaceId: 'ws-1',
      executionLocation: 'workspace',
    });
  });

  it('opens a waiting offer once another window remembers its choice', () => {
    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');
    expect(openTerminalUrl).not.toHaveBeenCalled();

    useRememberedOfferTargetsStore.getState().remember('project:project-1', 'page', 'external');

    expect(openTerminalUrl).toHaveBeenCalledWith('http://localhost:5173/', 'external', {
      workspaceId: 'ws-1',
      executionLocation: 'workspace',
    });
  });

  it('survives a restart', () => {
    useRememberedOfferTargetsStore.getState().remember('project:project-1', 'desktop', 'vnc-app');

    expect(JSON.parse(window.localStorage.getItem('komla:browser-offer-targets')!)).toEqual({
      'project:project-1': { desktop: 'vnc-app' },
    });
  });
});

describe('offerVirtualDesktop', () => {
  it('asks between the VNC app and Komla, as the desktop allows', () => {
    expect(browserOfferTargets({ kind: 'desktop', desktop })).toEqual(['vnc-app', 'preview']);
    expect(
      browserOfferTargets({
        kind: 'desktop',
        desktop: { ...desktop, vncApp: undefined },
      })
    ).toEqual(['preview']);
    expect(
      browserOfferTargets({
        kind: 'desktop',
        desktop: { ...desktop, url: undefined },
      })
    ).toEqual(['vnc-app']);
  });

  it('opens it in the VNC app the user picks, and stops asking', () => {
    offerVirtualDesktop('ws-1', desktop);
    expect(openVirtualDesktopInVncApp).not.toHaveBeenCalled();

    openBrowserOffer('ws-1', 'vnc-app');

    expect(openVirtualDesktopInVncApp).toHaveBeenCalledWith('ws-1', 5901);
    expect(pending('ws-1')).toBeUndefined();
  });

  it("holds an agent's --app until the user comes to the workspace", () => {
    offerVirtualDesktop('ws-2', desktop, 'vnc-app');
    expect(openVirtualDesktopInVncApp).not.toHaveBeenCalled();

    show('ws-2');

    expect(openVirtualDesktopInVncApp).toHaveBeenCalledWith('ws-2', 5901);
    expect(pending('ws-2')).toBeUndefined();
  });

  it("keeps an agent's --app when a page offer follows it", () => {
    offerVirtualDesktop('ws-2', desktop, 'vnc-app');
    offerDevPreview('ws-2', 'http://localhost:5173/', 'workspace');

    show('ws-2');

    expect(openVirtualDesktopInVncApp).toHaveBeenCalledWith('ws-2', 5901);
    expect(pending('ws-2')).toMatchObject({ kind: 'page' });
  });

  it.each([
    ['asked about', undefined],
    ['held for --app', 'vnc-app' as const],
  ])('forgets a desktop %s once it stops', (_case, opensIn) => {
    const withDesktops = (virtualDesktops: unknown[]) =>
      useWorkspacesStore.setState((state) => ({
        workspaces: state.workspaces.map((w) => (w.id === 'ws-2' ? { ...w, virtualDesktops } : w)),
      }));
    withDesktops([desktop]);
    offerVirtualDesktop('ws-2', desktop, opensIn);

    withDesktops([]);
    show('ws-2');

    expect(pending('ws-2')).toBeUndefined();
    expect(openVirtualDesktopInVncApp).not.toHaveBeenCalled();
  });

  it('opens a desktop both held and asked about only once', () => {
    useRememberedOfferTargetsStore.getState().remember('project:project-1', 'desktop', 'vnc-app');
    useDevPreviewOffersStore.getState().offer('ws-2', { kind: 'desktop', desktop });
    offerVirtualDesktop('ws-2', desktop, 'vnc-app');

    show('ws-2');

    expect(openVirtualDesktopInVncApp).toHaveBeenCalledTimes(1);
    expect(pending('ws-2')).toBeUndefined();
  });

  it("doesn't forget a desktop that its workspace hasn't listed yet", () => {
    offerVirtualDesktop('ws-2', desktop, 'vnc-app');
    useWorkspacesStore.setState((state) => ({ workspaces: [...state.workspaces] }));

    show('ws-2');

    expect(openVirtualDesktopInVncApp).toHaveBeenCalledWith('ws-2', 5901);
  });

  it('asks again on a computer without the VNC app the project remembered', () => {
    useRememberedOfferTargetsStore.getState().remember('project:project-1', 'desktop', 'vnc-app');

    offerVirtualDesktop('ws-1', { ...desktop, vncApp: undefined });

    expect(openVirtualDesktopInVncApp).not.toHaveBeenCalled();
    expect(openTerminalUrl).not.toHaveBeenCalled();
    expect(pending('ws-1')).toBeDefined();
  });
});

describe('settling an offer', () => {
  it('stops asking once the offered page opens under any loopback alias', () => {
    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');

    settleDevPreviewOffer('ws-1', 'http://127.0.0.1:5173/');

    expect(pending('ws-1')).toBeUndefined();
  });

  it('matches a page offered on every interface, or on another site, however it is spelled', () => {
    offerDevPreview('ws-1', 'http://0.0.0.0:3000/', 'workspace');
    settleDevPreviewOffer('ws-1', 'http://localhost:3000');
    expect(pending('ws-1')).toBeUndefined();

    offerDevPreview('ws-1', 'https://preview.example.com', 'workspace');
    settleDevPreviewOffer('ws-1', 'https://preview.example.com/');
    expect(pending('ws-1')).toBeUndefined();
  });

  it('keeps asking when another page opens', () => {
    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');

    settleDevPreviewOffer('ws-1', 'http://localhost:4000/');

    expect(pending('ws-1')).toBeDefined();
  });

  it('stops asking about a desktop once it opens, from its page or in the VNC app', () => {
    offerVirtualDesktop('ws-1', desktop);
    settleDevPreviewOffer('ws-1', desktop.url);
    expect(pending('ws-1')).toBeUndefined();

    offerVirtualDesktop('ws-1', desktop);
    settleVirtualDesktopOffer('ws-1', 5902);
    expect(pending('ws-1')).toBeDefined();
    settleVirtualDesktopOffer('ws-1', 5901);
    expect(pending('ws-1')).toBeUndefined();
  });
});
