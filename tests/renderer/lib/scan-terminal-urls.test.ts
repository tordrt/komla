import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCached, getCachedTerminalIds } = vi.hoisted(() => ({
  getCached: vi.fn(),
  getCachedTerminalIds: vi.fn(),
}));

vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => {
  const output = (workspaceId: string, maxLines: number) =>
    getCachedTerminalIds()
      .map((terminalId: string) => ({ terminalId, cached: getCached(terminalId) }))
      .filter(({ cached }: { cached: any }) =>
        Boolean(cached && !cached.isDisposed && cached.workspaceId === workspaceId)
      )
      .map(({ terminalId, cached }: { terminalId: string; cached: any }) => {
        const buffer = cached.terminal.buffer.active;
        let startY = Math.max(0, buffer.length - maxLines);
        while (startY > 0 && buffer.getLine(startY)?.isWrapped) startY--;
        const logicalLines: string[] = [];
        for (let y = startY; y < buffer.length; y++) {
          const line = buffer.getLine(y);
          if (!line) continue;
          const text = line.translateToString(false);
          if (line.isWrapped && logicalLines.length > 0)
            logicalLines[logicalLines.length - 1] += text;
          else logicalLines.push(text);
        }
        return {
          terminalId,
          executionLocation: cached.executionLocation ?? 'workspace',
          logicalLines: logicalLines.map((line) => line.trimEnd()),
          printedAt: cached.printedAt,
        };
      });
  return {
    getRecentTerminalRendererOutput: output,
    getTerminalRendererOutputSinceLastScan: output,
  };
});

import {
  parseLoopbackForwardIntent,
  scanWorkspaceTerminalsForLinks,
  scanWorkspaceTerminalsForLocalhostUrlCandidates,
  scanWorkspaceTerminalsForLocalhostUrls,
} from '../../../src/renderer/lib/scan-terminal-urls';

import type { SetupActivityRun } from '../../../src/shared/types';

interface FakeBufferLine {
  isWrapped?: boolean;
  text: string;
}

function makeCachedFromLines(lines: FakeBufferLine[], workspaceId: string | undefined): unknown {
  return {
    isDisposed: false,
    workspaceId,
    terminal: {
      buffer: {
        active: {
          length: lines.length,
          getLine: (y: number) => {
            const line = lines[y];
            if (!line) return undefined;
            return {
              isWrapped: line.isWrapped,
              translateToString: (trimRight?: boolean) =>
                trimRight ? line.text.trimEnd() : line.text,
            };
          },
        },
      },
    },
  };
}

beforeEach(() => {
  vi.mocked(getCached).mockReset();
  vi.mocked(getCachedTerminalIds).mockReset();
});

describe('parseLoopbackForwardIntent', () => {
  it('preserves HTTPS and its default port', () => {
    expect(parseLoopbackForwardIntent('https://localhost/dashboard')).toEqual({
      remotePort: 443,
      pathSuffix: '/dashboard',
      scheme: 'https',
    });
  });

  it('uses HTTP for ordinary loopback URLs', () => {
    expect(parseLoopbackForwardIntent('http://127.0.0.1:5173/')).toEqual({
      remotePort: 5173,
      pathSuffix: '',
      scheme: 'http',
    });
  });
});

describe('scanWorkspaceTerminalsForLocalhostUrls', () => {
  it('returns localhost URLs from a single terminal in the workspace', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [
          { text: '  ➜  Local:   http://localhost:5173/' },
          { text: '  ➜  Network: http://192.168.1.5:5173/' },
        ],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')).toEqual(['http://localhost:5173/']);
  });

  it('preserves the execution location of each matching terminal', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['remote', 'local']);
    vi.mocked(getCached).mockImplementation((id) => {
      const cached = makeCachedFromLines(
        [{ text: 'Local: http://localhost:5173/' }],
        'ws-1'
      ) as ReturnType<typeof getCached> & { executionLocation?: 'workspace' | 'local-mirror' };
      cached.executionLocation = id === 'local' ? 'local-mirror' : 'workspace';
      return cached;
    });

    expect(scanWorkspaceTerminalsForLocalhostUrlCandidates('ws-1')).toEqual([
      {
        url: 'http://localhost:5173/',
        terminalId: 'remote',
        executionLocation: 'workspace',
      },
      {
        url: 'http://localhost:5173/',
        terminalId: 'local',
        executionLocation: 'local-mirror',
      },
    ]);
  });

  it('skips terminals from other workspaces', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1', 't2']);
    vi.mocked(getCached).mockImplementation((id) => {
      if (id === 't1') {
        return makeCachedFromLines(
          [{ text: 'Local: http://localhost:5173/' }],
          'ws-1'
        ) as ReturnType<typeof getCached>;
      }
      return makeCachedFromLines([{ text: 'Local: http://localhost:3000/' }], 'ws-2') as ReturnType<
        typeof getCached
      >;
    });

    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')).toEqual(['http://localhost:5173/']);
  });

  it('dedupes URLs that appear multiple times', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [
          { text: 'starting on http://localhost:5173/' },
          { text: 'reloaded http://localhost:5173/' },
          { text: 'switching to http://localhost:5174/' },
        ],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    const result = scanWorkspaceTerminalsForLocalhostUrls('ws-1');
    expect(result).toHaveLength(2);
    expect(result).toContain('http://localhost:5173/');
    expect(result).toContain('http://localhost:5174/');
  });

  it('dedupes URLs that differ only by a trailing slash on the root path', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [{ text: 'Local:   http://127.0.0.1:4321' }, { text: 'Network: http://127.0.0.1:4321/' }],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')).toEqual(['http://127.0.0.1:4321/']);
  });

  it('strips trailing punctuation', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines([{ text: 'see (http://localhost:5173/).' }], 'ws-1') as ReturnType<
        typeof getCached
      >
    );

    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')).toEqual(['http://localhost:5173/']);
  });

  it('normalizes 0.0.0.0 URLs from terminal output to localhost', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [
          { text: 'server listening on http://0.0.0.0:5173/' },
          { text: 'request log http://0.0.0.0:5173/api/users' },
        ],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')).toEqual([
      'http://localhost:5173/',
      'http://localhost:5173/api/users',
    ]);
  });

  it('preserves 127.0.0.1 URLs from terminal output', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [
          { text: 'Local: http://localhost:65136/' },
          { text: 'Local: http://127.0.0.1:65136/' },
          { text: 'Cron: http://127.0.0.1:65136/cdn-cgi/handler/scheduled' },
        ],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')).toEqual([
      'http://127.0.0.1:65136/',
      'http://localhost:65136/',
      'http://127.0.0.1:65136/cdn-cgi/handler/scheduled',
    ]);
  });

  it('skips disposed terminals', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    const cached = makeCachedFromLines([{ text: 'http://localhost:5173/' }], 'ws-1') as {
      isDisposed: boolean;
    };
    cached.isDisposed = true;
    vi.mocked(getCached).mockReturnValue(cached as ReturnType<typeof getCached>);

    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')).toEqual([]);
  });

  it('returns empty array when no terminals match', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue([]);
    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')).toEqual([]);
  });

  it('returns rootless URLs before path-bearing ones so auto-pick lands on the dev-server root', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [
          // Older line: the boot banner with the root URL.
          { text: '  ➜  Local:   http://localhost:5173/' },
          // Newer lines: app request logs with deep paths. Recency alone would
          // surface these first, but rootless-first sorting must keep the
          // root URL at index 0.
          { text: 'GET http://localhost:5173/api/users' },
          { text: 'GET http://localhost:5173/dashboard' },
        ],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')[0]).toBe('http://localhost:5173/');
  });

  it('returns the newest URL first when the same line position has multiple URLs over time', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [
          // Older lines first; we walk from end backward, so :5174 should
          // appear before :5173 in the result.
          { text: 'Local: http://localhost:5173/' },
          { text: 'Local: http://localhost:5174/' },
        ],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')).toEqual([
      'http://localhost:5174/',
      'http://localhost:5173/',
    ]);
  });

  it('reconstructs localhost URLs wrapped across terminal rows', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [
          { text: '  ➜  Local:   http://localhost:5173/some/deep' },
          { text: '/path', isWrapped: true },
        ],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')).toEqual([
      'http://localhost:5173/some/deep/path',
    ]);
  });

  it('preserves separator spaces when reconstructing wrapped terminal rows', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [{ text: 'server http://localhost:5173/   ' }, { text: 'ready', isWrapped: true }],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')).toEqual(['http://localhost:5173/']);
  });

  it('keeps wrapped terminal rows separate when xterm does not mark them as wrapped', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [{ text: '  ➜  Local:   http://localhost:5173/some/deep' }, { text: '/path' }],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')).toEqual([
      'http://localhost:5173/some/deep',
    ]);
  });

  it('includes the start of a wrapped URL when the scan window begins on its continuation row', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [
          { text: '  ➜  Local:   http://localhost:5173/some/deep' },
          { text: '/path', isWrapped: true },
          ...Array.from({ length: 499 }, () => ({ text: 'noise' })),
        ],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    expect(scanWorkspaceTerminalsForLocalhostUrls('ws-1')).toEqual([
      'http://localhost:5173/some/deep/path',
    ]);
  });
});

describe('scanWorkspaceTerminalsForLocalhostUrlCandidates', () => {
  function run(overrides: Partial<SetupActivityRun>): SetupActivityRun {
    return {
      id: 'run-1',
      workspaceId: 'ws-1',
      setupRunId: 'setup-1',
      stepId: 'step-1',
      stepName: 'Dev server',
      retryable: true,
      state: 'running',
      startedAt: 0,
      output: '',
      ...overrides,
    };
  }

  it("adds the localhost URLs the workspace's running background runs printed", () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue([]);

    expect(
      scanWorkspaceTerminalsForLocalhostUrlCandidates('ws-1', {
        setupActivities: [
          run({
            actionId: 'dev',
            output:
              '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n',
          }),
          run({ id: 'run-2', stepId: 'install', output: 'Listening on http://127.0.0.1:4000\r\n' }),
          run({ id: 'run-3', state: 'succeeded', output: 'http://localhost:6006/\r\n' }),
        ],
      })
    ).toEqual([
      { url: 'http://localhost:5173/', executionLocation: 'workspace' },
      { url: 'http://127.0.0.1:4000/', executionLocation: 'workspace' },
    ]);
  });

  it('places each background run where it ran', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue([]);

    expect(
      scanWorkspaceTerminalsForLocalhostUrlCandidates('ws-1', {
        setupActivities: [
          run({
            actionId: 'dev',
            executionLocation: 'local-mirror',
            output: 'http://localhost:3000/\r\n',
          }),
          run({
            id: 'run-2',
            executionLocation: 'workspace',
            output: 'http://localhost:8080/\r\n',
          }),
        ],
      })
    ).toEqual([
      { url: 'http://localhost:3000/', executionLocation: 'local-mirror' },
      { url: 'http://localhost:8080/', executionLocation: 'workspace' },
    ]);
  });

  it("keeps a background run's URL when the terminals printed many", () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        Array.from({ length: 12 }, (_, index) => ({ text: `http://localhost:${4000 + index}/` })),
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    const urls = scanWorkspaceTerminalsForLocalhostUrlCandidates('ws-1', {
      setupActivities: [run({ actionId: 'dev', output: 'http://localhost:5173/\r\n' })],
    }).map(({ url }) => url);

    expect(urls).toHaveLength(10);
    expect(urls[0]).toBe('http://localhost:5173/');
  });
});

describe('scanWorkspaceTerminalsForLinks', () => {
  it('lists every URL, newest line first, each line left to right', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [
          { text: 'PR: https://github.com/acme/app/pull/12.' },
          { text: 'See https://docs.example.com/a and (https://example.com/b) here' },
          { text: "$ printf 'Docs: https://vitejs.dev/guide/\\n'" },
        ],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    expect(scanWorkspaceTerminalsForLinks('ws-1')).toEqual([
      { url: 'https://vitejs.dev/guide/' },
      { url: 'https://docs.example.com/a' },
      { url: 'https://example.com/b' },
      { url: 'https://github.com/acme/app/pull/12', continuation: 'See' },
    ]);
  });

  it('gives each URL the time its line was printed, when known', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue({
      ...(makeCachedFromLines(
        [{ text: 'old https://a.example/' }, { text: 'new https://b.example/ x' }],
        'ws-1'
      ) as object),
      printedAt: [1_000, undefined],
    } as ReturnType<typeof getCached>);

    expect(scanWorkspaceTerminalsForLinks('ws-1')).toEqual([
      { url: 'https://b.example/' },
      { url: 'https://a.example/', continuation: 'new', printedAt: 1_000 },
    ]);
  });

  it('gives the start of the next line for a URL that ends its line', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [{ text: '  https://claude.ai/artifact/abc-' }, { text: '  def-123 is ready' }],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    expect(scanWorkspaceTerminalsForLinks('ws-1')).toEqual([
      { url: 'https://claude.ai/artifact/abc-', continuation: 'def-123' },
    ]);
  });

  it('joins a URL the terminal soft-wrapped', () => {
    vi.mocked(getCachedTerminalIds).mockReturnValue(['t1']);
    vi.mocked(getCached).mockReturnValue(
      makeCachedFromLines(
        [{ text: 'https://example.com/very' }, { text: '/long/path', isWrapped: true }],
        'ws-1'
      ) as ReturnType<typeof getCached>
    );

    expect(scanWorkspaceTerminalsForLinks('ws-1')).toEqual([
      { url: 'https://example.com/very/long/path' },
    ]);
  });
});
