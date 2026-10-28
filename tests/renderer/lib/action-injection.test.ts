import { describe, it, expect } from 'vitest';

import {
  ACTION_TARGET_BRANCH_TOKEN,
  ACTION_USER_INPUT_TOKEN,
  injectActionContext,
  injectActionInput,
  actionNeedsInjection,
} from '../../../src/renderer/lib/action-injection';

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
