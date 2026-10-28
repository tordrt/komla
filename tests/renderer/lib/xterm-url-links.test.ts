import type { IBufferCell, IBufferLine, ILinkProvider } from '@xterm/xterm';
import { describe, expect, it, vi } from 'vitest';

import {
  computeWrappedFileLinks,
  computeWrappedUrlLinks,
  terminalHyperlinkTarget,
} from '../../../src/renderer/lib/xterm-url-links';

class MockLine implements Partial<IBufferLine> {
  readonly length: number;

  constructor(
    private readonly value: string,
    readonly isWrapped = false,
    length = value.length
  ) {
    this.length = length;
  }

  translateToString(trimRight?: boolean): string {
    return trimRight ? this.value.trimEnd() : this.value;
  }
}

function terminalFromLines(lines: MockLine[], cols?: number) {
  const providers: ILinkProvider[] = [];

  return {
    providers,
    terminal: {
      cols,
      buffer: {
        active: {
          getLine: (y: number) => lines[y] as IBufferLine | undefined,
        },
      },
      registerLinkProvider: (provider: ILinkProvider) => {
        providers.push(provider);
        return { dispose: vi.fn() };
      },
    },
  };
}

/** A buffer whose CJK characters take two cells, like xterm's. */
function terminalWithCells(rows: string[], cols: number) {
  type Cell = { chars: string; width: number };
  const blank: Cell = { chars: '', width: 1 };
  const lines = rows.map((row) => {
    const cells = Array.from(row).flatMap((chars): Cell[] =>
      /[\u3040-\u9fff]/.test(chars)
        ? [
            { chars, width: 2 },
            { chars: '', width: 0 },
          ]
        : [{ chars, width: 1 }]
    );
    return {
      isWrapped: false,
      length: cols,
      translateToString: () => row,
      getCell: (x: number, cell: Cell) => Object.assign(cell, cells[x] ?? blank),
    };
  });

  return {
    terminal: {
      cols,
      buffer: {
        active: {
          getLine: (y: number) => lines[y] as unknown as IBufferLine | undefined,
          getNullCell: () => {
            const cell = { ...blank, getChars: () => cell.chars, getWidth: () => cell.width };
            return cell as unknown as IBufferCell;
          },
        },
      },
      registerLinkProvider: () => ({ dispose: vi.fn() }),
    },
  };
}

describe('xterm URL links', () => {
  it('reconstructs URLs split by xterm soft wrapping', () => {
    const { terminal } = terminalFromLines([
      new MockLine('open https://example.com/deep/'),
      new MockLine('path?token=abc', true),
    ]);

    const links = computeWrappedUrlLinks(terminal, 1, vi.fn());

    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('https://example.com/deep/path?token=abc');
    expect(links[0].range).toEqual({
      start: { x: 6, y: 1 },
      end: { x: 14, y: 2 },
    });
  });

  it('finds the full soft-wrapped URL from the first row too', () => {
    const { terminal } = terminalFromLines([
      new MockLine('https://localhost:5173/some/'),
      new MockLine('route', true),
    ]);

    const links = computeWrappedUrlLinks(terminal, 0, vi.fn());

    expect(links.map((link) => link.text)).toEqual(['https://localhost:5173/some/route']);
  });

  it('bridges conservative hard-wrapped URL continuations', () => {
    const { terminal } = terminalFromLines([
      new MockLine('https://example.com/deep/path/'),
      new MockLine('?token=abc'),
    ]);

    const links = computeWrappedUrlLinks(terminal, 0, vi.fn());

    expect(links.map((link) => link.text)).toEqual(['https://example.com/deep/path/?token=abc']);
  });

  it('preserves hard-wrapped URL continuations across multiple rows', () => {
    const { terminal } = terminalFromLines([
      new MockLine('https://example.com/deep/path/'),
      new MockLine('?token=abc1234567890'),
      new MockLine('&redirect=https%3A%2F%2Flocalhost%3A5173%2Fcallback'),
    ]);

    const firstLineLinks = computeWrappedUrlLinks(terminal, 0, vi.fn());
    const lastLineLinks = computeWrappedUrlLinks(terminal, 2, vi.fn());

    const expected =
      'https://example.com/deep/path/?token=abc1234567890&redirect=https%3A%2F%2Flocalhost%3A5173%2Fcallback';
    expect(firstLineLinks.map((link) => link.text)).toEqual([expected]);
    expect(lastLineLinks.map((link) => link.text)).toEqual([expected]);
  });

  it('does not join ordinary following text onto a complete URL', () => {
    const { terminal } = terminalFromLines([
      new MockLine('see https://example.com   ', false, 80),
      new MockLine('next line'),
    ]);

    const firstLineLinks = computeWrappedUrlLinks(terminal, 0, vi.fn());
    const secondLineLinks = computeWrappedUrlLinks(terminal, 1, vi.fn());

    expect(firstLineLinks.map((link) => link.text)).toEqual(['https://example.com']);
    expect(secondLineLinks).toEqual([]);
  });

  it('does not join an edge-aligned origin URL to a following absolute path', () => {
    const { terminal } = terminalFromLines([
      new MockLine('https://example.com'),
      new MockLine('/Users/me/project'),
    ]);

    const firstLineLinks = computeWrappedUrlLinks(terminal, 0, vi.fn());
    const secondLineLinks = computeWrappedUrlLinks(terminal, 1, vi.fn());

    expect(firstLineLinks.map((link) => link.text)).toEqual(['https://example.com']);
    expect(secondLineLinks).toEqual([]);
  });

  it.each([50, 20])(
    'reconstructs an indented URL hard-wrapped in a padded %i-column TUI',
    (cols) => {
      // Claude Code's login screen: one column of padding on each side and
      // continuation rows that start with ordinary URL characters.
      const url =
        'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=KJYIbRq903LV9ycoqvic8z1j_rex2o6_syeCYFMLyhQ&code_challenge_method=S256&state=ny_Yz0vmM2Qw2Q2tpWVbcobK15vMH-BU0qyjTzSOBKY';
      const rows = url.match(new RegExp(`.{1,${cols - 2}}`, 'g')) ?? [];
      const { terminal } = terminalFromLines(
        [
          new MockLine(' Login to Anthropic', false, cols),
          new MockLine('', false, cols),
          ...rows.map((row) => new MockLine(` ${row}`, false, cols)),
          new MockLine(' Ctrl+click to open', false, cols),
        ],
        cols
      );
      const urlRows = rows.map((_, index) => index + 2);
      const lastRow = rows.length + 1;

      for (const lineIndex of urlRows) {
        const links = computeWrappedUrlLinks(terminal, lineIndex, vi.fn());
        expect(links.map((link) => link.text)).toEqual([url]);
        expect(links[0].range).toEqual({
          start: { x: 2, y: 3 },
          end: { x: rows[rows.length - 1].length + 1, y: lastRow + 1 },
        });
      }
      expect(computeWrappedUrlLinks(terminal, lastRow + 1, vi.fn())).toEqual([]);
    }
  );

  it('reconstructs a long URL that starts mid-line and wraps onto a hanging indent', () => {
    const cols = 40;
    const { terminal } = terminalFromLines(
      [
        new MockLine('⏺ Open https://example.com/a/very/long/', false, cols),
        new MockLine('  docs/page/that/does/not/fit/on/one/ro', false, cols),
        new MockLine('  w to continue.', false, cols),
      ],
      cols
    );

    const expected = 'https://example.com/a/very/long/docs/page/that/does/not/fit/on/one/row';
    for (const lineIndex of [0, 1, 2]) {
      const links = computeWrappedUrlLinks(terminal, lineIndex, vi.fn());
      expect(links.map((link) => link.text)).toEqual([expected]);
    }
  });

  it('does not join indented prose onto a URL that ends near the right edge', () => {
    const cols = 40;
    const { terminal } = terminalFromLines(
      [
        new MockLine('  see the docs at https://example.com/x', false, cols),
        new MockLine('  then run the installer', false, cols),
      ],
      cols
    );

    const firstLineLinks = computeWrappedUrlLinks(terminal, 0, vi.fn());
    const secondLineLinks = computeWrappedUrlLinks(terminal, 1, vi.fn());

    expect(firstLineLinks.map((link) => link.text)).toEqual(['https://example.com/x']);
    expect(secondLineLinks).toEqual([]);
  });

  it('does not join a label row onto a URL-only row that ends inside the right margin', () => {
    const cols = 30;
    const { terminal } = terminalFromLines(
      [
        new MockLine(' https://example.com/abcdefgh', false, cols),
        new MockLine(' Ctrl+click to open', false, cols),
      ],
      cols
    );

    const firstLineLinks = computeWrappedUrlLinks(terminal, 0, vi.fn());
    const secondLineLinks = computeWrappedUrlLinks(terminal, 1, vi.fn());

    expect(firstLineLinks.map((link) => link.text)).toEqual(['https://example.com/abcdefgh']);
    expect(secondLineLinks).toEqual([]);
  });

  it('does not join a following word onto a mid-line URL that ends at the right edge', () => {
    const { terminal } = terminalFromLines([
      new MockLine('See https://docs.example.com/guide/setup'),
      new MockLine('configuration for more info.'),
    ]);

    const links = computeWrappedUrlLinks(terminal, 0, vi.fn());

    expect(links.map((link) => link.text)).toEqual(['https://docs.example.com/guide/setup']);
  });

  it('does not join an origin URL split across rows to a following absolute path', () => {
    const { terminal } = terminalFromLines([
      new MockLine('see https://exam'),
      new MockLine('ple-very-long.io'),
      new MockLine('/Users/me/proj'),
    ]);

    const links = computeWrappedUrlLinks(terminal, 0, vi.fn());

    expect(links.map((link) => link.text)).toEqual(['https://example-very-long.io']);
  });

  it('keeps an unencoded nested URL that wraps right after a query separator', () => {
    const { terminal } = terminalFromLines([
      new MockLine('https://example.com/login?redirect='),
      new MockLine('https://app.example.com/cb'),
    ]);

    const links = computeWrappedUrlLinks(terminal, 1, vi.fn());

    expect(links.map((link) => link.text)).toEqual([
      'https://example.com/login?redirect=https://app.example.com/cb',
    ]);
  });

  it('does not return a truncated URL when the window limit cuts it off', () => {
    const url = `https://example.com/?q=${'a'.repeat(2100)}`;
    const rows = url.match(/.{1,40}/g) ?? [];
    const { terminal } = terminalFromLines(rows.map((row) => new MockLine(row)));

    const links = computeWrappedUrlLinks(terminal, 0, vi.fn());

    expect(links).toEqual([]);
  });

  it('reconstructs short URLs character-wrapped at the terminal edge without wrap flags', () => {
    // tmux redraws wrapped rows with explicit cursor moves, so xterm sees hard rows.
    const { terminal } = terminalFromLines([
      new MockLine('see the release notes, then open https://example.com/do'),
      new MockLine('cs/install?x=1'),
    ]);

    const links = computeWrappedUrlLinks(terminal, 1, vi.fn());

    expect(links.map((link) => link.text)).toEqual(['https://example.com/docs/install?x=1']);
  });

  it('reconstructs a URL character-wrapped right after its scheme', () => {
    const { terminal } = terminalFromLines([
      new MockLine('see https:'),
      new MockLine('//example.com/x'),
    ]);

    for (const lineIndex of [0, 1]) {
      const links = computeWrappedUrlLinks(terminal, lineIndex, vi.fn());
      expect(links.map((link) => link.text)).toEqual(['https://example.com/x']);
    }
  });

  it('links a hard-wrapped URL below a long soft-wrapped line', () => {
    const logRows = Array.from(
      { length: 62 },
      (_, index) => new MockLine('x'.repeat(40), index > 0)
    );
    const { terminal } = terminalFromLines([
      ...logRows,
      new MockLine('see.md https://example.com/aaaaaaaa'),
      new MockLine('/rest?x=1'),
    ]);

    const links = computeWrappedUrlLinks(terminal, logRows.length, vi.fn());

    expect(links.map((link) => link.text)).toEqual(['https://example.com/aaaaaaaa/rest?x=1']);
  });

  it('measures wide characters to their last cell when checking the right edge', () => {
    // tmux character wrap after a row that ends with a two-cell character.
    const first = 'open https://ja.wikipedia.org/wiki/東京';
    const { terminal } = terminalWithCells([first, '?action=edit and save'], 39);

    const links = computeWrappedUrlLinks(terminal, 0, vi.fn());

    expect(links.map((link) => link.text)).toEqual([
      'https://ja.wikipedia.org/wiki/東京?action=edit',
    ]);
  });

  it('does not join edge-aligned prose onto a URL without wrap flags', () => {
    const { terminal } = terminalFromLines([
      new MockLine('for the setup steps see https://example.com/docs'),
      new MockLine('e.g. run it'),
    ]);

    const links = computeWrappedUrlLinks(terminal, 0, vi.fn());

    expect(links.map((link) => link.text)).toEqual(['https://example.com/docs']);
  });

  it('does not join a URL on the next row onto an edge-aligned URL', () => {
    const cols = 30;
    const { terminal } = terminalFromLines(
      [
        new MockLine(' https://example.com/abcdefghi', false, cols),
        new MockLine(' https://example.org/other/path/that/is/long', false, cols),
      ],
      cols
    );

    const links = computeWrappedUrlLinks(terminal, 0, vi.fn());

    expect(links.map((link) => link.text)).toEqual(['https://example.com/abcdefghi']);
  });

  it('strips trailing punctuation from detected URLs', () => {
    const { terminal } = terminalFromLines([new MockLine('visit https://example.com/path).')]);

    const links = computeWrappedUrlLinks(terminal, 0, vi.fn());

    expect(links.map((link) => link.text)).toEqual(['https://example.com/path']);
  });

  it('reports the hovered URL for context menu actions', () => {
    const { terminal } = terminalFromLines([new MockLine('https://example.com/path')]);
    const onHover = vi.fn();
    const event = {} as MouseEvent;
    const [link] = computeWrappedUrlLinks(terminal, 0, vi.fn(), onHover);

    link.hover?.(event, link.text);
    link.leave?.(event, link.text);

    expect(onHover).toHaveBeenNthCalledWith(1, {
      type: 'url',
      url: 'https://example.com/path',
    });
    expect(onHover).toHaveBeenNthCalledWith(2, null);
  });
});

describe('xterm file links', () => {
  it('detects workspace-relative file references without a line number', () => {
    const { terminal } = terminalFromLines([
      new MockLine(
        '  - Added Commit... to the git dropdown in src/renderer/components/layout/UnifiedMenu.tsx.'
      ),
    ]);

    const links = computeWrappedFileLinks(terminal, 0, vi.fn());

    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('src/renderer/components/layout/UnifiedMenu.tsx');
    expect(links[0].range).toEqual({
      start: { x: 44, y: 1 },
      end: { x: 89, y: 1 },
    });
  });

  it('detects workspace-relative file references with a line number', () => {
    const { terminal } = terminalFromLines([
      new MockLine('opened src/renderer/components/terminal/TerminalView.tsx:491.'),
    ]);

    const links = computeWrappedFileLinks(terminal, 0, vi.fn());

    expect(links).toHaveLength(1);
    expect(links[0].text).toBe('src/renderer/components/terminal/TerminalView.tsx:491');
    expect(links[0].range).toEqual({
      start: { x: 8, y: 1 },
      end: { x: 60, y: 1 },
    });
  });

  it('passes path, line, and column to the activation handler', () => {
    const { terminal } = terminalFromLines([new MockLine('at ./src/main.ts:12:5')]);
    const handler = vi.fn();
    const event = {} as MouseEvent;

    const [link] = computeWrappedFileLinks(terminal, 0, handler);
    link.activate(event, link.text);

    expect(handler).toHaveBeenCalledWith(event, './src/main.ts', 12, 5);
  });

  it('passes undefined line and column for file references without a location suffix', () => {
    const { terminal } = terminalFromLines([new MockLine('changed src/main.ts')]);
    const handler = vi.fn();
    const event = {} as MouseEvent;

    const [link] = computeWrappedFileLinks(terminal, 0, handler);
    link.activate(event, link.text);

    expect(handler).toHaveBeenCalledWith(event, 'src/main.ts', undefined, undefined);
  });

  it('reports the hovered file location for context menu actions', () => {
    const { terminal } = terminalFromLines([new MockLine('at ./src/main.ts:12:5')]);
    const onHover = vi.fn();
    const event = {} as MouseEvent;
    const [link] = computeWrappedFileLinks(terminal, 0, vi.fn(), onHover);

    link.hover?.(event, link.text);
    link.leave?.(event, link.text);

    expect(onHover).toHaveBeenNthCalledWith(1, {
      type: 'file',
      filePath: './src/main.ts',
      lineNumber: 12,
      columnNumber: 5,
    });
    expect(onHover).toHaveBeenNthCalledWith(2, null);
  });

  it('does not link bare filenames without a line number', () => {
    const { terminal } = terminalFromLines([new MockLine('updated package.json and README.md')]);

    const links = computeWrappedFileLinks(terminal, 0, vi.fn());

    expect(links).toEqual([]);
  });

  it('still links bare filenames with a line number', () => {
    const { terminal } = terminalFromLines([new MockLine('at package.json:12')]);

    const links = computeWrappedFileLinks(terminal, 0, vi.fn());

    expect(links.map((link) => link.text)).toEqual(['package.json:12']);
  });

  it('detects absolute paths without a line number', () => {
    const { terminal } = terminalFromLines([new MockLine('/Users/me/project/src/main.ts')]);

    const links = computeWrappedFileLinks(terminal, 0, vi.fn());

    expect(links.map((link) => link.text)).toEqual(['/Users/me/project/src/main.ts']);
  });

  it('detects absolute paths', () => {
    const { terminal } = terminalFromLines([new MockLine('/Users/me/project/src/main.ts:12:5')]);

    const links = computeWrappedFileLinks(terminal, 0, vi.fn());

    expect(links.map((link) => link.text)).toEqual(['/Users/me/project/src/main.ts:12:5']);
  });

  it('detects Windows paths', () => {
    const { terminal } = terminalFromLines([new MockLine('C:\\repo\\src\\main.ts:12:5')]);

    const links = computeWrappedFileLinks(terminal, 0, vi.fn());

    expect(links.map((link) => link.text)).toEqual(['C:\\repo\\src\\main.ts:12:5']);
  });

  it('does not glue edge-aligned rows into one file path', () => {
    const cols = 30;
    const { terminal } = terminalFromLines(
      [
        new MockLine('./src/renderer/lib/foo-bar.ts', false, cols),
        new MockLine('./src/c.ts', false, cols),
        new MockLine('-'.repeat(cols), false, cols),
        new MockLine('src/foo.ts:12', false, cols),
      ],
      cols
    );

    expect(computeWrappedFileLinks(terminal, 1, vi.fn()).map((link) => link.text)).toEqual([
      './src/c.ts',
    ]);
    expect(computeWrappedFileLinks(terminal, 3, vi.fn()).map((link) => link.text)).toEqual([
      'src/foo.ts:12',
    ]);
  });

  it('reconstructs a long file path that starts mid-line and wraps onto a hanging indent', () => {
    // Claude Code splits a path wider than the pane and keeps writing on the last row.
    const cols = 40;
    const { terminal } = terminalFromLines(
      [
        new MockLine('⏺ Fixed in /Users/me/project/src/render', false, cols),
        new MockLine('  er/lib/links.ts:12 with a guard.', false, cols),
      ],
      cols
    );

    for (const lineIndex of [0, 1]) {
      const links = computeWrappedFileLinks(terminal, lineIndex, vi.fn());
      expect(links.map((link) => link.text)).toEqual([
        '/Users/me/project/src/renderer/lib/links.ts:12',
      ]);
      expect(links[0].range).toEqual({ start: { x: 12, y: 1 }, end: { x: 20, y: 2 } });
    }
  });

  it.each([30, 26])('reconstructs a file path hard-wrapped in a padded %i-column TUI', (cols) => {
    const filePath =
      '/home/me/projects/komla/src/renderer/components/terminal/TerminalView.tsx:724';
    const rows = filePath.match(new RegExp(`.{1,${cols - 2}}`, 'g')) ?? [];
    const { terminal } = terminalFromLines(
      [
        ...rows.map((row) => new MockLine(` ${row}`, false, cols)),
        new MockLine(' Press enter to open it', false, cols),
      ],
      cols
    );

    rows.forEach((_, lineIndex) => {
      const links = computeWrappedFileLinks(terminal, lineIndex, vi.fn());
      expect(links.map((link) => link.text)).toEqual([filePath]);
    });
    expect(computeWrappedFileLinks(terminal, rows.length, vi.fn())).toEqual([]);
  });

  it.each([
    [
      'at run (/home/me/project/node_modules/pkg/di',
      'st/index.js:12:5)',
      '/home/me/project/node_modules/pkg/dist/index.js:12:5',
    ],
    [
      '  File "/home/me/project/app/services/',
      'billing.py", line 12, in charge',
      '/home/me/project/app/services/billing.py',
    ],
    [
      'error in C:\\repo\\src\\renderer\\Termi',
      'nalView.tsx:12:5',
      'C:\\repo\\src\\renderer\\TerminalView.tsx:12:5',
    ],
    ['  at /home/me/proj/src/index.js:1', '2:5)', '/home/me/proj/src/index.js:12:5'],
    ['see /home/me/proj/TerminalView.tsx:', '12:5', '/home/me/proj/TerminalView.tsx:12:5'],
    [
      'error in /home/me/project/src/TerminalView.t',
      'sx:12:5 failed',
      '/home/me/project/src/TerminalView.tsx:12:5',
    ],
    ['see /home/me/project/src/foo.te', 'st.ts:4', '/home/me/project/src/foo.test.ts:4'],
  ])(
    'reconstructs file paths character-wrapped without wrap flags: %s',
    (first, second, expected) => {
      // tmux redraws wrapped rows with explicit cursor moves, so xterm sees hard rows.
      const { terminal } = terminalFromLines([new MockLine(first), new MockLine(second)]);

      for (const lineIndex of [0, 1]) {
        const links = computeWrappedFileLinks(terminal, lineIndex, vi.fn());
        expect(links.map((link) => link.text)).toEqual([expected]);
      }
    }
  );

  it.each([
    [['src/renderer/lib/foo-bar.tsx', 'src/main/index.ts'], 30],
    [['/home/me/project/a.ts', '/home/me/project/b.ts'], undefined],
    [['/home/me/project/a.ts:12', 'src/b.ts:3'], undefined],
    [['./src/renderer/lib/foo-bar', './src/c.ts'], undefined],
    [['/home/me/project/src/renderer/', '/home/me/other/b.ts'], undefined],
    [['/home/me/project/a.md', 'foo.md:3'], undefined],
  ])('does not join a following file path onto %j', (paths, cols) => {
    const { terminal } = terminalFromLines(
      paths.map((path) => new MockLine(path, false, cols)),
      cols
    );

    paths.forEach((path, lineIndex) => {
      const alone = terminalFromLines([new MockLine(path)]).terminal;
      const expected = computeWrappedFileLinks(alone, 0, vi.fn()).map((link) => link.text);
      const links = computeWrappedFileLinks(terminal, lineIndex, vi.fn());
      expect(links.map((link) => link.text)).toEqual(expected);
    });
  });

  it('does not join a prose abbreviation onto a directory path at the right edge', () => {
    const cols = 41;
    const { terminal } = terminalFromLines(
      [
        new MockLine('  edit the files under src/renderer/lib/', false, cols),
        new MockLine('  e.g. the link helpers', false, cols),
      ],
      cols
    );

    expect(computeWrappedFileLinks(terminal, 0, vi.fn()).map((link) => link.text)).toEqual([
      'src/renderer/lib/',
    ]);
    expect(computeWrappedFileLinks(terminal, 1, vi.fn())).toEqual([]);
  });

  it('does not return a partial file path when the window limit cuts it off', () => {
    const filePath = `/${'b'.repeat(2200)}/c.ts:12`;
    const rows = filePath.match(/.{1,40}/g) ?? [];
    const { terminal } = terminalFromLines(rows.map((row, index) => new MockLine(row, index > 0)));

    expect(computeWrappedFileLinks(terminal, rows.length - 1, vi.fn())).toEqual([]);
  });

  it('links folder paths that end in a separator', () => {
    const folder =
      '/tmp/claude-1001/-home-agent--komla-worktrees-komla-orca-mobile-komla/0fc83f15-6a45-4de6-8de8-9db87174a59f/scratchpad/shots/';
    const { terminal } = terminalFromLines([
      new MockLine(`Screenshots are in ${folder} (before/, after/, launch/).`),
    ]);
    const handler = vi.fn();
    const event = {} as MouseEvent;

    const links = computeWrappedFileLinks(terminal, 0, handler);
    links[0]?.activate(event, links[0].text);

    // A lone name such as before/ could be any word followed by a slash.
    expect(links.map((link) => link.text)).toEqual([folder]);
    expect(handler).toHaveBeenCalledWith(event, folder);
  });

  it('links a folder path once, not the dotted name inside it', () => {
    const { terminal } = terminalFromLines([
      new MockLine('see ./out/site.d/assets/, src/components/ and ~/shots/.'),
    ]);

    expect(computeWrappedFileLinks(terminal, 0, vi.fn()).map((link) => link.text)).toEqual([
      './out/site.d/assets/',
      'src/components/',
      '~/shots/',
    ]);
  });

  it('links a file inside a hidden folder as the file, not the folder before it', () => {
    const { terminal } = terminalFromLines([
      new MockLine('wrote /Users/me/.claude/plans/foo.md and /repo/.github/workflows/ci.yml'),
    ]);

    expect(computeWrappedFileLinks(terminal, 0, vi.fn()).map((link) => link.text)).toEqual([
      '/Users/me/.claude/plans/foo.md',
      '/repo/.github/workflows/ci.yml',
    ]);
  });

  it('links a hidden folder path, and a folder path ending a sentence', () => {
    const { terminal } = terminalFromLines([new MockLine('see ~/.claude/plans/. Then /tmp/a/.')]);

    expect(computeWrappedFileLinks(terminal, 0, vi.fn()).map((link) => link.text)).toEqual([
      '~/.claude/plans/',
      '/tmp/a/',
    ]);
  });

  it('does not take a web address without its scheme for a folder', () => {
    const { terminal } = terminalFromLines([new MockLine('see github.com/user/repo/ for more')]);

    expect(computeWrappedFileLinks(terminal, 0, vi.fn())).toEqual([]);
  });

  it('does not link a root or parent folder', () => {
    const { terminal } = terminalFromLines([new MockLine('in / and ../ and ../out/ and a/../b/')]);

    expect(computeWrappedFileLinks(terminal, 0, vi.fn())).toEqual([]);
  });

  it('does not create file links inside URLs', () => {
    const { terminal } = terminalFromLines([new MockLine('http://localhost:5173/src/main.ts:12')]);

    const links = computeWrappedFileLinks(terminal, 0, vi.fn());

    expect(links).toEqual([]);
  });
});

describe('terminalHyperlinkTarget', () => {
  it('reads the full path from a file hyperlink', () => {
    // Claude Code marks each row of a wrapped attachment path with the whole path.
    const filePath =
      '/tmp/claude-1001/-home-agent--komla-worktrees-komla-ui/146e4e26-66c9-4524-ab4f-567afb414e02/scratchpad/shots/variants-grid.png';

    expect(terminalHyperlinkTarget(`file://${filePath}`)).toEqual({ type: 'file', filePath });
  });

  it.each([
    ['file:///Users/me/My%20Shots/a%23b.png', '/Users/me/My Shots/a#b.png'],
    ['file://my-laptop/home/me/a.png', '/home/me/a.png'],
    ['file://localhost/home/me/a.png', '/home/me/a.png'],
    ['file:///C:/Users/me/a.png', 'C:/Users/me/a.png'],
    ['file:///tmp/shots/', '/tmp/shots/'],
  ])('maps %s to %s', (uri, filePath) => {
    expect(terminalHyperlinkTarget(uri)).toEqual({ type: 'file', filePath });
  });

  it('keeps web hyperlinks as URLs', () => {
    expect(terminalHyperlinkTarget('https://example.com/a?b=1')).toEqual({
      type: 'url',
      url: 'https://example.com/a?b=1',
    });
    expect(terminalHyperlinkTarget('http://localhost:5173/')).toEqual({
      type: 'url',
      url: 'http://localhost:5173/',
    });
  });

  it.each([
    'javascript:alert(1)',
    'vscode://file/home/me/a.ts',
    'ssh://host/home/me',
    'mailto:me@example.com',
    'file:///',
    'file:///tmp/%E0%A4%A',
    'file:///tmp/a%00.png',
    'not a url',
    '',
  ])('ignores %s', (uri) => {
    expect(terminalHyperlinkTarget(uri)).toBeNull();
  });
});
