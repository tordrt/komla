/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ActionListItem } from '../../../../../src/renderer/components/layout/settings/ActionListItem';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';

import type { Action } from '../../../../../src/renderer/types';

function renderItem(action: Partial<Action>) {
  render(
    <TooltipProvider>
      <ActionListItem
        action={{ id: 'a1', title: 'Title', content: '', ...action } as Action}
        presets={[]}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        deleteDisabled={false}
      />
    </TooltipProvider>
  );
}

describe('ActionListItem', () => {
  it('previews a saved prompt from after its heading', () => {
    renderItem({ type: 'prompt', content: '# Review the branch\n\nYou are a reviewer.\n## Steps' });

    expect(screen.getByText('You are a reviewer. Steps')).toBeInTheDocument();
  });

  it('keeps shell comments in a terminal command preview', () => {
    renderItem({ type: 'command', content: 'npm run build\n# npm run deploy --prod' });

    expect(
      screen.getByText(
        (_, element) => element?.textContent === 'npm run build\n# npm run deploy --prod'
      )
    ).toBeInTheDocument();
  });
});
