import { useMemo } from 'react';

import changelogRaw from '../../../../../CHANGELOG.md?raw';
import { FreeformMarkdown } from '../ReleaseNotesDialog';

interface ChangelogVersion {
  title: string;
  body: string;
}

function parseVersions(markdown: string): ChangelogVersion[] {
  const versions: ChangelogVersion[] = [];
  // Split on ## headings; first element is preamble before any ## heading
  const [, ...parts] = markdown.split(/^## /m);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const newlineIndex = trimmed.indexOf('\n');
    if (newlineIndex === -1) {
      versions.push({ title: trimmed, body: '' });
    } else {
      versions.push({
        title: trimmed.slice(0, newlineIndex).trim(),
        body: trimmed.slice(newlineIndex + 1).trim(),
      });
    }
  }

  return versions;
}

interface ChangelogTabProps {
  onClose: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
}

export function ChangelogTab({
  onClose: _onClose,
  onDirtyChange: _onDirtyChange,
}: ChangelogTabProps) {
  const versions = useMemo(() => parseVersions(changelogRaw), []);

  return (
    <div className="space-y-6">
      {versions.map((version) => (
        <div
          key={version.title}
          className="space-y-3 rounded-xl border border-border/50 bg-card/70 p-5 shadow-xs"
        >
          <span className="block text-[13px] font-semibold text-foreground">{version.title}</span>
          {version.body && <FreeformMarkdown markdown={version.body} />}
        </div>
      ))}

      {versions.length === 0 && (
        <p className="text-sm text-muted-foreground">No changelog entries found.</p>
      )}
    </div>
  );
}
