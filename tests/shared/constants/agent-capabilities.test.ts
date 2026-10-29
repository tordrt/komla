import { describe, expect, it } from 'vitest';

import {
  agentCapabilitiesUpdate,
  turnedOffQueuedCommands,
} from '../../../src/shared/constants/agent-capabilities';

describe('agentCapabilitiesUpdate', () => {
  it('turns on-by-default actions off and back on, leaving the others', () => {
    const config = { agentDisabledCapabilities: ['workspace.trash'] };

    expect(
      agentCapabilitiesUpdate(config, ['agent.launch.workspace', 'agent.launch.tab'], false)
    ).toEqual({
      agentDisabledCapabilities: ['workspace.trash', 'agent.launch.workspace', 'agent.launch.tab'],
    });
    expect(
      agentCapabilitiesUpdate(
        { agentDisabledCapabilities: ['workspace.trash', 'agent.launch.tab'] },
        ['agent.launch.tab'],
        true
      )
    ).toEqual({ agentDisabledCapabilities: ['workspace.trash'] });
  });

  it('names the commands an SSH host would queue that the user turned off', () => {
    expect(
      turnedOffQueuedCommands({ agentDisabledCapabilities: ['workspace.tag', 'status.set'] })
    ).toEqual({
      'workspace.tag':
        '`komla tag` is turned off in Komla. Ask the user to turn it on in Settings → Integrations & MCP → MCP and CLI access.',
    });
    expect(turnedOffQueuedCommands({})).toEqual({});
  });

  it('lists an action once however often it is turned off', () => {
    expect(
      agentCapabilitiesUpdate({ agentDisabledCapabilities: ['status.set'] }, ['status.set'], false)
    ).toEqual({ agentDisabledCapabilities: ['status.set'] });
  });
});
