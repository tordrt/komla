import { getDirPath, getFileName } from './file-viewer-utils';

type MatchRange = readonly [number, number];

export interface FileSearchMatch {
  score: number;
  fileNameMatches: MatchRange[];
  pathMatches: MatchRange[];
}

function toRanges(indices: number[]): MatchRange[] {
  if (indices.length === 0) return [];

  const ranges: MatchRange[] = [];
  let start = indices[0];
  let prev = indices[0];

  for (let i = 1; i < indices.length; i++) {
    const idx = indices[i];
    if (idx === prev + 1) {
      prev = idx;
      continue;
    }
    ranges.push([start, prev + 1] as const);
    start = idx;
    prev = idx;
  }

  ranges.push([start, prev + 1] as const);
  return ranges;
}

function matchSubsequence(haystack: string, needle: string): number[] | null {
  if (!needle) return [];

  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const indices: number[] = [];
  let from = 0;

  for (let i = 0; i < n.length; i++) {
    const idx = h.indexOf(n[i], from);
    if (idx === -1) return null;
    indices.push(idx);
    from = idx + 1;
  }

  return indices;
}

function scoreMatch(path: string, query: string, fullPathIndices: number[]): number {
  const fileName = getFileName(path);
  const fileNameLower = fileName.toLowerCase();
  const pathLower = path.toLowerCase();
  const queryLower = query.toLowerCase();
  const fileNameStart = path.length - fileName.length;

  const first = fullPathIndices[0] ?? 0;
  const last = fullPathIndices[fullPathIndices.length - 1] ?? 0;
  const span = last - first + 1;
  const gaps = span - fullPathIndices.length;
  const inFileName = fullPathIndices.filter((idx) => idx >= fileNameStart).length;

  let score = 0;

  // Strongly prefer dense matches in the basename.
  score += inFileName * 35;
  score += fullPathIndices.length * 25;
  score -= gaps * 4;
  score -= first * 0.75;

  if (inFileName === fullPathIndices.length) score += 80;
  if (fullPathIndices[0] >= fileNameStart) score += 50;
  if (fileNameLower.startsWith(queryLower)) score += 140;
  else if (fileNameLower.includes(queryLower)) score += 90;
  else if (pathLower.includes(queryLower)) score += 30;

  return score;
}

export function matchFilePath(path: string, query: string): FileSearchMatch | null {
  const trimmed = query.trim();
  if (!trimmed) {
    return { score: 0, fileNameMatches: [], pathMatches: [] };
  }

  const fileName = getFileName(path);
  const dirPath = getDirPath(path);
  const fileNameStart = path.length - fileName.length;
  const dirPathEnd = fileNameStart > 0 ? fileNameStart - 1 : 0;
  const fileNameIndices = matchSubsequence(fileName, trimmed);
  const fullPathIndices = fileNameIndices
    ? fileNameIndices.map((idx) => idx + fileNameStart)
    : matchSubsequence(path, trimmed);

  if (!fullPathIndices) return null;

  const fileNameMatchIndices = fullPathIndices
    .filter((idx) => idx >= fileNameStart)
    .map((idx) => idx - fileNameStart);

  const pathIndices = dirPath ? fullPathIndices.filter((idx) => idx < dirPathEnd) : [];

  return {
    score: scoreMatch(path, trimmed, fullPathIndices),
    fileNameMatches: toRanges(fileNameMatchIndices),
    pathMatches: toRanges(pathIndices),
  };
}
