/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const launchAction = vi.fn();
vi.mock('../../../src/renderer/lib/action-launch', () => ({
  launchAction: (request: unknown) => launchAction(request),
}));

const dialogRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../src/renderer/components/workspaces/ActionInputDialog', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/renderer/components/workspaces/ActionInputDialog')
    >();
  return {
    ActionInputDialog: (props: Parameters<typeof actual.ActionInputDialog>[0]) => {
      dialogRenders.count++;
      return <actual.ActionInputDialog {...props} />;
    },
  };
});

import { useActionLauncher } from '../../../src/renderer/hooks/useActionLauncher';

import type { ActionPlace } from '../../../src/renderer/lib/action-launch';
import type { Action } from '../../../src/renderer/types';

const ask: Action = { id: 'ask', title: 'Ask', type: 'prompt', content: 'Explain {{user_input}}' };
const replace: ActionPlace = { kind: 'replace', terminalId: 'term-1', confirm: vi.fn() };

function Launcher({ place }: { place?: ActionPlace }) {
  const { runAction, actionInputDialog } = useActionLauncher('ws-1');
  return (
    <>
      <button onClick={() => runAction(ask, place)}>Run</button>
      {actionInputDialog}
    </>
  );
}

// Runs the Action, waits for the question and types an answer.
async function answer(place?: ActionPlace): Promise<void> {
  render(<Launcher place={place} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
  });
  fireEvent.change(await screen.findByPlaceholderText('Type or paste here...'), {
    target: { value: 'the build' },
  });
}

async function confirm(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Run quick command' }));
  });
}

describe('useActionLauncher', () => {
  beforeEach(() => {
    launchAction
      .mockReset()
      .mockImplementation(async ({ input }: { input?: string }) =>
        input === undefined ? 'needs-input' : 'launched'
      );
  });

  // Git status indicators each hold one, so a closed one must cost nothing.
  it('mounts the question only once an Action asks it', async () => {
    dialogRenders.count = 0;
    render(<Launcher />);
    expect(dialogRenders.count).toBe(0);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    });
    expect(await screen.findByPlaceholderText('Type or paste here...')).toBeInTheDocument();
  });

  it('runs an Action in a new tab unless told where', async () => {
    launchAction.mockResolvedValue('launched');
    render(<Launcher />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    });

    expect(launchAction).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      action: ask,
      place: { kind: 'tab' },
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks for the input, then launches again with it at the same place', async () => {
    await answer(replace);
    await confirm();

    expect(launchAction).toHaveBeenLastCalledWith({
      workspaceId: 'ws-1',
      action: ask,
      place: replace,
      input: 'the build',
    });
    expect(screen.queryByRole('dialog', { name: 'Ask' })).not.toBeInTheDocument();
  });

  it('launches nothing more when the question is cancelled', async () => {
    await answer();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });

    expect(launchAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Ask' })).not.toBeInTheDocument();
  });

  it('keeps the typed input when the Terminal is not replaced', async () => {
    await answer(replace);
    launchAction.mockResolvedValue('not-replaced');

    await confirm();

    expect(screen.getByRole('dialog', { name: 'Ask' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type or paste here...')).toHaveValue('the build');
  });

  it('keeps the typed input when a browser, note or file pane is not replaced', async () => {
    await answer({ kind: 'replace-surface', surfaceId: 's', paneId: 'p', tabId: 't' });
    launchAction.mockResolvedValue('not-replaced');

    await confirm();

    expect(screen.getByRole('dialog', { name: 'Ask' })).toBeInTheDocument();
  });

  it('closes the question at any other place whatever the launch does', async () => {
    await answer({ kind: 'type', terminalId: 'term-1' });
    launchAction.mockResolvedValue('failed');

    await confirm();

    expect(screen.queryByRole('dialog', { name: 'Ask' })).not.toBeInTheDocument();
  });
});
