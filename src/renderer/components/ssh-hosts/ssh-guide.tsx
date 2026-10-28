import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

type SshGuideSection = 'no-machine';

/** The SSH workspaces guide on the website, optionally opened at one of its sections. */
function sshGuideUrl(section?: SshGuideSection): string {
  return `${window.api.websiteUrl}/remote-workspaces${section ? `#${section}` : ''}`;
}

/** An inline link to the SSH workspaces guide, opened in the browser. */
export function SshGuideLink({
  section,
  className,
  children = 'Setup guide ↗',
}: {
  section?: SshGuideSection;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <a
      href={sshGuideUrl(section)}
      className={cn(
        'underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground',
        className
      )}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}
