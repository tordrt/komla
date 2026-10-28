import type { FileChange } from '@/types';

export type WorkspaceChangePillKind =
  | 'additions'
  | 'deletions'
  | 'new-files'
  | 'deleted-files'
  | 'modified-files';

export interface WorkspaceChangePill {
  kind: WorkspaceChangePillKind;
  label: string;
  count: number;
  title?: string;
}

export function buildWorkspaceChangePills(params: {
  additions: number;
  deletions: number;
  files?: FileChange[];
}): WorkspaceChangePill[] {
  const linePills: WorkspaceChangePill[] = [];
  const partial = params.files?.some((file) => file.lineCountsUnavailable) ?? false;
  if (params.additions > 0 || (partial && params.deletions > 0)) {
    linePills.push({
      kind: 'additions',
      label: `+${params.additions}${partial ? '*' : ''}`,
      count: params.additions,
      ...(partial
        ? { title: 'Partial total: line counts for some untracked files are unavailable' }
        : {}),
    });
  }
  if (params.deletions > 0) {
    linePills.push({
      kind: 'deletions',
      label: `-${params.deletions}`,
      count: params.deletions,
    });
  }
  if (linePills.length > 0) return linePills;

  const files = params.files ?? [];
  if (files.length === 0) return [];

  let newFiles = 0;
  let deletedFiles = 0;
  let modifiedFiles = 0;

  for (const file of files) {
    if (file.status === 'added' || file.status === 'untracked') {
      newFiles++;
    } else if (file.status === 'deleted') {
      deletedFiles++;
    } else {
      modifiedFiles++;
    }
  }

  return [
    newFiles > 0 ? { kind: 'new-files' as const, label: `${newFiles}`, count: newFiles } : null,
    deletedFiles > 0
      ? { kind: 'deleted-files' as const, label: `${deletedFiles}`, count: deletedFiles }
      : null,
    modifiedFiles > 0
      ? { kind: 'modified-files' as const, label: `${modifiedFiles}`, count: modifiedFiles }
      : null,
  ]
    .filter((pill) => pill !== null)
    .slice(0, 2);
}
