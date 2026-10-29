import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  latestFirst,
  queuePrintedFileHyperlink,
  takeQueuedFileHyperlinks,
  useTerminalFilesStore,
  type TerminalFilePrint,
} from '@/stores/terminal-files.store';

const context = { workspaceId: 'ws-1', workspaceBackendKind: 'local' as const };

function printed(fullPath: string, printedAt?: number, terminalId = 't1'): TerminalFilePrint {
  return { path: fullPath, terminalId, target: { type: 'external', fullPath }, context, printedAt };
}

afterEach(() => {
  vi.restoreAllMocks();
  useTerminalFilesStore.setState(useTerminalFilesStore.getInitialState(), true);
});

describe('terminal-files.store', () => {
  it('orders files by when they were last opened or printed, untimed ones last', () => {
    const file = (fullPath: string, times: { printedAt?: number; openedAt?: number }) => ({
      ...printed(fullPath, times.printedAt),
      openedAt: times.openedAt,
    });
    const files = [
      // Opened a while ago, inside and outside the workspace.
      file('/tmp/old.md', { printedAt: 5, openedAt: 10 }),
      {
        ...file('src/older.ts', { openedAt: 8 }),
        target: { type: 'workspace' as const, filePath: 'src/older.ts' },
      },
      file('/tmp/untimed.md', {}),
      // Printed together just now, and the one of them just opened.
      file('/tmp/b.md', { printedAt: 50 }),
      file('/tmp/c.md', { printedAt: 50 }),
      file('/tmp/a.md', { printedAt: 50, openedAt: 60 }),
    ];

    expect(latestFirst(files).map((f) => f.path)).toEqual([
      '/tmp/a.md',
      '/tmp/b.md',
      '/tmp/c.md',
      '/tmp/old.md',
      'src/older.ts',
      '/tmp/untimed.md',
    ]);
  });

  it('keeps each file once, at the latest time it was printed', () => {
    const { notePrinted } = useTerminalFilesStore.getState();
    notePrinted('ws-1', [printed('/tmp/a.png', 20), printed('/tmp/a.png', 10)]);
    notePrinted('ws-1', [printed('/tmp/a.png'), printed('/tmp/a.png', 30)]);
    // The same path in another terminal can be another machine's file.
    notePrinted('ws-1', [printed('/tmp/a.png', 5, 't2')]);

    expect(
      useTerminalFilesStore
        .getState()
        .byWorkspace['ws-1'].map(({ terminalId, printedAt }) => [terminalId, printedAt])
    ).toEqual([
      ['t1', 30],
      ['t2', 5],
    ]);
  });

  it('keeps when an opened file was printed', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const { notePrinted, noteOpened } = useTerminalFilesStore.getState();
    notePrinted('ws-1', [printed('/tmp/a.png', 20)]);
    noteOpened('ws-1', { ...printed('/tmp/a.png'), lineNumber: 3 });

    expect(useTerminalFilesStore.getState().byWorkspace['ws-1']).toEqual([
      { ...printed('/tmp/a.png', 20), lineNumber: 3, openedAt: 100 },
    ]);
  });

  it('drops the files seen longest ago past 200 per workspace', () => {
    const prints = Array.from({ length: 201 }, (_, i) => printed(`/tmp/${i}.png`, i));
    useTerminalFilesStore.getState().notePrinted('ws-1', prints);

    const files = useTerminalFilesStore.getState().byWorkspace['ws-1'];
    expect(files).toHaveLength(200);
    expect(files.some((file) => file.path === '/tmp/0.png')).toBe(false);
  });

  it('keeps opened files however many files are printed after them', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const { notePrinted, noteOpened } = useTerminalFilesStore.getState();
    noteOpened('ws-1', printed('/tmp/opened.png'));
    // A test run or a stack trace prints a lot of paths, most of which the list never shows.
    notePrinted(
      'ws-1',
      Array.from({ length: 250 }, (_, i) => printed(`/tmp/${i}.png`, 200 + i))
    );

    const files = useTerminalFilesStore.getState().byWorkspace['ws-1'];
    expect(files).toHaveLength(200);
    expect(files.some((file) => file.path === '/tmp/opened.png')).toBe(true);
  });

  it('takes the line and terminal of the latest print of a file', () => {
    const workspaceFile = (lineNumber: number, terminalId: string, printedAt: number) => ({
      path: 'src/app.ts',
      lineNumber,
      terminalId,
      target: { type: 'workspace' as const, filePath: 'src/app.ts' },
      context,
      printedAt,
    });
    const { notePrinted } = useTerminalFilesStore.getState();
    notePrinted('ws-1', [workspaceFile(10, 't1', 10)]);
    notePrinted('ws-1', [workspaceFile(250, 't2', 20), workspaceFile(5, 't1', 15)]);

    expect(useTerminalFilesStore.getState().byWorkspace['ws-1']).toEqual([
      workspaceFile(250, 't2', 20),
    ]);
  });

  it('holds each hyperlinked file once, however often a redraw prints it', () => {
    queuePrintedFileHyperlink('ws-1', printed('/tmp/b.png', 1));
    for (let i = 0; i < 600; i++) queuePrintedFileHyperlink('ws-1', printed('/tmp/a.png', 2 + i));

    expect(takeQueuedFileHyperlinks('ws-1')).toEqual([
      printed('/tmp/a.png', 601),
      printed('/tmp/b.png', 1),
    ]);
    expect(takeQueuedFileHyperlinks('ws-1')).toEqual([]);
  });
});
