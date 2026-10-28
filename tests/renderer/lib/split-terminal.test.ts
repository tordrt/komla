import { describe, expect, it, vi } from 'vitest';

import { addTerminalForSplit } from '../../../src/renderer/lib/split-terminal';

import type { Terminal } from '../../../src/shared/types/terminal';

function terminal(executionLocation: Terminal['executionLocation']): Terminal {
  return {
    id: 'terminal-1',
    name: 'Terminal',
    status: 'running',
    createdAt: 1,
    executionLocation,
  };
}

describe('addTerminalForSplit', () => {
  it('preserves the normal workspace terminal behavior', async () => {
    const addTerminal = vi.fn().mockResolvedValue(terminal('workspace'));

    await addTerminalForSplit(addTerminal, 'workspace-1', terminal('workspace'));

    expect(addTerminal).toHaveBeenCalledWith('workspace-1');
  });

  it('creates a host shell in the local copy when the source terminal is local', async () => {
    const addTerminal = vi.fn().mockResolvedValue(terminal('local-mirror'));

    await addTerminalForSplit(addTerminal, 'workspace-1', terminal('local-mirror'));

    expect(addTerminal).toHaveBeenCalledWith(
      'workspace-1',
      'Local terminal',
      null,
      undefined,
      'host-shell',
      'local-mirror'
    );
  });
});
