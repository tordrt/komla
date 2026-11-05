import { describe, it, expect } from 'vitest';

import {
  ACTION_TARGET_BRANCH_TOKEN,
  ACTION_USER_INPUT_TOKEN,
  injectActionContext,
  injectActionInput,
  actionNeedsInjection,
  fillActionText,
} from '../../../src/shared/lib/action-injection';

describe('action-injection', () => {
  it('detects when an action requires injection', () => {
    expect(actionNeedsInjection(`Hello ${ACTION_USER_INPUT_TOKEN}`)).toBe(true);
    expect(actionNeedsInjection('Hello world')).toBe(false);
  });

  it('replaces all token occurrences with the same input', () => {
    const action = [`First: ${ACTION_USER_INPUT_TOKEN}`, `Second: ${ACTION_USER_INPUT_TOKEN}`].join(
      '\n'
    );

    const result = injectActionInput(action, 'my custom message');

    expect(result).toBe('First: my custom message\nSecond: my custom message');
  });

  it('leaves prompt unchanged when token is absent', () => {
    const action = 'No replacement token here.';
    expect(injectActionInput(action, 'ignored')).toBe(action);
  });

  it('injects target branch when available', () => {
    const action = `Review against ${ACTION_TARGET_BRANCH_TOKEN}`;
    expect(injectActionContext(action, { targetBranch: 'main' })).toBe('Review against main');
  });

  it('injects multiline user input while preserving formatting', () => {
    const action = `Notes:\n${ACTION_USER_INPUT_TOKEN}\nDone`;
    const input = 'line one\nline two';
    expect(injectActionContext(action, { userInput: input })).toBe(
      'Notes:\nline one\nline two\nDone'
    );
  });

  it('injects user input and leaves unresolved target branch token untouched', () => {
    const action = `Summary: ${ACTION_USER_INPUT_TOKEN}\nTarget: ${ACTION_TARGET_BRANCH_TOKEN}`;
    expect(injectActionContext(action, { userInput: 'ship it' })).toBe(
      `Summary: ship it\nTarget: ${ACTION_TARGET_BRANCH_TOKEN}`
    );
  });

  it('leaves tokens typed into the input as typed', () => {
    const action = `Rebase on ${ACTION_TARGET_BRANCH_TOKEN}: ${ACTION_USER_INPUT_TOKEN}`;
    expect(
      injectActionContext(action, {
        userInput: `explain ${ACTION_TARGET_BRANCH_TOKEN} and ${ACTION_USER_INPUT_TOKEN}`,
        targetBranch: 'main',
      })
    ).toBe(`Rebase on main: explain ${ACTION_TARGET_BRANCH_TOKEN} and ${ACTION_USER_INPUT_TOKEN}`);
  });

  it('injects dollar signs as typed', () => {
    const action = `Run ${ACTION_USER_INPUT_TOKEN} on ${ACTION_TARGET_BRANCH_TOKEN}`;
    expect(injectActionContext(action, { userInput: "kill $$ $& $'", targetBranch: 'v$1' })).toBe(
      "Run kill $$ $& $' on v$1"
    );
  });

  it('leaves target branch token unchanged when value is missing', () => {
    const action = `Review against ${ACTION_TARGET_BRANCH_TOKEN}`;
    expect(injectActionContext(action, {})).toBe(action);
  });
});

describe('fillActionText', () => {
  const sshWorkspace = {
    workingDirectory: 'ssh://host-1/home/dev/repo',
    branchName: 'feature/x',
    backend: { kind: 'ssh', remoteDirectory: '/home/dev/repo' },
  } as Parameters<typeof fillActionText>[1]['workspace'];
  const fill = (
    action: { type?: 'prompt' | 'command'; content: string },
    options: { input?: string; pasted?: boolean } = {}
  ) =>
    fillActionText(action, {
      workspace: sshWorkspace,
      projectName: 'Komla',
      targetBranch: () => 'main',
      ...options,
    });

  it("fills a Saved Prompt with the workspace's values, its SSH folder as the path", () => {
    expect(
      fill(
        { content: 'Review {{worktreePath}} on {{branchName}} in {{projectName}}: {{user_input}}' },
        { input: 'keep {{branchName}}' }
      )
    ).toBe('Review /home/dev/repo on feature/x in Komla: keep {{branchName}}');
  });

  it("leaves a Terminal Command's workspace values to its terminal, unless it's pasted", () => {
    const command = { type: 'command' as const, content: 'git log {{target_branch}}..{{branchName}}' };
    expect(fill(command)).toBe('git log main..{{branchName}}');
    expect(fill(command, { pasted: true })).toBe('git log main..feature/x');
  });
});
