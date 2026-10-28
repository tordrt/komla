import { Check, Copy, RocketLaunch } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { openNewWorkspaceDialog, type NewWorkspaceDialogPrefill } from '@/stores/dialogs.store';

interface OtherAgentCalloutProps {
  integrationPrompt: string | null | undefined;
  agentName?: string;
  className?: string;
  launchButtonTone?: 'primary' | 'subtle';
  workspacePrefill?: NewWorkspaceDialogPrefill;
  /** Setup launched here is for this computer, so a later local launch needs no nudge to set up. */
  setsUpThisComputer?: boolean;
}

export function OtherAgentCallout({
  integrationPrompt,
  agentName,
  className,
  launchButtonTone = 'primary',
  workspacePrefill,
  setsUpThisComputer = false,
}: OtherAgentCalloutProps) {
  const [copied, setCopied] = useState(false);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  const handleCopy = () => {
    if (!integrationPrompt) return;
    window.api.copyToClipboard(integrationPrompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLaunch = () => {
    if (!integrationPrompt) return;
    // The agent launched for setup needs no nudge to set itself up.
    if (setsUpThisComputer) void updateConfig({ selfSetupNudgePending: false });
    openNewWorkspaceDialog({ prompt: integrationPrompt, prefill: workspacePrefill });
  };

  const heading = agentName
    ? `No prebuilt one-click integration for ${agentName} yet?`
    : 'No prebuilt one-click integration for your agent yet?';

  return (
    <Callout tone="info" className={cn('gap-2.5 p-3', className)}>
      <div className="space-y-2.5">
        <h4 className="text-sm font-medium">{heading}</h4>
        <p className="text-[13px] leading-relaxed">
          Sorry — we haven't shipped a turnkey setup. But if your agent supports lifecycle hooks,
          chances are it can integrate itself: launch it into a workspace running the
          self-integration skill and it'll investigate its own config surface and wire up Komla's
          hooks and MCP server.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={launchButtonTone === 'subtle' ? 'outline' : 'default'}
            size="sm"
            className={
              launchButtonTone === 'subtle'
                ? 'h-8 border-info/30 text-info hover:bg-info/10'
                : 'h-8'
            }
            onClick={handleLaunch}
            disabled={!integrationPrompt}
          >
            <RocketLaunch className="mr-1.5 size-3.5" />
            Launch self-integration skill
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 border-info/30 text-info hover:bg-info/20"
            onClick={handleCopy}
            disabled={!integrationPrompt}
          >
            {copied ? (
              <>
                <Check className="mr-1.5 size-3.5" />
                Copied
              </>
            ) : (
              <>
                <Copy className="mr-1.5 size-3.5" />
                Copy integration prompt
              </>
            )}
          </Button>
        </div>
      </div>
    </Callout>
  );
}
