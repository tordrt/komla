/** CPU and memory of a group of processes. */
export interface ResourceUsage {
  /** Percent of one core, so several busy cores add up past 100; null until a second sample. */
  cpuPercent: number | null;
  /** Resident memory, in bytes. Memory processes share is counted for each. */
  memoryBytes: number;
}

export interface TerminalResourceUsage extends ResourceUsage {
  terminalId: string;
}

/** A workspace's terminals and everything they started. */
export interface WorkspaceResourceUsage extends ResourceUsage {
  workspaceId: string;
  terminals: TerminalResourceUsage[];
}

/** A kind of Komla's own processes, apart from what runs in its terminals. */
export type KomlaProcessKind =
  /** This computer: Komla's main process, its windows and browser tabs, and Electron's helpers. */
  | 'main'
  | 'windows'
  | 'helpers'
  /** This computer: what Komla starts outside terminals, such as ssh and git. */
  | 'background'
  /** An SSH host: the tmux server that keeps Komla's terminal sessions and their scrollback. */
  | 'tmux-server'
  /** An SSH host: tmux clients attached to those sessions, one per terminal open on a device. */
  | 'connections'
  /** An SSH host: each device's companion, which watches workspaces and passes on agent hooks. */
  | 'companion';

export interface KomlaProcessUsage extends ResourceUsage {
  kind: KomlaProcessKind;
  processCount: number;
}

export interface MachineResources {
  cores: number | null;
  /**
   * Percent of one core the whole machine used since the previous read, by its own count; null
   * until a second read, and where it keeps none, as on macOS SSH hosts.
   */
  cpuPercent: number | null;
  memoryTotalBytes: number | null;
  memoryAvailableBytes: number | null;
}

/** What runs on this computer or on an SSH host, by workspace. */
export interface MachineResourceUsage {
  /** The SSH host; absent for this computer. */
  hostId?: string;
  machine: MachineResources;
  /** Busiest first by memory. */
  workspaces: WorkspaceResourceUsage[];
  /** Komla's own processes, by kind; those it has none of are left out. */
  komla: KomlaProcessUsage[];
  /** Komla's tmux sessions on the host that no workspace here has, such as another device's. */
  otherSessions?: ResourceUsage & { count: number };
  /** Everything else running on the machine. */
  otherProcesses: ResourceUsage;
  /** Why the host couldn't be read; the rest is then empty. */
  error?: string;
}
