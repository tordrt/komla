import { gitExec } from './git-exec';

export interface BlameHunk {
  commitHash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  timestamp: number;
  summary: string;
  startLine: number; // 1-based
  lineCount: number;
}

interface CommitMeta {
  author: string;
  authorEmail: string;
  timestamp: number;
  summary: string;
}

const HEADER_RE = /^([0-9a-f]{40}) \d+ (\d+)(?: (\d+))?$/;

class GitBlameService {
  async getBlame(
    worktreePath: string,
    filePath: string,
    commitHash?: string
  ): Promise<BlameHunk[]> {
    const args = ['blame', '--porcelain'];
    if (commitHash) args.push(commitHash);
    args.push('--', filePath);

    let output: string;
    try {
      output = await gitExec.execGitAsync(worktreePath, args);
    } catch {
      return [];
    }

    if (!output.trim()) return [];

    return this.parsePorcelain(output);
  }

  private parsePorcelain(output: string): BlameHunk[] {
    const lines = output.split('\n');
    const hunks: BlameHunk[] = [];
    const commitCache = new Map<string, CommitMeta>();

    let i = 0;
    while (i < lines.length) {
      const headerMatch = lines[i].match(HEADER_RE);
      if (!headerMatch) {
        i++;
        continue;
      }

      const hash = headerMatch[1];
      const finalLine = parseInt(headerMatch[2], 10);

      const { meta, nextIdx } = readMetaBlock(lines, i + 1);
      i = nextIdx;

      if (meta.author && !commitCache.has(hash)) {
        commitCache.set(hash, meta);
      }

      const cached = commitCache.get(hash);
      if (!cached) continue;

      appendHunk(hunks, hash, cached, finalLine);
    }

    return hunks;
  }
}

function readMetaBlock(lines: string[], start: number): { meta: CommitMeta; nextIdx: number } {
  const meta: CommitMeta = { author: '', authorEmail: '', timestamp: 0, summary: '' };
  let i = start;
  while (i < lines.length && !lines[i].startsWith('\t')) {
    applyMetaLine(lines[i], meta);
    i++;
  }
  // Skip the \t-prefixed content line
  if (i < lines.length && lines[i].startsWith('\t')) i++;
  return { meta, nextIdx: i };
}

function applyMetaLine(line: string, meta: CommitMeta): void {
  if (line.startsWith('author ') && !line.startsWith('author-')) {
    meta.author = line.slice(7);
  } else if (line.startsWith('author-mail ')) {
    meta.authorEmail = line.slice(12).replace(/[<>]/g, '');
  } else if (line.startsWith('author-time ')) {
    meta.timestamp = parseInt(line.slice(12), 10);
  } else if (line.startsWith('summary ')) {
    meta.summary = line.slice(8);
  }
}

function appendHunk(hunks: BlameHunk[], hash: string, cached: CommitMeta, finalLine: number): void {
  const prev = hunks[hunks.length - 1];
  if (prev && prev.commitHash === hash && prev.startLine + prev.lineCount === finalLine) {
    prev.lineCount++;
    return;
  }
  hunks.push({
    commitHash: hash,
    shortHash: hash.slice(0, 7),
    author: cached.author,
    authorEmail: cached.authorEmail,
    timestamp: cached.timestamp,
    summary: cached.summary,
    startLine: finalLine,
    lineCount: 1,
  });
}

export const gitBlameService = new GitBlameService();
