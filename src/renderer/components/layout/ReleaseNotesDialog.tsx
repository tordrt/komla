import {
  Warning,
  Bug,
  Download,
  PencilSimple,
  Plus,
  ArrowsClockwise,
  Shield,
  Trash,
} from '@phosphor-icons/react';
import { type ReactNode, useMemo } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { parseChangelog, type ChangelogSection } from '@/lib/parse-changelog';
import { useUpdateStore } from '@/stores/update.store';

export const CATEGORY_CONFIG: Record<string, { icon: React.ElementType; color: string }> = {
  Added: { icon: Plus, color: 'text-success' },
  Changed: { icon: PencilSimple, color: 'text-info' },
  Fixed: { icon: Bug, color: 'text-warning' },
  Removed: { icon: Trash, color: 'text-error' },
  Deprecated: { icon: Warning, color: 'text-warning' },
  Security: { icon: Shield, color: 'text-purple-700 dark:text-purple-400' },
};

/**
 * Render inline markdown (code, bold, links) to React elements.
 */
export function InlineMarkdown({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  // Match: `code`, **bold**, [text](url)
  const re = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[1] !== undefined) {
      parts.push(
        <code key={match.index} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
          {match[1]}
        </code>
      );
    } else if (match[2] !== undefined) {
      parts.push(
        <strong key={match.index} className="font-semibold">
          {match[2]}
        </strong>
      );
    } else if (match[3] !== undefined) {
      parts.push(
        <a
          key={match.index}
          href={match[4]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          {match[3]}
        </a>
      );
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}

export function ChangelogSectionView({ section }: { section: ChangelogSection }) {
  const config = CATEGORY_CONFIG[section.category];
  const Icon = config?.icon;
  const color = config?.color ?? 'text-muted-foreground';

  return (
    <div className="space-y-2">
      <h4 className={`flex items-center gap-1.5 text-sm font-medium ${color}`}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {section.category}
      </h4>
      <ul className="space-y-1 pl-5">
        {section.items.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-foreground">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/70" />
            <span>
              <InlineMarkdown text={item} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Render free-form markdown (for release notes that don't follow
 * the structured changelog format).
 */
export function FreeformMarkdown({ markdown }: { markdown: string }) {
  const blocks: ReactNode[] = [];
  const lines = markdown.split('\n');
  let listItems: string[] = [];
  let blockIndex = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={blockIndex++} className="space-y-1 pl-5">
        {listItems.map((item, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-foreground">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/70" />
            <span>
              <InlineMarkdown text={item} />
            </span>
          </li>
        ))}
      </ul>
    );
    listItems = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Headings
    const h3 = trimmed.match(/^###\s+(.+)/);
    if (h3) {
      flushList();
      const heading = h3[1];
      const config = CATEGORY_CONFIG[heading];
      const Icon = config?.icon;
      const color = config?.color ?? 'text-muted-foreground';
      blocks.push(
        <h4 key={blockIndex++} className={`flex items-center gap-1.5 text-sm font-medium ${color}`}>
          {Icon && <Icon className="h-3.5 w-3.5" />}
          {heading}
        </h4>
      );
      continue;
    }

    const h2 = trimmed.match(/^##\s+(.+)/);
    if (h2) {
      flushList();
      blocks.push(
        <h3 key={blockIndex++} className="text-sm font-semibold text-foreground">
          <InlineMarkdown text={h2[1]} />
        </h3>
      );
      continue;
    }

    // List items
    const li = trimmed.match(/^[-*]\s+(.+)/);
    if (li) {
      listItems.push(li[1]);
      continue;
    }

    // Plain paragraph text
    flushList();
    blocks.push(
      <p key={blockIndex++} className="text-sm text-foreground">
        <InlineMarkdown text={trimmed} />
      </p>
    );
  }

  flushList();
  return <div className="space-y-3">{blocks}</div>;
}

function ChangelogContent({ markdown }: { markdown: string }) {
  const versions = useMemo(() => parseChangelog(markdown), [markdown]);
  const latest = versions[0];

  if (!latest || latest.sections.length === 0) {
    return <FreeformMarkdown markdown={markdown} />;
  }

  return (
    <div className="space-y-4">
      {latest.sections.map((section, i) => (
        <ChangelogSectionView key={i} section={section} />
      ))}
    </div>
  );
}

interface ReleaseNotesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReleaseNotesDialog({ open, onOpenChange }: ReleaseNotesDialogProps) {
  const {
    status,
    version,
    releaseNotes,
    releaseName,
    downloadUpdate,
    installUpdate,
    openDownload,
  } = useUpdateStore();

  const handleDownload = () => {
    downloadUpdate();
    onOpenChange(false);
  };

  const handleOpenDownload = () => {
    openDownload();
    onOpenChange(false);
  };

  const handleInstall = () => {
    installUpdate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[70vh] max-w-lg">
        <DialogHeader>
          <DialogTitle>{releaseName ? releaseName : `Komla v${version}`}</DialogTitle>
          <DialogDescription>
            {releaseName ? `Version ${version}` : 'A new version is available'}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {releaseNotes ? (
            <ChangelogContent markdown={releaseNotes} />
          ) : (
            <p className="text-sm text-muted-foreground">
              No release notes available for this version.
            </p>
          )}
        </DialogBody>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {status === 'available' && (
            <Button onClick={handleDownload}>
              <Download className="mr-1.5 h-4 w-4" />
              Download
            </Button>
          )}
          {status === 'manual' && (
            <Button onClick={handleOpenDownload}>
              <Download className="mr-1.5 h-4 w-4" />
              Download
            </Button>
          )}
          {status === 'ready' && (
            <Button onClick={handleInstall}>
              <ArrowsClockwise className="mr-1.5 h-4 w-4" />
              Restart to Update
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
