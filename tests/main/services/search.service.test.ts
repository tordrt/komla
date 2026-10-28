import { vi, describe, it, expect, beforeEach } from 'vitest';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { importFresh } from '../../setup';
import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
}));

// Mock ripgrep path
vi.mock('@vscode/ripgrep', () => ({
  rgPath: '/mock/bin/rg',
}));

describe('SearchService', () => {
  let searchService: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(execFile).mockImplementation((_path, _args, _opts, callback) => {
      callback(null, { stdout: '', stderr: '' });
      return {} as any;
    });
    const mod = await importFresh<any>('../../../src/main/services/search.service');
    searchService = mod.searchService;
  });

  it('should return empty results for empty query', async () => {
    const results = await searchService.searchContent('/mock/dir', '  ');
    expect(results).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('should initialize and check for ripgrep binary', async () => {
    await searchService.searchContent('/mock/dir', 'query');
    expect(existsSync).toHaveBeenCalledWith('/mock/bin/rg');
    expect(mockLogger.info).toHaveBeenCalledWith(
      'SearchService initialized',
      expect.objectContaining({
        rgPath: '/mock/bin/rg',
        exists: true,
      })
    );
  });

  it('should log error if ripgrep binary is missing', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    // Need to reset initialized flag to trigger check again
    searchService['initialized'] = false;

    await searchService.searchContent('/mock/dir', 'query');
    expect(mockLogger.error).toHaveBeenCalledWith('Ripgrep binary not found at expected path');
  });

  it('should search with default options', async () => {
    const mockOutput = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'file.ts' },
        lines: { text: 'const x = 1\n' },
        line_number: 10,
        submatches: [{ match: { text: 'x' }, start: 6, end: 7 }],
      },
    });

    vi.mocked(execFile).mockImplementation((_path, args, _opts, callback) => {
      expect(args).toContain('query');
      expect(args).toContain('-i'); // Case insensitive by default
      expect(args).toContain('--multiline'); // Multiline by default for whitespace tolerance
      expect(args).not.toContain('-F'); // No longer fixed-string mode
      callback(null, { stdout: mockOutput, stderr: '' });
      return {} as any;
    });

    const results = await searchService.searchContent('/mock/dir', 'query');

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      path: 'file.ts',
      lineNumber: 10,
      lineContent: 'const x = 1',
      matches: [{ start: 6, end: 7 }],
    });
  });

  it('should normalize ripgrep dot-prefixed relative paths', async () => {
    const mockOutput = JSON.stringify({
      type: 'match',
      data: {
        path: { text: './src/file.ts' },
        lines: { text: 'const x = 1\n' },
        line_number: 10,
        submatches: [{ match: { text: 'x' }, start: 6, end: 7 }],
      },
    });

    vi.mocked(execFile).mockImplementation((_path, _args, _opts, callback) => {
      callback(null, { stdout: mockOutput, stderr: '' });
      return {} as any;
    });

    const results = await searchService.searchContent('/mock/dir', 'query');

    expect(results[0].path).toBe('src/file.ts');
  });

  it('should support case sensitive search', async () => {
    vi.mocked(execFile).mockImplementation((_path, args, _opts, callback) => {
      expect(args).not.toContain('-i');
      callback(null, { stdout: '', stderr: '' });
      return {} as any;
    });

    await searchService.searchContent('/mock/dir', 'query', { caseSensitive: true });
  });

  it('should support regex search', async () => {
    vi.mocked(execFile).mockImplementation((_path, args, _opts, callback) => {
      expect(args).not.toContain('-F');
      // In explicit regex mode, the user's pattern is passed through
      // unchanged and multiline is not forced on.
      expect(args).not.toContain('--multiline');
      expect(args).toContain('query');
      callback(null, { stdout: '', stderr: '' });
      return {} as any;
    });

    await searchService.searchContent('/mock/dir', 'query', { regex: true });
  });

  it('should translate whitespace runs into \\s+ for literal queries', async () => {
    vi.mocked(execFile).mockImplementation((_path, args, _opts, callback) => {
      expect(args).toContain('foo\\s+bar\\s+baz');
      expect(args).toContain('--multiline');
      callback(null, { stdout: '', stderr: '' });
      return {} as any;
    });

    await searchService.searchContent('/mock/dir', 'foo bar baz');
  });

  it('should regex-escape special characters in literal queries', async () => {
    vi.mocked(execFile).mockImplementation((_path, args, _opts, callback) => {
      // Parens, dots, and braces from the literal query must be escaped so
      // they aren't interpreted as regex metacharacters.
      expect(args).toContain('foo\\(\\)\\s+\\{a\\.b\\}');
      callback(null, { stdout: '', stderr: '' });
      return {} as any;
    });

    await searchService.searchContent('/mock/dir', 'foo() {a.b}');
  });

  it('should flatten multi-line matched spans into a single preview line', async () => {
    // 'foo,\n  bar' = 10 chars: f,o,o,",",\n," "," ",b,a,r
    const mockOutput = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'file.ts' },
        lines: { text: 'foo,\n  bar\n' },
        line_number: 5,
        submatches: [{ match: { text: 'foo,\n  bar' }, start: 0, end: 10 }],
      },
    });

    vi.mocked(execFile).mockImplementation((_path, _args, _opts, callback) => {
      callback(null, { stdout: mockOutput, stderr: '' });
      return {} as any;
    });

    const results = await searchService.searchContent('/mock/dir', 'foo, bar');
    expect(results).toHaveLength(1);
    expect(results[0].lineContent).toBe('foo,   bar');
    expect(results[0].lineContent).not.toContain('\n');
    // Submatch offsets must remain valid against the flattened content.
    const { start, end } = results[0].matches[0];
    expect(results[0].lineContent.slice(start, end)).toBe('foo,   bar');
  });

  it('should flatten CRLF line endings without leaving stray \\r in the preview', async () => {
    // 'foo,\r\n  bar' = 11 chars: f,o,o,",",\r,\n," "," ",b,a,r
    const mockOutput = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'file.ts' },
        lines: { text: 'foo,\r\n  bar\r\n' },
        line_number: 5,
        submatches: [{ match: { text: 'foo,\r\n  bar' }, start: 0, end: 11 }],
      },
    });

    vi.mocked(execFile).mockImplementation((_path, _args, _opts, callback) => {
      callback(null, { stdout: mockOutput, stderr: '' });
      return {} as any;
    });

    const results = await searchService.searchContent('/mock/dir', 'foo, bar');
    expect(results).toHaveLength(1);
    expect(results[0].lineContent).not.toContain('\r');
    expect(results[0].lineContent).not.toContain('\n');
    expect(results[0].lineContent).toBe('foo,    bar');
    // Submatch offsets must remain valid against the flattened content
    // even after \r\n -> two spaces.
    const { start, end } = results[0].matches[0];
    expect(results[0].lineContent.slice(start, end)).toBe('foo,    bar');
  });

  it('should handle ripgrep exit code 1 (no matches) with output', async () => {
    const mockOutput = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'found.ts' },
        lines: { text: 'match\n' },
        line_number: 1,
        submatches: [{ match: { text: 'match' }, start: 0, end: 5 }],
      },
    });

    vi.mocked(execFile).mockImplementation((_path, _args, _opts, callback) => {
      const err = new Error('Command failed') as any;
      err.code = 1;
      err.stdout = mockOutput;
      callback(err, { stdout: mockOutput, stderr: '' });
      return {} as any;
    });

    const results = await searchService.searchContent('/mock/dir', 'query');
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('found.ts');
  });

  it('should handle ripgrep exit code 1 (no matches) without output', async () => {
    vi.mocked(execFile).mockImplementation((_path, _args, _opts, callback) => {
      const err = new Error('Command failed') as any;
      err.code = 1;
      err.stdout = '';
      callback(err, { stdout: '', stderr: '' });
      return {} as any;
    });

    const results = await searchService.searchContent('/mock/dir', 'query');
    expect(results).toEqual([]);
    expect(mockLogger.debug).toHaveBeenCalledWith('No matches found');
  });

  it('should handle ripgrep errors', async () => {
    vi.mocked(execFile).mockImplementation((_path, _args, _opts, callback) => {
      const err = new Error('Fatal error') as any;
      err.code = 2;
      err.stderr = 'ripgrep crashed';
      callback(err, { stdout: '', stderr: 'ripgrep crashed' });
      return {} as any;
    });

    const results = await searchService.searchContent('/mock/dir', 'query');
    expect(results).toEqual([]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Ripgrep search failed',
      expect.objectContaining({
        code: 2,
        stderr: 'ripgrep crashed',
      })
    );
  });

  it('should ignore malformed JSON lines', async () => {
    const mockOutput =
      'invalid json\n' +
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'file.ts' },
          lines: { text: 'match\n' },
          line_number: 1,
          submatches: [],
        },
      });

    vi.mocked(execFile).mockImplementation((_path, _args, _opts, callback) => {
      callback(null, { stdout: mockOutput, stderr: '' });
      return {} as any;
    });

    const results = await searchService.searchContent('/mock/dir', 'query');
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('file.ts');
  });

  it('should respect maxResults', async () => {
    vi.mocked(execFile).mockImplementation((_path, args, _opts, callback) => {
      expect(args).toContain('5'); // --max-count 5

      const lines = [];
      for (let i = 0; i < 10; i++) {
        lines.push(
          JSON.stringify({
            type: 'match',
            data: {
              path: { text: `file${i}.ts` },
              lines: { text: 'match\n' },
              line_number: 1,
              submatches: [],
            },
          })
        );
      }
      callback(null, { stdout: lines.join('\n'), stderr: '' });
      return {} as any;
    });

    const results = await searchService.searchContent('/mock/dir', 'query', { maxResults: 5 });
    expect(results).toHaveLength(5);
  });

  it('converts ripgrep file sizes to bytes for the Remote Companion', async () => {
    const { fileSizeInBytes } = await importFresh<any>('../../../src/main/services/search.service');
    expect(fileSizeInBytes('512')).toBe(512);
    expect(fileSizeInBytes('2K')).toBe(2048);
    expect(fileSizeInBytes('1m')).toBe(1024 * 1024);
    expect(fileSizeInBytes('1G')).toBe(1024 ** 3);
    expect(fileSizeInBytes('99999999999999999999G')).toBe(Number.MAX_SAFE_INTEGER);
    expect(String(fileSizeInBytes('99999999999999999999G'))).toBe('9007199254740991');
    expect(() => fileSizeInBytes('1.5M')).toThrow('Invalid file size: 1.5M');
    expect(() => fileSizeInBytes('-1')).toThrow('Invalid file size: -1');
  });
});
