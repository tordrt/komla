import { parseNumstatZ, readPorcelainZ } from './git/git-status';

import type { FileChange } from './git.service';

export const REMOTE_UNTRACKED_NUMSTAT_COMMAND = [
  "git ls-files --others --exclude-standard -z 2>/dev/null | xargs -0 sh -c '",
  'for file do',
  '  stat=$(git diff --no-index --numstat /dev/null -- "$file" 2>/dev/null || true)',
  '  additions=${stat%%\t*}',
  '  remainder=${stat#*\t}',
  '  deletions=${remainder%%\t*}',
  '  if [ "$additions" = "$stat" ]; then additions=0; deletions=0; fi',
  '  printf "%s\\t%s\\t%s\\0" "$additions" "$deletions" "$file"',
  'done',
  "' sh",
].join('\n');

export function parsePorcelainZ(statusText: string, numstatText: string): FileChange[] {
  const stats = parseNumstatZ(numstatText);
  return readPorcelainZ(statusText).map((entry) => {
    const stat = stats.get(entry.path) ?? { additions: 0, deletions: 0 };
    return {
      ...entry,
      ...(entry.status === 'untracked' && !stats.has(entry.path)
        ? { lineCountsUnavailable: true }
        : {}),
      staged: false,
      additions: stat.additions,
      deletions: stat.deletions,
    };
  });
}
