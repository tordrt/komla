import type { Terminal } from '../../../shared/types/terminal';
import type { SshWorkspaceBackend } from '../../../shared/types/workspace';
import type { SshRemoteCompanionLaunch, SshTerminalSessionAction } from '../ssh-workspace.service';

export type TerminalAttachmentState =
  | { kind: 'absent' }
  | { kind: 'starting'; generation: number }
  | { kind: 'attached'; generation: number };

export type ManagedRemoteTerminalSessionState =
  | { kind: 'unknown'; lastObserved?: 'present' | 'absent' }
  | { kind: 'present' }
  | { kind: 'absent' };

export interface ManagedRemoteTerminalState {
  terminalId: string;
  workspaceId: string;
  generation: number;
  attachment: TerminalAttachmentState;
  remoteSession: ManagedRemoteTerminalSessionState;
  persistence: 'unknown' | 'supported' | 'unsupported';
  failure?: { phase: 'preparation' | 'attachment'; message: string };
}

export interface ManagedRemoteTerminalContext {
  workspaceId: string;
  backend: SshWorkspaceBackend;
  terminal: Terminal;
  companion?: SshRemoteCompanionLaunch;
}

export interface ManagedRemoteTerminalWorkspaceAdapter {
  findTerminal(terminalId: string): ManagedRemoteTerminalContext | undefined;
  findWorkspace(workspaceId: string):
    | {
        workspaceId: string;
        backend: SshWorkspaceBackend;
        terminals: Terminal[];
      }
    | undefined;
  changed(workspaceId: string): void;
  prepareObservationBestEffort(workspaceId: string): Promise<void>;
  prepareObservationInBackground(workspaceId: string): void;
  reconcileObservation(): void;
}

export interface ManagedRemoteSessionAdapter {
  hasHost(backend: SshWorkspaceBackend): boolean;
  supportsPersistence(backend: SshWorkspaceBackend): Promise<boolean>;
  observe(backend: SshWorkspaceBackend, terminalIds: string[]): Promise<Set<string>>;
  stopAndConfirmAbsent(backend: SshWorkspaceBackend, terminalIds: string[]): Promise<void>;
  buildAttachment(request: {
    backend: SshWorkspaceBackend;
    workspaceId: string;
    terminalId: string;
    command: string | null;
    action: SshTerminalSessionAction;
    keepShellOpenAfterCommand: boolean;
    companion?: SshRemoteCompanionLaunch;
  }): {
    cwd: string;
    command: string;
    startupMode: 'wait-for-marker';
    /** False starts the command without the user's local shell startup files. */
    localLoginShell?: boolean;
  };
}

export interface TerminalAttachmentAdapter {
  spawn(request: {
    terminalId: string;
    workspaceId: string;
    cwd: string;
    command: string;
    startupMode: 'wait-for-marker';
    localLoginShell?: boolean;
  }): void;
  replace(request: {
    terminalId: string;
    workspaceId: string;
    cwd: string;
    command: string;
    cols?: number;
    rows?: number;
    startupMode: 'wait-for-marker';
    localLoginShell?: boolean;
  }): void;
  stop(terminalId: string): void;
  release(terminalId: string): Promise<void>;
}

export interface ManagedRemoteTerminalLifecycleAdapters {
  workspace: ManagedRemoteTerminalWorkspaceAdapter;
  session: ManagedRemoteSessionAdapter;
  attachment: TerminalAttachmentAdapter;
}

export interface ManagedRemoteTerminalCreationTicket {
  terminalId: string;
  initialState: ManagedRemoteTerminalState;
  ready: Promise<
    | { kind: 'ready'; state: ManagedRemoteTerminalState }
    | { kind: 'failed'; state: ManagedRemoteTerminalState; message: string }
    | { kind: 'superseded'; state: ManagedRemoteTerminalState }
  >;
}

export type ManagedRemoteTerminalAttachmentResult =
  | { kind: 'ready'; state: ManagedRemoteTerminalState }
  | { kind: 'superseded'; state: ManagedRemoteTerminalState };

export interface CreateManagedRemoteTerminalRequest {
  workspaceId: string;
  terminalId: string;
  command: string | null;
  keepShellOpenAfterCommand: boolean;
  releaseStartSlot: () => void;
}

export interface ReplaceManagedRemoteTerminalRequest {
  terminalId: string;
  command: string | null;
  keepShellOpenAfterCommand: boolean;
  cols?: number;
  rows?: number;
  releaseStartSlot: () => void;
  onAuthorized?: () => void;
  explicit?: boolean;
}

export type ManagedRemoteTerminalTarget = { terminalId: string } | { workspaceId: string };

export interface ManagedRemoteTerminalRecovery {
  states: ReadonlyMap<string, ManagedRemoteTerminalState>;
  endedTerminalIds: ReadonlySet<string>;
  hostMissing: boolean;
}

export interface PendingManagedRemoteTerminalIntent {
  generation: number;
  mayHaveRemoteSession: boolean;
  cancel: () => void;
}
