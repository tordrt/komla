import { describe, expect, it } from 'vitest';

import {
  countTerminalProgramStatusQueries,
  createTerminalOscNotificationState,
  extractTerminalOscNotifications,
  extractTerminalProgramStatuses,
} from '../../../src/shared/lib/terminal-escape';

describe('extractTerminalOscNotifications', () => {
  it('extracts OSC 9 notifications and removes them from output', () => {
    const result = extractTerminalOscNotifications('before\x1b]9;Done\x07after');

    expect(result.cleaned).toBe('beforeafter');
    expect(result.notifications).toEqual([{ message: 'Done' }]);
  });

  it('extracts OSC 777 notify title and message', () => {
    const result = extractTerminalOscNotifications('\x1b]777;notify;Agent;Needs input\x1b\\');

    expect(result.cleaned).toBe('');
    expect(result.notifications).toEqual([{ title: 'Agent', message: 'Needs input' }]);
  });

  it('extracts plain kitty OSC 99 notifications', () => {
    const result = extractTerminalOscNotifications('\x1b]99;;Hello world\x1b\\');

    expect(result.cleaned).toBe('');
    expect(result.notifications).toEqual([{ message: 'Hello world' }]);
  });

  it('extracts base64-encoded kitty OSC 99 notifications', () => {
    const result = extractTerminalOscNotifications('\x1b]99;e=1;SGVsbG8gd29ybGQ=\x1b\\');

    expect(result.cleaned).toBe('');
    expect(result.notifications).toEqual([{ message: 'Hello world' }]);
  });

  it('extracts kitty OSC 99 title payloads', () => {
    const result = extractTerminalOscNotifications('\x1b]99;i=1:p=title;Agent\x1b\\');

    expect(result.cleaned).toBe('');
    expect(result.notifications).toEqual([{ title: 'Agent', message: 'Agent' }]);
  });

  it('extracts kitty OSC 99 body payloads', () => {
    const result = extractTerminalOscNotifications('\x1b]99;i=1:p=body;Finished\x1b\\');

    expect(result.cleaned).toBe('');
    expect(result.notifications).toEqual([{ message: 'Finished' }]);
  });

  it('waits for kitty OSC 99 title/body continuations before notifying', () => {
    const state = createTerminalOscNotificationState();
    const title = extractTerminalOscNotifications('\x1b]99;i=1:d=0;Agent\x1b\\', state);
    const body = extractTerminalOscNotifications('\x1b]99;i=1:p=body;Finished\x1b\\', state);

    expect(title.cleaned).toBe('');
    expect(title.notifications).toEqual([]);
    expect(body.cleaned).toBe('');
    expect(body.notifications).toEqual([{ title: 'Agent', message: 'Finished' }]);
  });

  it('decodes kitty OSC 99 title/body continuations before notifying', () => {
    const state = createTerminalOscNotificationState();
    const title = extractTerminalOscNotifications('\x1b]99;i=1:d=0:e=1;QWdlbnQ=\x1b\\', state);
    const body = extractTerminalOscNotifications(
      '\x1b]99;i=1:p=body:e=1;RmluaXNoZWQ=\x1b\\',
      state
    );

    expect(title.cleaned).toBe('');
    expect(title.notifications).toEqual([]);
    expect(body.cleaned).toBe('');
    expect(body.notifications).toEqual([{ title: 'Agent', message: 'Finished' }]);
  });

  it('keeps kitty OSC 99 continuation state separate by id', () => {
    const state = createTerminalOscNotificationState();
    extractTerminalOscNotifications('\x1b]99;i=1:d=0;First\x1b\\', state);
    extractTerminalOscNotifications('\x1b]99;i=2:d=0;Second\x1b\\', state);

    const second = extractTerminalOscNotifications('\x1b]99;i=2:p=body;Done\x1b\\', state);
    const first = extractTerminalOscNotifications('\x1b]99;i=1:p=body;Ready\x1b\\', state);

    expect(second.notifications).toEqual([{ title: 'Second', message: 'Done' }]);
    expect(first.notifications).toEqual([{ title: 'First', message: 'Ready' }]);
  });

  it('bounds pending kitty OSC 99 continuations', () => {
    const state = createTerminalOscNotificationState();
    for (let index = 0; index < 40; index += 1) {
      extractTerminalOscNotifications(`\x1b]99;i=${index}:d=0;Title ${index}\x1b\\`, state);
    }

    expect(state.kittyContinuations.size).toBe(32);
    expect(state.kittyContinuations.has('0')).toBe(false);
    expect(state.kittyContinuations.has('7')).toBe(false);
    expect(state.kittyContinuations.has('8')).toBe(true);
    expect(state.kittyContinuations.has('39')).toBe(true);
  });

  it('drops overlong kitty OSC 99 continuations for the same id', () => {
    const state = createTerminalOscNotificationState();
    for (let index = 0; index < 16; index += 1) {
      extractTerminalOscNotifications(`\x1b]99;i=1:d=0;Part ${index}\x1b\\`, state);
    }

    const result = extractTerminalOscNotifications('\x1b]99;i=1:d=0;Overflow\x1b\\', state);

    expect(result.cleaned).toBe('');
    expect(result.notifications).toEqual([]);
    expect(state.kittyContinuations.has('1')).toBe(false);
  });

  it('leaves unsupported kitty OSC 99 payloads intact', () => {
    const input = '\x1b]99;i=1:p=close;\x1b\\';
    const result = extractTerminalOscNotifications(input);

    expect(result.cleaned).toBe(input);
    expect(result.notifications).toEqual([]);
  });

  it('leaves unrelated OSC sequences intact', () => {
    const input = 'a\x1b]0;window title\x07b';
    const result = extractTerminalOscNotifications(input);

    expect(result.cleaned).toBe(input);
    expect(result.notifications).toEqual([]);
  });

  it('leaves OSC 9 current-directory subcommands intact', () => {
    const input = 'a\x1b]9;9;/Users/test/project\x07b';
    const result = extractTerminalOscNotifications(input);

    expect(result.cleaned).toBe(input);
    expect(result.notifications).toEqual([]);
  });

  it('leaves OSC 9 progress subcommands intact', () => {
    const input = 'a\x1b]9;4;1;50\x07b';
    const result = extractTerminalOscNotifications(input);

    expect(result.cleaned).toBe(input);
    expect(result.notifications).toEqual([]);
  });
});

describe('extractTerminalProgramStatuses', () => {
  it('reads the OSC 7501 program statuses Codex writes, with either terminator', () => {
    const output =
      'a\x1b]7501;state=working:app=codex\x1b\\b\x1b]7501;state=blocked:kind=permission:app=codex\x07c';

    expect(extractTerminalProgramStatuses(output)).toEqual([
      { app: 'codex', state: 'working' },
      { app: 'codex', state: 'blocked', kind: 'permission' },
    ]);
  });

  it('reads the state=clear Codex sends as it quits, which names no app', () => {
    expect(extractTerminalProgramStatuses('\x1b]7501;state=clear\x1b\\')).toEqual([
      { state: 'clear' },
    ]);
  });

  it('ignores a status without a state, and other sequences', () => {
    expect(
      extractTerminalProgramStatuses('\x1b]7501;app=codex\x07\x1b]0;state=idle:app=codex\x07')
    ).toEqual([]);
  });

  it('reads no field without a value', () => {
    expect(extractTerminalProgramStatuses('\x1b]7501;stateX:app=codex\x07')).toEqual([]);
  });

  it('decodes the base64 message, and reads the record id a report names', () => {
    // Claude Code's permission prompt, and a background subagent's own record.
    const output =
      '\x1b]7501;state=blocked:app=claude-code:kind=permission:msg=YXBwcm92ZSBCYXNoOiBscw==\x1b\\' +
      '\x1b]7501;state=working:app=claude-code:id=a1141ab52c25db9ac:title=UnVuIHNsZWVw\x07';

    expect(extractTerminalProgramStatuses(output)).toEqual([
      { app: 'claude-code', state: 'blocked', kind: 'permission', msg: 'approve Bash: ls' },
      { app: 'claude-code', state: 'working', id: 'a1141ab52c25db9ac' },
    ]);
  });

  it('reads a message without base64 padding', () => {
    expect(extractTerminalProgramStatuses('\x1b]7501;state=done:app=pi:msg=aGk\x07')).toEqual([
      { app: 'pi', state: 'done', msg: 'hi' },
    ]);
  });

  it('discards a report with an unknown state, a message that is not base64, or control characters', () => {
    const newline = btoa('two\nlines');
    const output =
      '\x1b]7501;state=sleeping:app=pi\x07' +
      '\x1b]7501;state=done:app=pi:msg=not*base64\x07' +
      `\x1b]7501;state=done:app=pi:msg=${newline}\x07`;

    expect(extractTerminalProgramStatuses(output)).toEqual([]);
  });

  it('reads no status from the query a program asks the terminal with', () => {
    expect(extractTerminalProgramStatuses('\x1b]7501;?\x1b\\')).toEqual([]);
  });
});

describe('countTerminalProgramStatusQueries', () => {
  it('counts the OSC 7501 support queries, with either terminator', () => {
    expect(countTerminalProgramStatusQueries('a\x1b]7501;?\x1b\\b\x1b]7501;?\x07')).toBe(2);
  });

  it('counts no status report as a query', () => {
    expect(countTerminalProgramStatusQueries('\x1b]7501;state=idle:app=pi\x07')).toBe(0);
  });
});
