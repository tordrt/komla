export type OpenSettingsDetail = string | { tab?: string; section?: string } | undefined;

export interface OpenSettingsTarget {
  tab: string | undefined;
  generalSection: string | undefined;
}

export function resolveOpenSettingsTarget(detail: OpenSettingsDetail): OpenSettingsTarget {
  if (typeof detail === 'string') {
    return { tab: detail, generalSection: undefined };
  }
  if (detail) {
    return {
      tab: detail.tab ?? (detail.section ? 'general' : undefined),
      generalSection: detail.section,
    };
  }
  return { tab: undefined, generalSection: undefined };
}

export function resolveSettingsPage(
  tab: string | undefined,
  generalSection: string | undefined
): string | undefined {
  if (generalSection === 'terminal') return 'terminal';
  if (generalSection === 'voice') return 'voice';
  if (generalSection) return 'general';
  return tab;
}
