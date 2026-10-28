/**
 * @vitest-environment jsdom
 */
import { render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

import { WrappingPath } from '../../../../src/renderer/components/ui/wrapping-path';

/** The rendered path with each `<wbr>` line break opportunity shown as `|`. */
function renderedBreaks(path: string): string {
  const { container } = render(<WrappingPath path={path} />);
  return Array.from(container.firstElementChild!.children, (node) =>
    node.tagName === 'WBR' ? '|' : node.textContent
  ).join('');
}

describe('WrappingPath', () => {
  it('breaks a POSIX path after each slash', () => {
    expect(renderedBreaks('/home/me/llmschema-db-diff')).toBe('/|home/|me/|llmschema-db-diff');
  });

  it('breaks a Windows path after each backslash', () => {
    expect(renderedBreaks('C:\\Users\\devuser\\.komla\\worktrees\\steep-flint')).toBe(
      'C:\\|Users\\|devuser\\|.komla\\|worktrees\\|steep-flint'
    );
  });
});
