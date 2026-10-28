/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ActionsTab } from '../../../../../src/renderer/components/layout/settings/ActionsTab';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';
import { useActionEditorStore } from '../../../../../src/renderer/stores/action-editor.store';

vi.mock('../../../../../src/renderer/stores/actions.store', () => ({
  useActionsStore: () => ({
    actions: [],
    loadActions: vi.fn(),
    reorderAction: vi.fn(),
    deleteAction: vi.fn(),
  }),
}));

vi.mock('../../../../../src/renderer/stores/projects.store', () => ({
  useProjectsStore: () => ({ projects: [] }),
}));

vi.mock('../../../../../src/renderer/stores/agent-presets.store', () => ({
  useAgentPresetsStore: () => ({ presets: [], loadPresets: vi.fn() }),
}));

vi.mock('../../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: (selector: (state: { addToast: () => void }) => unknown) =>
    selector({ addToast: vi.fn() }),
}));

describe('ActionsTab', () => {
  it('opens the editor for a global action from the empty state', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <ActionsTab onClose={vi.fn()} />
      </TooltipProvider>
    );

    expect(screen.getByText('No quick commands yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New quick command' }));

    // Settings has no workspace to imply a project, so the scope choice opens in view.
    expect(useActionEditorStore.getState().request).toEqual({
      actionId: null,
      advancedOpen: true,
    });
  });
});
