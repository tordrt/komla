import type { Project, SetupStep } from '../types';

export interface SetupStepUsingAction {
  project: { id: string; name: string };
  step: { id: string; name: string };
}

type ProjectSteps = Pick<Project, 'id' | 'name'> & {
  setupSteps?: Pick<SetupStep, 'id' | 'name' | 'actionId'>[];
};

/** The Setup steps, across projects, that run a Quick Command, which deleting it would break. */
export function setupStepsUsingAction(
  projects: readonly ProjectSteps[],
  actionId: string
): SetupStepUsingAction[] {
  return projects.flatMap((project) =>
    (project.setupSteps ?? [])
      .filter((step) => step.actionId === actionId)
      .map((step) => ({
        project: { id: project.id, name: project.name },
        step: { id: step.id, name: step.name },
      }))
  );
}

/** How a list of Setup steps that run a Quick Command reads, as "Project › Step, …". */
export function describeSetupStepsUsingAction(usages: readonly SetupStepUsingAction[]): string {
  return usages.map(({ project, step }) => `${project.name} › ${step.name}`).join(', ');
}
