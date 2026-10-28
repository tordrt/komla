import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { promisify } from 'util';

import { rgPath } from '@vscode/ripgrep';
import { app } from 'electron';

import { createLogger } from '../lib/logger';

const execFileAsync = promisify(execFile);
const logger = createLogger('SearchService');

/**
 * In packaged builds, __dirname inside @vscode/ripgrep resolves to the asar
 * archive path. child_process.execFile needs the real file on disk, which
 * electron-builder places in app.asar.unpacked/.
 */
function resolveRgPath(): string {
  if (app.isPackaged) {
    return rgPath.replace('app.asar', 'app.asar.unpacked');
  }
  return rgPath;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a literal user query into a ripgrep regex that tolerates the way
 * code is wrapped across lines. Whitespace runs in the query become `\s+`
 * so "foo bar baz" matches whether it's on one line or split across many.
 * Used together with --multiline so `\s+` can span newlines.
 */
function buildWhitespaceTolerantPattern(query: string): string {
  return query
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map(escapeRegex)
    .join('\\s+');
}

function normalizeRipgrepPath(path: string): string {
  return path.replace(/^\.[/\\]+/, '');
}

export interface ContentSearchMatch {
  start: number;
  end: number;
}

export interface ContentSearchResult {
  path: string;
  lineNumber: number;
  lineContent: string;
  matches: ContentSearchMatch[];
}

export interface ContentSearchOptions {
  caseSensitive?: boolean;
  regex?: boolean;
  maxResults?: number;
  maxFileSize?: string; // e.g., '1M'
}

interface RipgrepMatch {
  type: 'match';
  data: {
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches: Array<{
      match: { text: string };
      start: number;
      end: number;
    }>;
  };
}

type RipgrepMessage = RipgrepMatch | { type: string };

/** A content search as ripgrep and the Remote Companion's `__search` both run it. */
export interface ContentSearch {
  pattern: string;
  multiline: boolean;
  ignoreCase: boolean;
  maxResults: number;
  maxFileSize: string;
}

export function buildContentSearch(query: string, options?: ContentSearchOptions): ContentSearch {
  // For literal queries, build a whitespace-tolerant regex and enable
  // multiline so wrapped code (function args split across lines, JSX
  // attributes, etc.) still matches. For explicit regex mode, pass the
  // user's pattern through unchanged.
  const regex = options?.regex === true;
  return {
    pattern: regex ? query : buildWhitespaceTolerantPattern(query),
    multiline: !regex,
    ignoreCase: !options?.caseSensitive,
    maxResults: options?.maxResults ?? 100,
    maxFileSize: options?.maxFileSize ?? '1M',
  };
}

/** A ripgrep size such as `1M` in bytes, for the Remote Companion. */
export function fileSizeInBytes(size: string): number {
  const match = /^(\d+)([KMG]?)$/i.exec(size.trim());
  if (!match) throw new Error(`Invalid file size: ${size}`);
  const unit = match[2] ? 'KMG'.indexOf(match[2].toUpperCase()) + 1 : 0;
  // Larger sizes would print in exponent notation, which the companion can't parse.
  return Math.min(Number(match[1]) * 1024 ** unit, Number.MAX_SAFE_INTEGER);
}

/**
 * Parse ripgrep `--json` output, which the Remote Companion's `__search` also prints
 * for SSH workspaces.
 */
export function parseRipgrepOutput(stdout: string, maxResults: number): ContentSearchResult[] {
  const results: ContentSearchResult[] = [];
  const lines = stdout.split('\n').filter((line) => line.trim());

  for (const line of lines) {
    if (results.length >= maxResults) break;

    try {
      const msg = JSON.parse(line) as RipgrepMessage;
      if (msg.type === 'match') {
        const match = msg as RipgrepMatch;
        // Multiline matches span newlines; flatten to a single line for
        // the preview row. Each \r and \n becomes a space (1:1 char swap)
        // so submatch offsets stay valid on both LF and CRLF files.
        const flattened = match.data.lines.text.replace(/\r?\n$/, '').replace(/[\r\n]/g, ' ');
        results.push({
          path: normalizeRipgrepPath(match.data.path.text),
          lineNumber: match.data.line_number,
          lineContent: flattened,
          matches: match.data.submatches.map((sub) => ({
            start: sub.start,
            end: sub.end,
          })),
        });
      }
    } catch {
      // Ignore malformed JSON lines
    }
  }

  logger.debug('Parsed ripgrep results', { count: results.length });
  return results;
}

class SearchService {
  private rgBinaryPath: string;
  private initialized: boolean = false;

  constructor() {
    this.rgBinaryPath = resolveRgPath();
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;

    const exists = existsSync(this.rgBinaryPath);
    logger.info('SearchService initialized', {
      rgPath: this.rgBinaryPath,
      exists,
    });

    if (!exists) {
      logger.error('Ripgrep binary not found at expected path');
    }
  }

  /**
   * Search for content in files using ripgrep
   */
  async searchContent(
    dirPath: string,
    query: string,
    options?: ContentSearchOptions
  ): Promise<ContentSearchResult[]> {
    this.ensureInitialized();

    if (!query.trim()) {
      return [];
    }

    const { pattern, multiline, ignoreCase, maxResults, maxFileSize } = buildContentSearch(
      query,
      options
    );

    const args = [
      '--json',
      '--max-filesize',
      maxFileSize,
      '--max-count',
      String(maxResults), // Limit results at ripgrep level
      '--no-heading',
      '--hidden',
      '--glob',
      '!.git',
    ];

    if (ignoreCase) {
      args.push('-i');
    }
    if (multiline) {
      args.push('--multiline');
    }

    args.push('--', pattern, '.');

    logger.debug('Running ripgrep', { rgPath: this.rgBinaryPath, args, cwd: dirPath });

    try {
      const { stdout } = await execFileAsync(this.rgBinaryPath, args, {
        cwd: dirPath,
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        env: { ...process.env },
      });

      return parseRipgrepOutput(stdout, maxResults);
    } catch (error: unknown) {
      // execFile throws on non-zero exit codes
      // ripgrep exits with 1 when no matches found (not an error)
      const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };

      if (err.code === 1 && err.stdout) {
        // Exit code 1 with output means no matches - parse any partial results
        return parseRipgrepOutput(err.stdout, maxResults);
      }

      if (err.code === 1 && !err.stdout) {
        // Exit code 1 with no output means no matches found
        logger.debug('No matches found');
        return [];
      }

      // Actual error
      logger.error('Ripgrep search failed', {
        code: err.code,
        stderr: err.stderr,
        message: err.message,
      });
      return [];
    }
  }
}

export const searchService = new SearchService();
