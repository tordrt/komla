/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceTagsCard } from '../../../../../src/renderer/components/layout/settings/WorkspaceTagsCard';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';
import { useConfigStore } from '../../../../../src/renderer/stores/config.store';

import type { WorkspaceTagDefinition } from '../../../../../src/shared/lib/workspace-tags';
import type { AppConfig } from '../../../../../src/shared/types';

const addToast = vi.fn();
vi.mock('../../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: { getState: () => ({ addToast }) },
}));

const updateConfig = vi.fn(async (_updates: Partial<AppConfig>) => ({ ok: true }));

function savedTags(): WorkspaceTagDefinition[] | undefined {
  return updateConfig.mock.lastCall?.[0].workspaceTags;
}

function renderCard(workspaceTags: WorkspaceTagDefinition[]) {
  useConfigStore.setState({
    config: { workspaceTags } as AppConfig,
    updateConfig,
  } as never);
  render(
    <TooltipProvider>
      <WorkspaceTagsCard />
    </TooltipProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WorkspaceTagsCard', () => {
  it("offers no spinner for a tag: work under way is a script's progress", () => {
    renderCard([{ name: 'CI running', tone: 'info' }]);

    expect(screen.queryByRole('button', { name: /spinner|spinning/i })).toBeNull();
  });

  it('takes an image file as the icon, refuses another file, and removes it', async () => {
    renderCard([{ name: 'Deployed', tone: 'success' }]);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, {
      target: { files: [new File(['<svg/>'], 'rocket.svg', { type: 'image/svg+xml' })] },
    });
    await waitFor(() =>
      expect(savedTags()?.[0].icon).toBe(`data:image/svg+xml;base64,${btoa('<svg/>')}`)
    );

    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.txt')] } });
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.any(String), 'error'));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Deployed icon' }));
    expect(savedTags()?.[0].icon).toBeUndefined();
  });
});
