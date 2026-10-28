import { describe, expect, it } from 'vitest';

import {
  findNextAttentionWorkspaceId,
  getTabAttentionDisplay,
  getTerminalTabLabel,
  getWorkspaceAttentionAppearance,
  resolveAttentionDelivery,
  summarizeWorkspaceAttention,
  type AttentionDeliveryContext,
} from '../../../src/renderer/lib/workspace-attention';
import { createTerminal, createWorkspace } from '../../factories';

import type { WorkspaceAttention } from '../../../src/shared/types';

function attention(kind: WorkspaceAttention['kind']): WorkspaceAttention {
  return { kind, source: 'claude-code', updatedAt: 1 };
}

describe('getTabAttentionDisplay', () => {
  it('says when its spinner is only for commands run with `komla notify --`', () => {
    const command = createTerminal({ agentActive: true, commandActive: true });
    const agent = createTerminal({ agentActive: true });
    expect(getTabAttentionDisplay([command], false)).toEqual({
      showSpinner: true,
      commandsOnly: true,
      attention: undefined,
    });
    expect(getTabAttentionDisplay([command, agent], false)).toEqual({
      showSpinner: true,
      attention: undefined,
    });
  });

  it('shows nothing while the tab content is visible', () => {
    const terminals = [
      createTerminal({ agentActive: true, attention: attention('input-required') }),
    ];
    expect(getTabAttentionDisplay(terminals, true)).toEqual({
      showSpinner: false,
      attention: undefined,
    });
  });

  it('keeps attention for visible split panes that are not focused', () => {
    const done = attention('turn-complete');
    const terminals = [
      createTerminal({ id: 'focused', attention: attention('input-required') }),
      createTerminal({ id: 'unfocused', attention: done }),
    ];
    expect(getTabAttentionDisplay(terminals, true, 'focused')).toEqual({
      showSpinner: false,
      attention: done,
    });
  });

  it('shows the spinner for a hidden tab whose terminal has an active agent', () => {
    const terminals = [createTerminal({ agentActive: true })];
    expect(getTabAttentionDisplay(terminals, false)).toEqual({
      showSpinner: true,
      attention: undefined,
    });
  });

  it('surfaces attention for a hidden tab', () => {
    const done = attention('turn-complete');
    expect(getTabAttentionDisplay([createTerminal({ attention: done })], false)).toEqual({
      showSpinner: false,
      attention: done,
    });
  });

  it('prefers actionable attention over informational attention across split panes', () => {
    const prompt = attention('input-required');
    const terminals = [
      createTerminal({ attention: attention('turn-complete') }),
      createTerminal({ attention: prompt }),
    ];
    expect(getTabAttentionDisplay(terminals, false).attention).toBe(prompt);
  });

  it('falls back to the first informational attention when none is actionable', () => {
    const idle = attention('idle');
    const terminals = [createTerminal({ attention: idle }), createTerminal()];
    expect(getTabAttentionDisplay(terminals, false).attention).toBe(idle);
  });

  it('prefers done over idle across split panes', () => {
    const done = attention('turn-complete');
    const terminals = [
      createTerminal({ attention: attention('idle') }),
      createTerminal({ attention: done }),
    ];
    expect(getTabAttentionDisplay(terminals, false).attention).toBe(done);
  });

  it('leaves out a done the user saw on a pane beside the focused one', () => {
    const idle = attention('idle');
    const terminals = [
      createTerminal({ attention: { ...attention('turn-complete'), seen: true } }),
      createTerminal({ attention: idle }),
    ];
    expect(getTabAttentionDisplay(terminals, false).attention).toBe(idle);
  });

  it('reports no spinner or attention when the tab has neither', () => {
    expect(getTabAttentionDisplay([createTerminal()], false)).toEqual({
      showSpinner: false,
      attention: undefined,
    });
  });
});

describe('getWorkspaceAttentionAppearance', () => {
  it('uses custom notification presentation', () => {
    expect(
      getWorkspaceAttentionAppearance({
        ...attention('generic'),
        title: 'Review ready',
        body: 'Authentication changes are waiting.',
        color: 'oklch(62% 0.2 285)',
      })
    ).toEqual(
      expect.objectContaining({
        label: 'Review ready',
        body: 'Authentication changes are waiting.',
        tooltip: 'Review ready: Authentication changes are waiting.',
        heading: 'Review ready',
        detail: 'Authentication changes are waiting.',
        badgeStyle: { backgroundColor: 'oklch(62% 0.2 285)' },
        borderColor: 'oklch(62% 0.2 285)',
      })
    );
  });

  it('shows a badge on the pill and keeps the title for the card', () => {
    expect(
      getWorkspaceAttentionAppearance({
        ...attention('generic'),
        title: 'CI failed on main',
        badge: 'CI',
        body: '2 checks failed',
      })
    ).toEqual(
      expect.objectContaining({
        label: 'CI',
        heading: 'CI failed on main',
        tooltip: 'CI failed on main: 2 checks failed',
      })
    );
  });

  it('colors a notification with a theme tone, as Komla colors its own', () => {
    const appearance = getWorkspaceAttentionAppearance({
      ...attention('generic'),
      title: 'Deploy failed',
      color: 'error',
    });

    expect(appearance).toEqual(
      expect.objectContaining({
        tone: 'error',
        dotClassName: 'bg-error',
        borderColor: 'oklch(var(--error))',
      })
    );
    expect(appearance?.badgeStyle).toBeUndefined();
    expect(
      getWorkspaceAttentionAppearance({ ...attention('turn-complete'), color: 'muted' })
    ).toEqual(expect.objectContaining({ tone: 'neutral', dotClassName: 'bg-muted-foreground/60' }));
  });

  it("takes a color named like an object's own property for a CSS color, not a tone", () => {
    expect(
      getWorkspaceAttentionAppearance({
        ...attention('generic'),
        title: 'Done',
        color: 'constructor',
      })
    ).toEqual(
      expect.objectContaining({
        badgeStyle: { backgroundColor: 'constructor' },
        borderColor: 'constructor',
      })
    );
  });

  it('keeps lifecycle messages out of the card body', () => {
    expect(
      getWorkspaceAttentionAppearance({
        ...attention('turn-complete'),
        message: 'Review ready',
      })
    ).toEqual(
      expect.objectContaining({ label: 'Done', body: undefined, tooltip: 'Done: Review ready' })
    );
  });

  it('heads the card with what happened and keeps the whole message under it', () => {
    const message =
      'Refactored the session store.\n\nTests pass; the staging secret is still missing.';
    expect(
      getWorkspaceAttentionAppearance({ ...attention('turn-complete'), message: `  ${message} ` })
    ).toEqual(expect.objectContaining({ heading: 'Agent finished a turn', detail: message }));
    expect(getWorkspaceAttentionAppearance(attention('error'))).toEqual(
      expect.objectContaining({ heading: 'Agent reported an error', detail: undefined })
    );
  });

  it('keeps a generic message used as the badge in the card body too', () => {
    expect(
      getWorkspaceAttentionAppearance({ ...attention('generic'), message: 'Deploy finished' })
    ).toEqual(
      expect.objectContaining({
        heading: 'Workspace has a notification',
        detail: 'Deploy finished',
      })
    );
  });

  it('uses generic messages as the badge without duplicating the body', () => {
    expect(
      getWorkspaceAttentionAppearance({
        ...attention('generic'),
        message: 'Review ready',
      })
    ).toEqual(expect.objectContaining({ label: 'Review ready', body: undefined }));
  });

  it('falls back to Notice when a generic notification has no title or message', () => {
    expect(getWorkspaceAttentionAppearance(attention('generic'))?.label).toBe('Notice');
  });

  it.each([
    ['input-required', 'attention'],
    ['error', 'error'],
    ['turn-complete', 'success'],
    ['idle', 'neutral'],
    ['generic', 'neutral'],
  ] as const)('gives the %s badge the %s tone', (kind, tone) => {
    expect(getWorkspaceAttentionAppearance(attention(kind))).toEqual(
      expect.objectContaining({ tone })
    );
  });

  it.each(['input-required', 'turn-complete', 'error', 'idle', 'generic'] as const)(
    'gives the %s badge exactly one theme-aware text color',
    (kind) => {
      const classes = getWorkspaceAttentionAppearance(attention(kind))!.badgeClassName.split(' ');
      const textColors = classes.filter((c) => c.startsWith('text-'));
      const darkOverrides = classes.filter((c) => c.startsWith('dark:'));

      expect(textColors).toHaveLength(1);
      expect(darkOverrides).toHaveLength(0);
    }
  );
});

describe('getTerminalTabLabel', () => {
  it('names the status shown by the tab dot', () => {
    expect(
      getTerminalTabLabel(
        'Claude Code',
        getWorkspaceAttentionAppearance(attention('input-required')),
        false
      )
    ).toBe('Claude Code — Agent needs your input');
    expect(
      getTerminalTabLabel('Claude Code', getWorkspaceAttentionAppearance(attention('error')), true)
    ).toBe('Claude Code — Agent reported an error');
  });

  it('names the running spinner', () => {
    expect(getTerminalTabLabel('Claude Code', null, true)).toBe('Claude Code — Agent processing');
    expect(getTerminalTabLabel('zsh', null, true, true)).toBe('zsh — Command running');
  });

  it('is just the title when the tab shows no status', () => {
    expect(getTerminalTabLabel('Claude Code', null, false)).toBe('Claude Code');
  });
});

describe('resolveAttentionDelivery', () => {
  const done = { ...attention('turn-complete'), terminalId: 't1' };
  const base: AttentionDeliveryContext = {
    currentWindowId: 'w1',
    ownerWindowId: 'w1',
    openWindows: [
      { id: 'w1', displayNumber: 1 },
      { id: 'w2', displayNumber: 2 },
    ],
    isSelected: true,
    windowFocused: true,
    previewFullscreen: false,
    focusedTerminalId: 't1',
  };

  it('keeps a snoozed workspace quiet but still shows its attention', () => {
    expect(resolveAttentionDelivery(done, { ...base, isSelected: false, snoozed: true })).toEqual({
      action: 'set',
      playSound: false,
    });
  });

  it('still keeps attention quietly on a snoozed workspace the user is looking at', () => {
    expect(resolveAttentionDelivery(done, { ...base, snoozed: true })).toEqual({
      action: 'set',
      playSound: false,
      awaitReturn: true,
    });
  });

  it('delivers input requests from a snoozed workspace, since they wake it', () => {
    const input = { ...attention('input-required'), terminalId: 't1' };
    expect(resolveAttentionDelivery(input, { ...base, isSelected: false, snoozed: true })).toEqual({
      action: 'set',
      playSound: true,
    });
  });

  it('keeps attention quietly on the focused terminal until the user next shows they are there', () => {
    expect(resolveAttentionDelivery(done, base)).toEqual({
      action: 'set',
      playSound: false,
      awaitReturn: true,
    });
  });

  it('keeps attention on the focused terminal until the user returns when they were away', () => {
    expect(resolveAttentionDelivery(done, { ...base, userAway: true })).toEqual({
      action: 'set',
      playSound: true,
      awaitReturn: true,
    });
    expect(
      resolveAttentionDelivery(done, { ...base, userAway: true, focusedTerminalId: 't2' })
    ).toEqual({ action: 'set', playSound: true });
  });

  it('keeps workspace-level attention on the selected workspace until the user returns when they were away', () => {
    expect(resolveAttentionDelivery(attention('generic'), { ...base, userAway: true })).toEqual({
      action: 'set',
      playSound: true,
      awaitReturn: true,
    });
  });

  it('keeps attention and plays when the focused terminal is in an unfocused window', () => {
    expect(resolveAttentionDelivery(done, { ...base, windowFocused: false })).toEqual({
      action: 'set',
      playSound: true,
    });
  });

  it('keeps workspace-level attention when the window is unfocused', () => {
    const generic = attention('generic');
    expect(resolveAttentionDelivery(generic, { ...base, windowFocused: false })).toEqual({
      action: 'set',
      playSound: true,
    });
    expect(resolveAttentionDelivery(generic, base)).toEqual({
      action: 'clear-workspace',
      playSound: true,
    });
  });

  it('plays only in the window that owns the workspace', () => {
    const hidden = { ...base, isSelected: false };
    expect(resolveAttentionDelivery(done, hidden)).toEqual({ action: 'set', playSound: true });
    expect(resolveAttentionDelivery(done, { ...hidden, currentWindowId: 'w2' })).toEqual({
      action: 'set',
      playSound: false,
    });
  });

  it('does not play in another window while the owner shows the focused terminal', () => {
    expect(
      resolveAttentionDelivery(done, { ...base, currentWindowId: 'w2', isSelected: false })
        .playSound
    ).toBe(false);
  });

  it('falls back to the first open window when the owner is unknown or closed', () => {
    for (const ownerWindowId of [null, undefined, 'closed']) {
      const ctx = { ...base, ownerWindowId, isSelected: false };
      expect(resolveAttentionDelivery(done, ctx).playSound).toBe(true);
      expect(resolveAttentionDelivery(done, { ...ctx, currentWindowId: 'w2' }).playSound).toBe(
        false
      );
    }
  });

  it('stays silent until the window list loads unless this window owns the workspace', () => {
    const ctx = { ...base, openWindows: [], isSelected: false };
    expect(resolveAttentionDelivery(done, ctx).playSound).toBe(true);
    expect(resolveAttentionDelivery(done, { ...ctx, currentWindowId: 'w2' }).playSound).toBe(false);
    expect(resolveAttentionDelivery(done, { ...ctx, ownerWindowId: null }).playSound).toBe(false);
  });

  it('keeps attention and plays behind a fullscreen preview', () => {
    expect(resolveAttentionDelivery(done, { ...base, previewFullscreen: true })).toEqual({
      action: 'set',
      playSound: true,
    });
  });
});

describe('summarizeWorkspaceAttention', () => {
  it('counts input, errors, and agents still working without double counting', () => {
    const running = [createTerminal({ status: 'running' })];
    expect(
      summarizeWorkspaceAttention([
        createWorkspace({ attention: attention('input-required'), terminals: running }),
        createWorkspace({ attention: attention('input-required') }),
        createWorkspace({ attention: attention('error') }),
        createWorkspace({ agentActive: true, terminals: running }),
        // Waiting on the user wins over the spinner.
        createWorkspace({
          agentActive: true,
          attention: attention('input-required'),
          terminals: running,
        }),
        // A stopped workspace's stale spinner flag is not work in progress.
        createWorkspace({ agentActive: true, terminals: [] }),
        createWorkspace({ attention: attention('turn-complete') }),
      ])
    ).toEqual({ needsInput: 3, errors: 1, running: 1 });
  });
});

describe('findNextAttentionWorkspaceId', () => {
  const ws = (id: string, kind?: WorkspaceAttention['kind']) => ({
    id,
    attention: kind ? attention(kind) : undefined,
  });

  it('picks the next workspace needing input after the current one, wrapping around', () => {
    const ordered = [ws('a', 'input-required'), ws('b'), ws('c', 'input-required'), ws('d')];
    expect(findNextAttentionWorkspaceId(ordered, 'b')).toBe('c');
    expect(findNextAttentionWorkspaceId(ordered, 'c')).toBe('a');
    expect(findNextAttentionWorkspaceId(ordered, 'd')).toBe('a');
  });

  it('starts from the top when nothing is selected', () => {
    expect(findNextAttentionWorkspaceId([ws('a'), ws('b', 'input-required')], null)).toBe('b');
  });

  it('prefers input over errors, and falls back to errors when nothing needs input', () => {
    expect(
      findNextAttentionWorkspaceId([ws('a', 'error'), ws('b'), ws('c', 'input-required')], 'b')
    ).toBe('c');
    expect(findNextAttentionWorkspaceId([ws('a', 'error'), ws('b', 'turn-complete')], 'b')).toBe(
      'a'
    );
  });

  it('moves on from the current workspace even when it needs input itself', () => {
    expect(findNextAttentionWorkspaceId([ws('a', 'input-required'), ws('b', 'error')], 'a')).toBe(
      'b'
    );
  });

  it('returns null when no other workspace needs the user', () => {
    expect(findNextAttentionWorkspaceId([ws('a', 'input-required'), ws('b', 'idle')], 'a')).toBe(
      null
    );
    expect(findNextAttentionWorkspaceId([], null)).toBe(null);
  });
});
