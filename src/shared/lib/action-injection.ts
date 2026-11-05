import { getWorkspaceCwdIdentity } from '../types/workspace';

import { substituteCommandVars } from './template-vars';

import type { Action } from '../types';
import type { Workspace } from '../types/workspace';

export const ACTION_USER_INPUT_TOKEN = '{{user_input}}';
export const ACTION_TARGET_BRANCH_TOKEN = '{{target_branch}}';

export function actionNeedsInjection(content: string): boolean {
  return !!content && content.includes(ACTION_USER_INPUT_TOKEN);
}

interface ActionContext {
  userInput?: string;
  targetBranch?: string;
}

// Fills in every token in one pass, so tokens and `$` patterns inside a value stay as written.
export function injectActionContext(content: string, context: ActionContext): string {
  const values: Record<string, string | undefined> = {
    [ACTION_USER_INPUT_TOKEN]: context.userInput,
    [ACTION_TARGET_BRANCH_TOKEN]: context.targetBranch?.trim() || undefined,
  };
  return content.replace(
    /\{\{(?:user_input|target_branch)\}\}/g,
    (token) => values[token] ?? token
  );
}

export function injectActionInput(content: string, userInput: string): string {
  return injectActionContext(content, { userInput });
}

interface ActionTextContext {
  workspace: Pick<Workspace, 'workingDirectory' | 'branchName' | 'backend'>;
  projectName: string;
  /** Asked for only when the text names it. */
  targetBranch: () => string;
  input?: string;
  /** Pasted into a terminal rather than run: a Terminal Command gets the workspace's values too. */
  pasted?: boolean;
}

/**
 * The text an Action runs in a workspace, as the desktop and the phone both fill it in: the
 * workspace's own values before the user's input, so braces typed into the input stay as typed.
 * A Terminal Command that runs keeps `{{worktreePath}}`, `{{branchName}}` and `{{projectName}}` for
 * the terminal it starts in to fill in, quoted for its shell, which also fills them inside the
 * user's input.
 */
export function fillActionText(
  action: Pick<Action, 'type' | 'content'>,
  { workspace, projectName, targetBranch, input, pasted = false }: ActionTextContext
): string {
  const content =
    action.type === 'command' && !pasted
      ? action.content
      : substituteCommandVars(action.content, {
          worktreePath: getWorkspaceCwdIdentity(workspace),
          branchName: workspace.branchName || '',
          projectName,
        });
  return injectActionContext(content, {
    userInput: input,
    targetBranch: content.includes(ACTION_TARGET_BRANCH_TOKEN) ? targetBranch() : undefined,
  });
}
