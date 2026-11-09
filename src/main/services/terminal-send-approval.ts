import { getWorkspaceDisplayTitle } from '../../shared/lib/workspace-title';

import { settingsApprovalService } from './settings-approval.service';
import { SettingsManagementError } from './settings-management.service';
import { workspaceService } from './workspace.service';

import type { TerminalSendApprovalRequest } from './komla-operation/operation';

/**
 * Asks the user, in the window showing the workspace, to let `komla send` type a message into a
 * terminal and press Enter. `unanswered` when the prompt ended without their choice, or no window
 * could show it.
 */
export async function approveTerminalSend(
  request: TerminalSendApprovalRequest,
  signal: AbortSignal
): Promise<'apply' | 'cancel' | 'unanswered'> {
  const { terminal, forced } = request;
  const target = workspaceService.get(request.workspaceId);
  // Only a terminal Komla knows can be shown as the source; a name from a request header can't.
  const callerWorkspace = request.callerWorkspaceId
    ? workspaceService.get(request.callerWorkspaceId)
    : undefined;
  const from = callerWorkspace && request.callerTerminalId;
  const terminalName = terminal.name ?? `Terminal ${terminal.id}`;
  const name = target ? `${terminalName} in ${getWorkspaceDisplayTitle(target)}` : terminalName;
  const sender = from
    ? 'An agent or program in another terminal'
    : 'A program outside Komla’s terminals';
  try {
    return await settingsApprovalService.decide(
      {
        resource: 'terminal-send',
        ...(from ? { workspace: callerWorkspace, terminalId: request.callerTerminalId } : {}),
        description: forced
          ? `${sender} wants to answer ${name}, which is waiting for you, by typing this and pressing Enter.`
          : `${sender} wants to type this into ${name} and press Enter. Allowing it lets that sender keep messaging ${terminalName} until either terminal closes.`,
        ...(forced
          ? {
              warning: `${terminalName} is waiting for you${terminal.message ? `: ${terminal.message}` : ''}. This message answers it.`,
            }
          : {}),
        changes: [
          {
            operation: 'send',
            kind: 'terminal-message',
            title: terminalName,
            content: request.text,
            details: target
              ? [{ label: 'Workspace', value: getWorkspaceDisplayTitle(target) }]
              : [],
          },
        ],
      },
      signal
    );
  } catch (error) {
    if (error instanceof SettingsManagementError && error.code === 'NO_APPROVAL_WINDOW') {
      return 'unanswered';
    }
    throw error;
  }
}
