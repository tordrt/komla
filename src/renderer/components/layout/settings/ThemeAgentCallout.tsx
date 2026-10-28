import { Check, Copy, FolderOpen, RocketLaunch } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useBasePath } from '@/hooks/useBasePath';
import { openNewWorkspaceDialog } from '@/stores/dialogs.store';

import { buildAppearancePrompt } from '../../../../shared/constants/appearance-prompt';

export function ThemeAgentCallout() {
  const basePath = useBasePath();
  const [copied, setCopied] = useState(false);

  const prompt = buildAppearancePrompt();
  const separator = window.api.platform === 'win32' ? '\\' : '/';
  const themePath = basePath && [basePath, 'settings', 'theme.json'].join(separator);

  const handleCopy = () => {
    window.api.copyToClipboard(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1">
        <h4 className="text-[13px] font-medium text-foreground">Make your own theme</h4>
        <p className="text-xs text-muted-foreground">
          An agent designs it from your description, and Komla previews it before saving.
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          className="h-7"
          onClick={() => openNewWorkspaceDialog({ prompt })}
        >
          <RocketLaunch className="mr-1.5 size-3.5" />
          Customize with an agent
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="size-7 p-0"
          aria-label={copied ? 'Copied' : 'Copy prompt'}
          title={copied ? 'Copied' : 'Copy prompt'}
          onClick={handleCopy}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="size-7 p-0"
          aria-label="Show file"
          title={themePath ? `Show ${themePath}` : 'Show file'}
          onClick={() => themePath && window.api.showItemInFolder(themePath)}
          disabled={!themePath}
        >
          <FolderOpen className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
