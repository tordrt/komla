export interface ChangelogSection {
  category: string;
  items: string[];
}

export interface ChangelogVersion {
  version: string;
  date: string | null;
  sections: ChangelogSection[];
}

const VERSION_RE = /^## \[(.+?)\](?:\s*-\s*(.+))?/;
const CATEGORY_RE = /^### (.+)/;
const ITEM_RE = /^[-*]\s+(.+)/;

export function parseChangelog(markdown: string): ChangelogVersion[] {
  const versions: ChangelogVersion[] = [];
  let current: ChangelogVersion | null = null;
  let currentSection: ChangelogSection | null = null;

  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();

    const versionMatch = trimmed.match(VERSION_RE);
    if (versionMatch) {
      current = {
        version: versionMatch[1],
        date: versionMatch[2]?.trim() || null,
        sections: [],
      };
      versions.push(current);
      currentSection = null;
      continue;
    }

    if (!current) continue;

    const categoryMatch = trimmed.match(CATEGORY_RE);
    if (categoryMatch) {
      currentSection = { category: categoryMatch[1], items: [] };
      current.sections.push(currentSection);
      continue;
    }

    const itemMatch = trimmed.match(ITEM_RE);
    if (itemMatch && currentSection) {
      currentSection.items.push(itemMatch[1]);
    }
  }

  return versions;
}
