import type { KomlaOperation } from './operation';
import type { AgentCapabilityId } from '../../../shared/constants/agent-capabilities';

/** A capability, or one for each value of a request field. */
export type KomlaOperationCapability =
  | AgentCapabilityId
  | { by: 'destination'; capabilities: Record<'tab' | 'workspace', AgentCapabilityId> }
  | null;

/**
 * The capability the user must leave on for each operation, which the operation service checks
 * before it runs one. The SDK gets the same table (ADR 0008), so a client can tell which
 * capabilities to declare.
 */
export const KOMLA_OPERATION_CAPABILITIES = {
  'terminal.list': 'terminal.read',
  'terminal.read': 'terminal.read',
  'terminal.send': 'terminal.send',
  // It only follows what a terminal shows.
  'terminal.wait': 'terminal.read',
  'context.get': null,
  'agent.presets': null,
  'agent.launch': {
    by: 'destination',
    capabilities: { tab: 'agent.launch.tab', workspace: 'agent.launch.workspace' },
  },
  'workspace.list': null,
  'tag.list': null,
  'workspace.title': 'workspace.title',
  'workspace.snooze': 'workspace.snooze',
  // Waking only undoes a snooze, so a job's hook can still end one.
  'workspace.wake': null,
  'workspace.tag': 'workspace.tag',
  // Shown in the tag's place, so the user turns both off with one toggle.
  'workspace.progress': 'workspace.tag',
  'workspace.mark': 'workspace.tag',
  'workspace.trash': 'workspace.trash',
  // As `komla notify`: no Agent Capability, but off with the hooks endpoint.
  'workspace.notify': null,
  'workspace.link': 'workspace.link',
  'workspace.unlink': 'workspace.link',
  'folder.open': 'folder.open',
  'status.set': 'status.set',
  'status.clear': 'status.set',
  // It runs only a command the user's status-items.json names, and adds nothing to the status
  // bar, so the user's own hooks can refresh items agents can't set.
  'status.refresh': null,
  'preview.open': 'preview.open',
  'desktop.open': 'preview.open',
} as const satisfies Record<KomlaOperation['type'], KomlaOperationCapability>;

/** The capability an operation needs, if any. */
export function komlaOperationCapability(operation: KomlaOperation): AgentCapabilityId | undefined {
  const capability: KomlaOperationCapability = KOMLA_OPERATION_CAPABILITIES[operation.type];
  if (capability === null) return undefined;
  if (typeof capability === 'string') return capability;
  // The schema allows only the values the table names, so each has a capability.
  const value = (operation as Partial<Record<typeof capability.by, 'tab' | 'workspace'>>)[
    capability.by
  ];
  return value === undefined ? undefined : capability.capabilities[value];
}
