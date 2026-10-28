import { useEffect } from 'react';

import { getActivePalette, subscribePalette } from '@/lib/palette-runtime';
import { primaryForMode } from '@/lib/primary-color';
import { colorToOklchValues, getProjectColor } from '@/lib/project-colors';
import { useProjectsStore } from '@/stores/projects.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

/** Applies the selected workspace's project color as the accent of the sidebar and main area. */
export function useProjectAccent(sidebar: HTMLElement | null, main: HTMLElement | null): void {
  // Strings, so the many updates to workspaces and projects don't re-render App.
  const projectId = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.projectId
  );
  const hslColor = useProjectsStore((s) => {
    const project = projectId ? s.projects.find((p) => p.id === projectId) : undefined;
    return project ? project.color || getProjectColor(project.name) : null;
  });

  // These variables are inherited, so every write restyles everything in the sidebar and main
  // area. Run only when the color or an element changes, and overwrite instead of removing first.
  useEffect(() => {
    const elements = [sidebar, main].filter((el) => el !== null);
    const oklchValues = hslColor ? colorToOklchValues(hslColor) : null;
    if (!oklchValues) {
      for (const el of elements) {
        el.style.removeProperty('--primary');
        el.style.removeProperty('--ring');
        el.style.removeProperty('--dark-primary');
      }
      return;
    }

    const applyProjectColor = () => {
      const primary = primaryForMode(oklchValues, getActivePalette().mode);
      const darkPrimary = primaryForMode(oklchValues, 'dark');
      for (const el of elements) {
        el.style.setProperty('--primary', primary);
        el.style.setProperty('--ring', primary);
        el.style.setProperty('--dark-primary', darkPrimary);
      }
    };
    applyProjectColor();
    return subscribePalette(applyProjectColor);
  }, [hslColor, sidebar, main]);
}
