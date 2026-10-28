/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
} from '../../../../src/renderer/components/ui/tooltip';
import {
  AttentionGlyph,
  AttentionTooltipContent,
} from '../../../../src/renderer/components/workspaces/AttentionTooltipContent';
import { getWorkspaceAttentionAppearance } from '../../../../src/renderer/lib/workspace-attention';

import type { WorkspaceAttention } from '../../../../src/renderer/types';

function renderCard(attention: WorkspaceAttention) {
  render(
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger>Done</TooltipTrigger>
        <AttentionTooltipContent
          attention={attention}
          appearance={getWorkspaceAttentionAppearance(attention)!}
        />
      </Tooltip>
    </TooltipProvider>
  );
  return screen.getByRole('tooltip');
}

describe('AttentionTooltipContent', () => {
  it('shows what happened, when, and the whole message with its line breaks', () => {
    const message =
      'Refactored the session store.\n\nTests pass; the staging secret is still missing.';
    const tooltip = renderCard({
      kind: 'turn-complete',
      source: 'claude-code',
      updatedAt: Date.now() - 3 * 60_000,
      message,
    });

    expect(tooltip.textContent).toBe(`Agent finished a turn3m${message}`);
  });

  it('heads a custom notification with its title', () => {
    const tooltip = renderCard({
      kind: 'generic',
      source: 'custom-hook',
      updatedAt: Date.now(),
      title: 'Review ready',
      body: 'Authentication changes are waiting.',
    });

    expect(tooltip.textContent).toBe('Review readynowAuthentication changes are waiting.');
  });

  it('shows only the heading when the agent said nothing more', () => {
    const tooltip = renderCard({ kind: 'error', source: 'codex', updatedAt: Date.now() });

    expect(tooltip.textContent).toBe('Agent reported an errornow');
  });

  it('leads with the icon a notification gave, in its color when it names one', () => {
    const icon = 'data:image/svg+xml;base64,PHN2Zy8+';
    const attention: WorkspaceAttention = {
      kind: 'generic',
      source: 'custom-hook',
      updatedAt: Date.now(),
      icon,
    };
    const { container, rerender } = render(<AttentionGlyph attention={attention} />);

    expect(container.querySelector('img')).toHaveAttribute('src', icon);

    rerender(<AttentionGlyph attention={{ ...attention, iconColor: 'foreground' }} />);
    const shape = container.querySelector('span')!;
    expect(container.querySelector('img')).toBeNull();
    expect(shape).toHaveClass('text-foreground');
    expect(shape.style.mask).toContain(icon);
  });

  it('keeps the kind glyph for an icon that is not an image data URL', () => {
    const { container } = render(
      <AttentionGlyph
        attention={{
          kind: 'generic',
          source: 'custom-hook',
          updatedAt: Date.now(),
          icon: 'javascript:alert(1)',
        }}
      />
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
