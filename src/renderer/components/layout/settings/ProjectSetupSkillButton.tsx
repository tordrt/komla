import { Wrench } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { openNewWorkspaceDialog } from '@/stores/dialogs.store';

import { buildProjectSetupPrompt } from '../../../../shared/constants/project-setup-prompt';

export function ProjectSetupSkillButton() {
  const handleLaunch = () => {
    openNewWorkspaceDialog({ prompt: buildProjectSetupPrompt() });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm" onClick={handleLaunch}>
          <Wrench className="mr-2 size-4" />
          Run setup skill
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs text-xs">
        Launch an agent that analyzes the project and recommends setup steps, quick commands, and
        trash cleanup, then edits Komla's settings after you approve.
      </TooltipContent>
    </Tooltip>
  );
}
