import { backgroundProcessService } from '../background-process.service';
import { ptyService } from '../pty.service';
import { sshWorkspaceService } from '../ssh-workspace.service';
import { workspaceService } from '../workspace.service';

import { createDevPreviewServiceDetector } from './detector';
import { collectListeningPorts } from './listening-ports';
import { isLoopbackPortOpen, probeHttpScheme } from './port-probe';
import { collectRemoteListeningPorts, probeRemoteHttpSchemes } from './remote-listening-ports';

export { createDevPreviewServiceDetector } from './detector';
export type { DevPreviewServiceDetector, DevPreviewServiceDetectorDeps } from './detector';

// The user is waiting on the picker, so a slow or unreachable host must not hold it long.
const REMOTE_TIMEOUT_MS = 10_000;

function runOnSshHost(hostId: string): (command: string) => Promise<string> {
  return (command) =>
    sshWorkspaceService.run(sshWorkspaceService.getHost(hostId), command, {
      purpose: { kind: 'interactive' },
      timeout: REMOTE_TIMEOUT_MS,
    });
}

export const devPreviewServiceDetector = createDevPreviewServiceDetector({
  getWorkspace: (workspaceId) => workspaceService.get(workspaceId),
  getTerminalPid: (terminalId) => ptyService.getPid(terminalId),
  getBackgroundPids: (workspaceId) =>
    backgroundProcessService.getProcessesForWorkspace(workspaceId).map(({ pty }) => pty.pid),
  komlaPid: process.pid,
  collectListeningPorts,
  probeHttpScheme,
  isLoopbackPortOpen,
  collectRemoteListeningPorts: (hostId) => collectRemoteListeningPorts(runOnSshHost(hostId)),
  probeRemoteHttpSchemes: (hostId, ports) => probeRemoteHttpSchemes(runOnSshHost(hostId), ports),
});
