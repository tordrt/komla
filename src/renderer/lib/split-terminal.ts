import { isLocalTerminalExecutionLocation } from '@/types';

import type { Terminal, TerminalExecutionLocation } from '@/types';

type AddTerminal = (
  workspaceId: string,
  name?: string,
  command?: string | null,
  layoutHint?: 'tab' | 'split-right' | 'split-bottom',
  commandKind?: 'agent' | 'host' | 'host-shell',
  executionLocation?: TerminalExecutionLocation
) => Promise<Terminal>;

/** Create a split terminal beside its source, preserving local-copy execution. */
export function addTerminalForSplit(
  addTerminal: AddTerminal,
  workspaceId: string,
  sourceTerminal: Terminal | undefined
): Promise<Terminal> {
  if (!isLocalTerminalExecutionLocation(sourceTerminal?.executionLocation)) {
    return addTerminal(workspaceId);
  }

  return addLocalCopyTerminal(addTerminal, workspaceId);
}

/** Create a shell on this computer in an SSH workspace's local copy. */
export function addLocalCopyTerminal(addTerminal: AddTerminal, workspaceId: string) {
  return addTerminal(workspaceId, 'Local terminal', null, undefined, 'host-shell', 'local-mirror');
}
