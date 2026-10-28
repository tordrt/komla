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
