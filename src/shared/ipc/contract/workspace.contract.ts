import { IPC } from '../../constants/ipc-channels';
import {
  workspaceCreateArgsSchema,
  workspaceCreateBatchArgsSchema,
  workspaceAddTerminalArgsSchema,
  workspaceAddAgentTabArgsSchema,
  workspaceRemoveTerminalArgsSchema,
  workspaceStopArgsSchema,
  workspaceStopTerminalArgsSchema,
  workspaceRestartTerminalArgsSchema,
  workspaceReconnectSshTerminalArgsSchema,
  workspaceFindInSshTerminalArgsSchema,
  workspaceRecoverSshSessionsArgsSchema,
  workspaceListRemoteSshArgsSchema,
  workspaceAdoptRemoteSshArgsSchema,
  workspaceLinkSshProjectArgsSchema,
  workspaceRemoveMissingSshArgsSchema,
  workspaceSyncSshHostArgsSchema,
  workspaceRetrySetupStepArgsSchema,
  workspaceRetryLocalCopySyncArgsSchema,
  workspaceDismissSetupActivityArgsSchema,
  workspaceRunBackgroundActionArgsSchema,
  workspaceStopBackgroundActionRunArgsSchema,
  workspaceDeleteArgsSchema,
  workspaceGetArgsSchema,
  workspaceUpdateArgsSchema,
  workspaceUpdateTerminalArgsSchema,
  workspaceRestartArgsSchema,
  workspaceReorderArgsSchema,
  clearAttentionArgsSchema,
  clearTerminalAttentionArgsSchema,
  terminalAttentionSeenArgsSchema,
  generateBranchNameArgsSchema,
  regenerateWorkspaceNameArgsSchema,
  workspaceLinkArgsSchema,
  workspaceUnlinkArgsSchema,
  workspaceLinkPathsArgsSchema,
  workspaceSetManualSpinnerArgsSchema,
  workspaceStartSshPreviewForwardArgsSchema,
  workspaceStopSshPreviewForwardArgsSchema,
  workspaceStartSshLinkForwardArgsSchema,
  workspaceStopSshLinkForwardArgsSchema,
} from '../schemas/workspace-ipc.schemas';

import { invoke } from './define';

import type { ManagedTmuxFindResult } from '../../lib/ssh-tmux-attach';
import type { SshLinkForward, SshPreviewForward } from '../../types/ssh';
import type { RemoteSshWorkspace } from '../../types/ssh-workspace-manifest';
import type { Terminal } from '../../types/terminal';
import type {
  Workspace,
  WorkspaceCreateBatchResult,
  WorkspaceCreateResult,
  WorkspaceRestartResult,
} from '../../types/workspace';

export const workspaceContract = {
  [IPC.WORKSPACE_CREATE]: invoke(workspaceCreateArgsSchema).returns<WorkspaceCreateResult>(),
  [IPC.WORKSPACE_CREATE_BATCH]: invoke(
    workspaceCreateBatchArgsSchema
  ).returns<WorkspaceCreateBatchResult>(),
  [IPC.WORKSPACE_ADD_TERMINAL]: invoke(workspaceAddTerminalArgsSchema).returns<Terminal>(),
  [IPC.WORKSPACE_ADD_AGENT_TAB]: invoke(workspaceAddAgentTabArgsSchema).returns<Terminal>(),
  [IPC.WORKSPACE_REMOVE_TERMINAL]: invoke(workspaceRemoveTerminalArgsSchema).returns<void>(),
  [IPC.WORKSPACE_STOP]: invoke(workspaceStopArgsSchema).returns<void>(),
  [IPC.WORKSPACE_STOP_TERMINAL]: invoke(workspaceStopTerminalArgsSchema).returns<void>(),
  [IPC.WORKSPACE_RESTART_TERMINAL]: invoke(workspaceRestartTerminalArgsSchema).returns<Terminal>(),
  [IPC.WORKSPACE_RECONNECT_SSH_TERMINAL]: invoke(
    workspaceReconnectSshTerminalArgsSchema
  ).returns<Terminal>(),
  [IPC.WORKSPACE_FIND_IN_SSH_TERMINAL]: invoke(
    workspaceFindInSshTerminalArgsSchema
  ).returns<ManagedTmuxFindResult>(),
  [IPC.WORKSPACE_RECOVER_SSH_SESSIONS]: invoke(workspaceRecoverSshSessionsArgsSchema).returns<
    Workspace | undefined
  >(),
  [IPC.WORKSPACE_LIST_REMOTE_SSH]: invoke(workspaceListRemoteSshArgsSchema).returns<
    RemoteSshWorkspace[]
  >(),
  [IPC.WORKSPACE_ADOPT_REMOTE_SSH]: invoke(workspaceAdoptRemoteSshArgsSchema).returns<Workspace>(),
  [IPC.WORKSPACE_LINK_SSH_PROJECT]: invoke(workspaceLinkSshProjectArgsSchema).returns<void>(),
  [IPC.WORKSPACE_REMOVE_MISSING_SSH]: invoke(workspaceRemoveMissingSshArgsSchema).returns<void>(),
  [IPC.WORKSPACE_SYNC_SSH_HOST]: invoke(workspaceSyncSshHostArgsSchema).returns<void>(),
  [IPC.WORKSPACE_RETRY_SETUP_STEP]: invoke(workspaceRetrySetupStepArgsSchema).returns<Workspace>(),
  [IPC.WORKSPACE_RETRY_LOCAL_COPY_SYNC]: invoke(
    workspaceRetryLocalCopySyncArgsSchema
  ).returns<void>(),
  [IPC.WORKSPACE_DISMISS_SETUP_ACTIVITY]: invoke(
    workspaceDismissSetupActivityArgsSchema
  ).returns<Workspace>(),
  [IPC.WORKSPACE_RUN_BACKGROUND_ACTION]: invoke(
    workspaceRunBackgroundActionArgsSchema
  ).returns<Workspace>(),
  [IPC.WORKSPACE_STOP_BACKGROUND_ACTION_RUN]: invoke(
    workspaceStopBackgroundActionRunArgsSchema
  ).returns<void>(),
  [IPC.WORKSPACE_DELETE]: invoke(workspaceDeleteArgsSchema).returns<void>(),
  [IPC.WORKSPACE_LIST]: invoke().returns<Workspace[]>(),
  [IPC.WORKSPACE_GET]: invoke(workspaceGetArgsSchema).returns<Workspace | undefined>(),
  [IPC.WORKSPACE_UPDATE]: invoke(workspaceUpdateArgsSchema).returns<Workspace>(),
  [IPC.WORKSPACE_NOTIFY_CHANGED]: invoke().returns<void>(),
  [IPC.WORKSPACE_UPDATE_TERMINAL]: invoke(workspaceUpdateTerminalArgsSchema).returns<Terminal>(),
  [IPC.WORKSPACE_RESTART]: invoke(workspaceRestartArgsSchema).returns<WorkspaceRestartResult>(),
  [IPC.WORKSPACE_REORDER]: invoke(workspaceReorderArgsSchema).returns<void>(),
  [IPC.NOTIFICATIONS_CLEAR_ATTENTION]: invoke(clearAttentionArgsSchema).returns<void>(),
  [IPC.WORKSPACE_CLEAR_TERMINAL_ATTENTION]: invoke(
    clearTerminalAttentionArgsSchema
  ).returns<void>(),
  [IPC.WORKSPACE_TERMINAL_ATTENTION_SEEN]: invoke(terminalAttentionSeenArgsSchema).returns<void>(),
  [IPC.WORKSPACE_GENERATE_BRANCH_NAME]: invoke(generateBranchNameArgsSchema).returns<
    string | null
  >(),
  [IPC.WORKSPACE_REGENERATE_NAME]: invoke(regenerateWorkspaceNameArgsSchema).returns<Workspace>(),
  [IPC.WORKSPACE_CANCEL_BRANCH_NAMING]: invoke().returns<void>(),
  [IPC.WORKSPACE_LINK]: invoke(workspaceLinkArgsSchema).returns<void>(),
  [IPC.WORKSPACE_UNLINK]: invoke(workspaceUnlinkArgsSchema).returns<void>(),
  [IPC.WORKSPACE_LINK_PATHS]: invoke(workspaceLinkPathsArgsSchema).returns<
    Array<{ workspaceId: string; path: string }>
  >(),
  [IPC.WORKSPACE_SET_MANUAL_SPINNER]: invoke(workspaceSetManualSpinnerArgsSchema).returns<void>(),
  [IPC.WORKSPACE_START_SSH_PREVIEW_FORWARD]: invoke(
    workspaceStartSshPreviewForwardArgsSchema
  ).returns<SshPreviewForward>(),
  [IPC.WORKSPACE_STOP_SSH_PREVIEW_FORWARD]: invoke(
    workspaceStopSshPreviewForwardArgsSchema
  ).returns<void>(),
  [IPC.WORKSPACE_START_SSH_LINK_FORWARD]: invoke(
    workspaceStartSshLinkForwardArgsSchema
  ).returns<SshLinkForward>(),
  [IPC.WORKSPACE_STOP_SSH_LINK_FORWARD]: invoke(
    workspaceStopSshLinkForwardArgsSchema
  ).returns<void>(),
} as const;
