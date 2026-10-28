import { describe, expect, it } from 'vitest';

import {
  getWorkspaceRestartAgent,
  getWorkspaceRestartDescription,
} from '@/components/terminal/workspace-restart-description';

describe('getWorkspaceRestartAgent', () => {
  it('resumes when the continue command differs from the open command', () => {
    expect(
      getWorkspaceRestartAgent({ openCommand: 'claude', continueCommand: 'claude --resume' })
    ).toBe('resume');
  });

  it('starts the agent fresh when the continue command repeats the open command', () => {
    expect(
      getWorkspaceRestartAgent({
        openCommand: 'hermes chat {{launchMode}}',
        continueCommand: ' hermes chat {{launchMode}} ',
      })
    ).toBe('start');
  });

  it('resumes when legacy data has no open command', () => {
    expect(getWorkspaceRestartAgent({ continueCommand: 'claude --resume' })).toBe('resume');
  });

  it('starts a shell when no continue command is configured', () => {
    expect(getWorkspaceRestartAgent({ openCommand: 'claude', continueCommand: '  ' })).toBe('none');
    expect(getWorkspaceRestartAgent({ openCommand: 'claude' })).toBe('none');
    expect(getWorkspaceRestartAgent(undefined)).toBe('none');
  });
});

describe('getWorkspaceRestartDescription', () => {
  it('describes resuming an agent session when a continue command is configured', () => {
    expect(getWorkspaceRestartDescription(false, 'resume')).toBe('Resuming agent session');
    expect(getWorkspaceRestartDescription(true, 'resume')).toBe(
      'Connecting to the remote host and resuming agent session'
    );
  });

  it('describes starting the agent when the continue command starts a new session', () => {
    expect(getWorkspaceRestartDescription(false, 'start')).toBe('Starting agent');
    expect(getWorkspaceRestartDescription(true, 'start')).toBe(
      'Connecting to the remote host and starting agent'
    );
  });

  it('describes starting a shell when no continue command is configured', () => {
    expect(getWorkspaceRestartDescription(false, 'none')).toBe('Starting shell');
    expect(getWorkspaceRestartDescription(true, 'none')).toBe(
      'Connecting to the remote host and starting shell'
    );
  });
});
