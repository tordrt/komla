import type { SetupStep, SetupStepPane, SetupStepPlacement } from '../types/project';

/** The pane a browser or note step opens, or nothing for a terminal step. */
export function setupStepPane(step: Pick<SetupStep, 'kind'>): SetupStepPane | undefined {
  return step.kind === 'browser' || step.kind === 'note' ? step.kind : undefined;
}

/** Where a browser or note step opens: a pane always shows, so one saved as background opens in a tab. */
export function setupPanePlacement(
  placement: SetupStepPlacement
): Exclude<SetupStepPlacement, 'background'> {
  return placement === 'background' ? 'tab' : placement;
}
