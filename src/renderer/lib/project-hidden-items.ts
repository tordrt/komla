import type { AppConfig } from '@/types';

type HiddenConfig = Pick<AppConfig, 'projectHiddenItems'> | null | undefined;

/**
 * Whether the user hid a status bar item or a sidebar panel (`panel:<id>`) in a project, from its
 * right-click menu. Items and panels whose `projects` leave a project out never show there anyway.
 */
export function isHiddenInProject(
  config: HiddenConfig,
  projectId: string | null | undefined,
  key: string
): boolean {
  return Boolean(projectId && config?.projectHiddenItems?.[projectId]?.includes(key));
}

/** The config change that hides an item or panel in a project, or shows it there again. */
export function hiddenInProjectUpdate(
  config: HiddenConfig,
  projectId: string,
  key: string,
  hidden: boolean
): Partial<AppConfig> {
  const { [projectId]: listed = [], ...others } = config?.projectHiddenItems ?? {};
  const rest = listed.filter((item) => item !== key);
  const next = hidden ? [...rest, key] : rest;
  return { projectHiddenItems: next.length ? { ...others, [projectId]: next } : others };
}
