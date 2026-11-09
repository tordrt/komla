import {
  RISKY_PANEL_CAPABILITIES,
  type SidebarPanelOperationResult,
} from '../../shared/types/sidebar-panels';

import {
  komlaCommandContext,
  KomlaOperationError,
  type KomlaOperation,
  type KomlaOperationContext,
} from './komla-operation/operation';

import type { AgentCapabilityId } from '../../shared/constants/agent-capabilities';

/*
 * Komla Operations a sidebar panel's page sends through `komla.call`, the end of its SDK client
 * that Komla holds (ADR 0008). The page shows outside text, so it may change only what its panel
 * declares in `capabilities`, and the risky ones only from a click and once the user agrees, or,
 * for a drafted launch, once they start it from New Workspace.
 */

/** What a confirmation shows about an operation a page asks for. */
export interface PanelOperationQuestion {
  /** The panel and where it comes from, such as “Checks” from sidebar-panels.json. */
  panel: string;
  /** What it would do, such as "launch an agent in a new workspace". */
  action: string;
  /** The request's fields, such as the prompt. */
  detail: string;
}

export interface PanelOperationPanel {
  title: string;
  page?: string;
  capabilities?: readonly AgentCapabilityId[];
  plugin?: { name: string };
}

export interface PanelOperationDependencies {
  findPanel(workspaceId: string, id: string): PanelOperationPanel | undefined;
  /** Reads a request as the CLI's are read, or throws a KomlaOperationError. */
  parse(raw: unknown): KomlaOperation;
  capabilityOf(operation: KomlaOperation): AgentCapabilityId | undefined;
  execute(context: KomlaOperationContext, operation: KomlaOperation): Promise<unknown>;
  /** Asks the user whether the page may do it; true once they agree. */
  confirm(question: PanelOperationQuestion): Promise<boolean>;
}

export interface PanelOperationRequest {
  workspaceId: string;
  panelId: string;
  request: unknown;
  /** The workspace to act on in place of the panel's, as `--workspace` names it. */
  targetWorkspaceId?: string;
  /** The user was clicking or typing in the page as it asked. */
  activated: boolean;
}

const ACTIONS: Partial<Record<AgentCapabilityId, string>> = {
  'agent.launch.tab': 'launch an agent in a new tab',
  'agent.launch.workspace': 'launch an agent in a new workspace',
  'terminal.send': 'type into another terminal',
  'workspace.trash': 'move a workspace to the Trash',
  'workspace.link': 'link or unlink workspaces',
  'folder.open': 'open a folder in Komla',
};

const MAX_DETAIL = 2000;

function failure(
  code: string,
  message: string,
  details?: Record<string, unknown>
): SidebarPanelOperationResult {
  return { ok: false, error: { code, message, ...(details && { details }) } };
}

function describeRequest(operation: KomlaOperation, targetWorkspaceId?: string): string {
  const { type: _type, ...fields } = operation;
  const lines = Object.entries(fields).map(
    ([name, value]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`
  );
  if (targetWorkspaceId) lines.push(`workspace: ${targetWorkspaceId}`);
  const detail = lines.join('\n');
  return detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail;
}

export async function runSidebarPanelOperation(
  dependencies: PanelOperationDependencies,
  { workspaceId, panelId, request, targetWorkspaceId, activated }: PanelOperationRequest
): Promise<SidebarPanelOperationResult> {
  const panel = dependencies.findPanel(workspaceId, panelId);
  if (!panel?.page) {
    return failure(
      'PANEL_NOT_FOUND',
      `This workspace has no sidebar panel ${panelId} with a page.`
    );
  }
  const source = panel.plugin ? `the plugin ${panel.plugin.name}` : 'sidebar-panels.json';
  // The user agreed to the operation as the confirmation showed it.
  let userConfirmed = false;
  try {
    const operation = dependencies.parse(request);
    const capability = dependencies.capabilityOf(operation);
    if (capability && !panel.capabilities?.includes(capability)) {
      return failure(
        'CAPABILITY_NOT_DECLARED',
        `${operation.type} needs the ${capability} capability, which the panel ${panel.title} doesn't declare in ${source}.`,
        { capability }
      );
    }
    if (capability && RISKY_PANEL_CAPABILITIES.includes(capability)) {
      if (!activated) {
        return failure(
          'NEEDS_USER_ACTION',
          `${operation.type} works only from a click or a key press in the panel.`,
          { capability }
        );
      }
      // A draft waits in New Workspace for the user to start, which is the confirmation.
      const drafted = operation.type === 'agent.launch' && operation.draft === true;
      const agreed =
        drafted ||
        (await dependencies.confirm({
          panel: `“${panel.title}” from ${source}`,
          action: ACTIONS[capability] ?? operation.type,
          detail: describeRequest(operation, targetWorkspaceId),
        }));
      userConfirmed = agreed && !drafted;
      if (!agreed) {
        return failure(
          'DECLINED',
          `You didn't let the panel ${panel.title} ${ACTIONS[capability]}.`,
          {
            capability,
          }
        );
      }
    }
    const result = await dependencies.execute(
      {
        ...komlaCommandContext({ workspaceId, targetWorkspaceId }),
        ...(userConfirmed && { userConfirmed }),
      },
      operation
    );
    return { ok: true, result };
  } catch (error) {
    if (error instanceof KomlaOperationError) {
      return failure(error.code, error.message, error.details);
    }
    return failure('OPERATION_FAILED', 'Komla could not complete the operation.');
  }
}
