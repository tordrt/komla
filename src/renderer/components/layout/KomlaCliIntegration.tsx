import { CaretRight, Check, Copy } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';

function skillInstallCommand(komlaBasePath: string | null): string | null {
  return komlaBasePath ? `npx skills add "${komlaBasePath}/skills" --skill komla --global` : null;
}

function SkillInstallCommand({ command }: { command: string | null }) {
  const [copyStatus, setCopyStatus] = useState('');

  const copyCommand = async () => {
    if (!command) return;
    try {
      window.api.copyToClipboard(command);
      setCopyStatus('Copied');
    } catch {
      setCopyStatus('Could not copy. Select the command to copy it manually.');
    }
  };

  return (
    <div className="space-y-2">
      {command ? (
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 rounded bg-muted p-2 break-all select-text">
            {command}
          </code>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Copy Komla skill install command"
            onClick={() => void copyCommand()}
          >
            {copyStatus === 'Copied' ? <Check className="size-4" /> : <Copy className="size-4" />}
          </Button>
        </div>
      ) : (
        <p role="status">Loading install command…</p>
      )}
      {copyStatus && (
        <p role="status" className="text-muted-foreground">
          {copyStatus}
        </p>
      )}
    </div>
  );
}

const SKILL_SUMMARY_CLASS =
  'flex w-fit cursor-pointer list-none items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden';

export function KomlaCliIntegration({ komlaBasePath }: { komlaBasePath: string | null }) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">Komla CLI</p>
        <p className="mt-0.5 text-[13px] leading-normal text-muted-foreground">
          Already available in Komla terminals, locally and on SSH hosts. The Komla skill teaches
          your agent to use <code>komla</code> to launch agents, open previews, and manage
          workspaces and settings; turn it on for each agent under Agent integrations.{' '}
          <a
            href={`${window.api.websiteUrl}/komla-cli`}
            className="whitespace-nowrap underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground"
            target="_blank"
            rel="noopener noreferrer"
          >
            Read the CLI docs ↗
          </a>
        </p>
      </div>
      <details className="group text-xs">
        <summary className={SKILL_SUMMARY_CLASS}>
          <CaretRight className="size-3 transition-transform group-open:rotate-90" />
          Install the Komla skill for another agent
        </summary>
        <div className="mt-2 space-y-2">
          <p className="text-muted-foreground">
            Run this in a terminal and choose your agent. Rerun to update it.
          </p>
          <SkillInstallCommand command={skillInstallCommand(komlaBasePath)} />
        </div>
      </details>
    </div>
  );
}
