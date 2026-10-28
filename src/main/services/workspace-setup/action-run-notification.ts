import { formatRunDuration } from '../../../shared/lib/format-time';
import { COMMAND_ATTENTION_SOURCE } from '../../../shared/types/workspace';

import type { SetupActivityRun } from '../../../shared/types';
import type { AgentHook } from '../terminal-attention/terminal-attention';

/** How a background command Action's run ended, shown like `komla notify -- <command>`'s end. */
export function backgroundActionNotification(run: SetupActivityRun): AgentHook {
  const elapsed = formatRunDuration((run.completedAt ?? Date.now()) - run.startedAt);
  const succeeded = run.state === 'succeeded';
  const failure =
    run.exitCode !== undefined ? `exit code ${run.exitCode}` : (run.error ?? 'an error');
  return {
    cwd: '',
    kind: succeeded ? 'turn-complete' : 'error',
    source: COMMAND_ATTENTION_SOURCE,
    title: run.stepName,
    body: succeeded ? `Finished in ${elapsed}` : `Failed with ${failure} after ${elapsed}`,
    // A failure ends the run's turn, as a StopFailure does.
    hookInput: { hook_event_name: succeeded ? 'Stop' : 'StopFailure' },
  };
}
