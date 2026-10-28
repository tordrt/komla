import { describe, expect, it } from 'vitest';

import {
  addPromptAttachments,
  attachmentName,
} from '../../../../src/renderer/components/workspaces/NewWorkspacePromptAttachments';
import { MAX_PROMPT_ATTACHMENTS } from '../../../../src/shared/types/workspace';

describe('addPromptAttachments', () => {
  it('skips files already attached', () => {
    expect(addPromptAttachments(['/a.png'], ['/a.png', '/b.png'])).toEqual(['/a.png', '/b.png']);
  });

  it('stops at the most one prompt carries', () => {
    const paths = Array.from({ length: MAX_PROMPT_ATTACHMENTS + 3 }, (_, i) => `/${i}.png`);
    expect(addPromptAttachments([], paths)).toEqual(paths.slice(0, MAX_PROMPT_ATTACHMENTS));
  });
});

describe('attachmentName', () => {
  it('names POSIX and Windows paths by their last part', () => {
    expect(attachmentName('/Users/me/shot.png')).toBe('shot.png');
    expect(attachmentName('C:\\logs\\log.txt')).toBe('log.txt');
  });
});
