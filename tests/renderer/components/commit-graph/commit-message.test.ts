import { describe, expect, it } from 'vitest';

import { splitCommitMessage } from '../../../../src/renderer/components/commit-graph/commit-message';

describe('splitCommitMessage', () => {
  it('takes the first line as the title', () => {
    expect(splitCommitMessage('Fix the login redirect\n')).toEqual({
      title: 'Fix the login redirect',
      body: '',
    });
    expect(splitCommitMessage('')).toEqual({ title: '', body: '' });
  });

  it('joins hard-wrapped lines back into paragraphs', () => {
    const message = [
      'Fix the login redirect',
      '',
      'The redirect looped when the session',
      'had expired.',
      '',
      'Keep the query string.',
      '',
    ].join('\n');

    expect(splitCommitMessage(message).body).toBe(
      'The redirect looped when the session had expired.\n\nKeep the query string.'
    );
  });

  it('keeps lists, indented lines and trailers on lines of their own', () => {
    const message = [
      'Bump dependencies',
      '',
      'Changes:',
      '- react 19',
      '  and react-dom',
      '* vite 7',
      '1. node 24',
      '',
      'Co-Authored-By: Ada <ada@example.com>',
      'Signed-off-by: Bob <bob@example.com>',
    ].join('\n');

    expect(splitCommitMessage(message).body).toBe(
      [
        'Changes:',
        '- react 19',
        '  and react-dom',
        '* vite 7',
        '1. node 24',
        '',
        'Co-Authored-By: Ada <ada@example.com>',
        'Signed-off-by: Bob <bob@example.com>',
      ].join('\n')
    );
  });
});
