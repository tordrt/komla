/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openTerminalUrl = vi.hoisted(() => vi.fn());
const notePrintedHyperlink = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/lib/open-terminal-url', () => ({ openTerminalUrl }));
vi.mock('../../../src/renderer/lib/recent-links', () => ({ notePrintedHyperlink }));

import { offerDevPreview } from '../../../src/renderer/lib/dev-preview-offers';
import {
  settleDevPreviewOffer,
  useDevPreviewOffersStore,
} from '../../../src/renderer/stores/dev-preview-offers.store';
import { useLayoutStore } from '../../../src/renderer/stores/layout.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useWorkspacesStore } from '../../../src/renderer/stores/workspaces.store';

import type { Workspace } from '../../../src/shared/types';

const selectWorkspace = vi.fn(async () => {});

/** The one toast shown. */
function shownToast() {
  const { toasts } = useToastStore.getState();
  expect(toasts).toHaveLength(1);
  return toasts[0]!;
}

function hasDot(workspaceId: string): boolean {
  return useDevPreviewOffersStore.getState().unseen[workspaceId] === true;
}

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
  useDevPreviewOffersStore.setState({ offers: {}, unseen: {} });
  useLayoutStore.setState({ currentWorkspaceId: 'ws-1' });
  useWorkspacesStore.setState({
    workspaces: [{ id: 'ws-2', name: 'billing-fix', terminals: [] }] as unknown as Workspace[],
    selectWorkspace,
  });
});

describe('offerDevPreview', () => {
  it('offers the page without opening it, and marks the globe button', () => {
    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');

    const toast = shownToast();
    expect(toast.message).toBe('Preview ready: localhost:5173');
    expect(toast.action?.label).toBe('Open in browser');
    expect(toast.secondaryAction?.label).toBe('Open in Komla');
    expect(openTerminalUrl).not.toHaveBeenCalled();
    expect(hasDot('ws-1')).toBe(true);
  });

  it('opens the page in the default browser, forwarded from its machine, and clears the dot', () => {
    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');

    shownToast().action?.onClick();

    expect(openTerminalUrl).toHaveBeenCalledWith('http://localhost:5173/', 'external', {
      workspaceId: 'ws-1',
      executionLocation: 'workspace',
    });
    expect(selectWorkspace).not.toHaveBeenCalled();
    expect(hasDot('ws-1')).toBe(false);
  });

  it("names another workspace's page, and shows that workspace to open it in Komla", () => {
    offerDevPreview('ws-2', 'http://localhost:3000/pricing', 'workspace');

    const toast = shownToast();
    expect(toast.message).toBe('Preview ready in billing-fix: localhost:3000/pricing');
    toast.secondaryAction?.onClick();

    expect(selectWorkspace).toHaveBeenCalledWith('ws-2');
    expect(openTerminalUrl).toHaveBeenCalledWith('http://localhost:3000/pricing', 'preview', {
      workspaceId: 'ws-2',
      executionLocation: 'workspace',
    });
    expect(hasDot('ws-2')).toBe(false);
  });

  it("replaces the workspace's earlier offer instead of stacking another", () => {
    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');
    offerDevPreview('ws-1', 'http://localhost:5174/', 'workspace');

    expect(shownToast().message).toBe('Preview ready: localhost:5174');
  });

  it("lists a page on another site among the workspace's links", () => {
    offerDevPreview('ws-1', 'https://preview.example.com/', 'workspace');

    expect(notePrintedHyperlink).toHaveBeenCalledWith('ws-1', 'https://preview.example.com/');
  });
});

describe('settleDevPreviewOffer', () => {
  it('clears the dot and the toast once the offered page opens under any loopback alias', () => {
    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');

    settleDevPreviewOffer('ws-1', 'http://127.0.0.1:5173/');

    expect(hasDot('ws-1')).toBe(false);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('matches a page offered on every interface, or on another site, however it is spelled', () => {
    offerDevPreview('ws-1', 'http://0.0.0.0:3000/', 'workspace');
    settleDevPreviewOffer('ws-1', 'http://localhost:3000');
    expect(hasDot('ws-1')).toBe(false);

    offerDevPreview('ws-1', 'https://preview.example.com', 'workspace');
    settleDevPreviewOffer('ws-1', 'https://preview.example.com/');
    expect(hasDot('ws-1')).toBe(false);
  });

  it('keeps the offer when another page opens', () => {
    offerDevPreview('ws-1', 'http://localhost:5173/', 'workspace');

    settleDevPreviewOffer('ws-1', 'http://localhost:4000/');

    expect(hasDot('ws-1')).toBe(true);
    expect(shownToast().message).toBe('Preview ready: localhost:5173');
  });
});
