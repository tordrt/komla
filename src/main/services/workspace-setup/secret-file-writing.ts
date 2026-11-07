import { execFile } from 'child_process';

import { buildGitEnv } from '../git/git-exec';
import { secretFileStore } from '../secret-files.service';
import { sshWorkspaceService } from '../ssh-workspace.service';

import {
  writeLocalSecretFile,
  writeSecretFile,
  type SecretFileWriteDependencies,
} from './secret-file-write';

import type { SetupStep, TerminalExecutionLocation, Workspace } from '../../../shared/types';

const writing: SecretFileWriteDependencies = {
  read: (projectId, stepId) => secretFileStore.read(projectId, stepId),
  writeLocal: writeLocalSecretFile,
  gitIgnoresLocally: (cwd, file) =>
    new Promise((resolve) => {
      execFile(
        'git',
        ['check-ignore', '-q', '--', file],
        // The file is written by then, so a Git that hangs only loses the warning.
        { cwd, env: buildGitEnv(), windowsHide: true, timeout: 10_000 },
        (error) => {
          if (!error) resolve(true);
          else resolve(error.code === 1 ? false : undefined);
        }
      );
    }),
  runOnHost: (hostId, command, input) =>
    sshWorkspaceService.runWithInput(sshWorkspaceService.getHost(hostId), command, input),
};

/** Writes a Secret file step's contents where it runs, for Workspace Setup. */
export function writeWorkspaceSecretFile(
  workspace: Workspace,
  step: SetupStep,
  destination: { cwd: string; executionLocation: TerminalExecutionLocation }
): ReturnType<typeof writeSecretFile> {
  return writeSecretFile(writing, workspace, step, destination);
}
