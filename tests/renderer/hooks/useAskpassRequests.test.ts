// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAskpassRequests } from '../../../src/renderer/hooks/useAskpassRequests';
import { useToastStore } from '../../../src/renderer/stores/toast.store';

import type { AskpassRequest } from '../../../src/shared/types';

let deliver: (request: AskpassRequest) => void = () => undefined;
let end: (id: string) => void = () => undefined;
let notRemembered: (keyPath: string) => void = () => undefined;
const sendAskpassResponse = vi.fn();

function request(id: string, expiresAt = 1000): AskpassRequest {
  return { id, prompt: 'Password: ', canRemember: false, expiresAt };
}

describe('useAskpassRequests', () => {
  beforeEach(() => {
    sendAskpassResponse.mockClear();
    useToastStore.setState({ toasts: [] });
    Object.assign(window, {
      api: {
        onAskpassRequest: (callback: (request: AskpassRequest) => void) => {
          deliver = callback;
          return () => undefined;
        },
        onAskpassEnded: (callback: (id: string) => void) => {
          end = callback;
          return () => undefined;
        },
        onAskpassNotRemembered: (callback: (keyPath: string) => void) => {
          notRemembered = callback;
          return () => undefined;
        },
        sendAskpassResponse,
      },
    });
  });

  it('shows requests one at a time in the order they arrived', () => {
    const { result } = renderHook(() => useAskpassRequests());

    act(() => {
      deliver(request('req-1'));
      deliver(request('req-2'));
    });
    expect(result.current.request?.id).toBe('req-1');

    act(() => result.current.respond('req-1', 'secret', true));

    expect(sendAskpassResponse).toHaveBeenCalledWith('req-1', 'secret', true);
    expect(result.current.request?.id).toBe('req-2');
  });

  it('drops requests Komla ended, even ones still waiting', () => {
    const { result } = renderHook(() => useAskpassRequests());

    act(() => {
      deliver(request('req-1'));
      deliver(request('req-2'));
      deliver(request('req-3'));
      end('req-2');
      end('req-1');
    });

    expect(result.current.request?.id).toBe('req-3');
    expect(sendAskpassResponse).not.toHaveBeenCalled();
  });

  it('tells the user when Komla could not remember a passphrase', () => {
    renderHook(() => useAskpassRequests());

    act(() => notRemembered('/home/me/.ssh/id_ed25519'));

    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({
        message:
          "Komla couldn't confirm the passphrase for /home/me/.ssh/id_ed25519, so it won't remember it.",
        type: 'error',
      }),
    ]);
  });
});
