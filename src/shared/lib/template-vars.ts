export function substituteCommandVars(
  template: string,
  vars: { worktreePath: string; branchName: string; projectName: string }
): string {
  // One pass with a function, so tokens and `$` patterns inside a value stay as written.
  return template.replace(
    /\{\{(worktreePath|branchName|projectName)\}\}/g,
    (_token, name: keyof typeof vars) => vars[name]
  );
}
