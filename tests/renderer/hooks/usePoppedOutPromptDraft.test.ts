/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { usePoppedOutPromptDraft } from '../../../src/renderer/hooks/usePoppedOutPromptDraft';
import { PROMPT_DRAFT_ATTRIBUTE } from '../../../src/renderer/lib/prompt-draft';
import { usePromptDraftStore } from '../../../src/renderer/stores/prompt-draft.store';
import { useToastStore } from '../../../src/renderer/stores/toast.store';
import { useViewedFileStore } from '../../../src/renderer/stores/viewed-file.store';

import type { PromptDraftText, PromptDraftWindowStatus } from '../../../src/shared/types';

const { createNote } = vi.hoisted(() => ({ createNote: vi.fn(() => Promise.resolve(true)) }));
vi.mock('../../../src/renderer/lib/notes', () => ({ createNote }));
const { getFocusedPromptTerminalId, focusTerminalRenderer } = vi.hoisted(() => ({
  getFocusedPromptTerminalId: vi.fn((_workspaceId: string): string | null => null),
  focusTerminalRenderer: vi.fn(),
}));
vi.mock('../../../src/renderer/lib/focused-terminal', () => ({ getFocusedPromptTerminalId }));
vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({ focusTerminalRenderer }));

/** What main sends this window, by channel. */
const main = {
  status: null as ((status: PromptDraftWindowStatus) => void) | null,
  poppedIn: null as ((draft: PromptDraftText) => void) | null,
  referenceRequest: null as (() => void) | null,
  saveAsNote: null as ((workspaceId: string, text: string) => void) | null,
  copied: null as (() => void) | null,
};

function listen<K extends keyof typeof main>(key: K) {
  return vi.fn((callback: NonNullable<(typeof main)[K]>) => {
    main[key] = callback as (typeof main)[K];
    return () => {
      main[key] = null;
    };
  });
}

const api = {
  platform: 'linux',
  getPromptDraftWindowStatus: vi.fn(() => Promise.resolve({ poppedOut: false, visible: false })),
  onPromptDraftWindowStatus: listen('status'),
  onPromptDraftPoppedIn: listen('poppedIn'),
  onPromptDraftReferenceRequest: listen('referenceRequest'),
  onPromptDraftSaveAsNote: listen('saveAsNote'),
  onPromptDraftCopied: listen('copied'),
  setPromptDraftContext: vi.fn(),
  sendPromptDraftReference: vi.fn(),
  sendPromptDraftNoteSaved: vi.fn(),
};

/** This window shows ws-1, with server.ts on screen there. */
function showWorkspace() {
  act(() => {
    usePromptDraftStore.getState().addHost('window', 'ws-1');
    useViewedFileStore.getState().show('viewer', {
      workspaceId: 'ws-1',
      name: 'server.ts',
      getReference: () => '@server.ts:1-3',
    });
  });
}

describe('usePoppedOutPromptDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'api', { value: api, configurable: true });
    usePromptDraftStore.setState(usePromptDraftStore.getInitialState(), true);
    useViewedFileStore.setState({ viewed: [] });
    useToastStore.setState({ toasts: [] });
    document.documentElement.className = 'dark';
  });

  it('follows whether the draft is popped out, as main says', async () => {
    api.getPromptDraftWindowStatus.mockResolvedValueOnce({ poppedOut: true, visible: false });
    renderHook(usePoppedOutPromptDraft);
    await waitFor(() =>
      expect(usePromptDraftStore.getState().poppedOut).toEqual({ poppedOut: true, visible: false })
    );
    act(() => main.status?.({ poppedOut: true, visible: true }));
    expect(usePromptDraftStore.getState().poppedOut).toEqual({ poppedOut: true, visible: true });
  });

  it("tells main what's on screen here, and Komla's theme, only while popped out", async () => {
    showWorkspace();
    renderHook(usePoppedOutPromptDraft);
    await act(() => Promise.resolve());
    expect(api.setPromptDraftContext).not.toHaveBeenCalled();

    act(() => main.status?.({ poppedOut: true, visible: true }));
    expect(api.setPromptDraftContext).toHaveBeenLastCalledWith({
      theme: { className: 'dark', style: '' },
      workspaceId: 'ws-1',
      viewedFileName: 'server.ts',
    });

    act(() => useViewedFileStore.getState().hide('viewer'));
    expect(api.setPromptDraftContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ viewedFileName: null })
    );
    document.documentElement.className = 'light';
    await waitFor(() =>
      expect(api.setPromptDraftContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: { className: 'light', style: '' } })
      )
    );
  });

  it('gives the reference to the file on screen, and saves notes, as the draft asks', async () => {
    showWorkspace();
    renderHook(usePoppedOutPromptDraft);

    act(() => main.referenceRequest?.());
    expect(api.sendPromptDraftReference).toHaveBeenCalledWith('@server.ts:1-3');

    act(() => main.saveAsNote?.('ws-1', 'Keep this plan'));
    expect(createNote).toHaveBeenCalledWith('ws-1', 'Keep this plan');
    await waitFor(() => expect(api.sendPromptDraftNoteSaved).toHaveBeenCalledWith(true));
  });

  it('says the prompt was copied, for it to be pasted here', () => {
    renderHook(usePoppedOutPromptDraft);
    act(() => main.copied?.());
    expect(useToastStore.getState().toasts.map(({ message }) => message)).toEqual([
      'Copied the prompt',
    ]);
  });

  it("focuses the workspace's terminal once copied, though this window's own draft is open", () => {
    showWorkspace();
    usePromptDraftStore.getState().setPoppedOut({ poppedOut: true, visible: true });
    const draft = document.createElement('section');
    draft.setAttribute('role', 'dialog');
    draft.setAttribute(PROMPT_DRAFT_ATTRIBUTE, '');
    document.body.append(draft);
    onTestFinished(() => draft.remove());
    getFocusedPromptTerminalId.mockReturnValueOnce('terminal-1');
    renderHook(usePoppedOutPromptDraft);

    act(() => main.copied?.());

    expect(focusTerminalRenderer).toHaveBeenCalledWith('terminal-1');
  });

  it('takes the draft back as it pops in', () => {
    showWorkspace();
    renderHook(usePoppedOutPromptDraft);
    act(() => main.status?.({ poppedOut: true, visible: true }));

    act(() => main.poppedIn?.({ text: 'Fix the header', selectionStart: 3, selectionEnd: 3 }));

    const store = usePromptDraftStore.getState();
    expect(store.poppedOut).toEqual({ poppedOut: false, visible: false });
    expect(store.text).toBe('Fix the header');
    expect(store.isOpen).toBe(true);
    expect(store.selection).toEqual({ start: 3, end: 3 });
  });
});
