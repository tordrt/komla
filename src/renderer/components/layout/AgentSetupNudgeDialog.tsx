import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { reportsOwnStatus } from '@/lib/agent-status-reports';
import { useAgentSetupNudgeStore } from '@/stores/agent-setup-nudge.store';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';

/**
 * Points a new user's first launch of an agent that can't notify Komla yet at its setup.
 * `blocked` holds it back while another dialog, such as New Workspace, is still open.
 */
export function AgentSetupNudgeDialog({ blocked = false }: { blocked?: boolean }) {
  const open = useAgentSetupNudgeStore((s) => s.open);
  const nudge = useAgentSetupNudgeStore((s) => s.nudge);
  const dismiss = useAgentSetupNudgeStore((s) => s.dismiss);
  if (!nudge) return null;
  const { agent, kind, section } = nudge;

  return (
    <Dialog
      open={open && !blocked}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AgentPresetIcon preset={agent} className="size-4 shrink-0" />
            {kind === 'notifications'
              ? `Turn on ${agent.name} hooks`
              : `Let ${agent.name} connect itself to Komla`}
          </DialogTitle>
          <DialogDescription>
            {kind === 'self-setup'
              ? `Know when ${agent.name} finishes or needs you, and keep every workspace named after what you’re working on. ${agent.name} has no one-click setup: in Settings → Integrations, launch the self-integration skill and ${agent.name} wires up Komla’s hooks, MCP and workspace trust itself, asking before it changes anything.`
              : reportsOwnStatus(section)
                ? `Keep every workspace named after what you’re working on in ${agent.name}, and see done only once ${agent.name} has really finished. Turn its hooks on in Settings → Integrations.`
                : `Know when ${agent.name} finishes or needs you, and keep every workspace named after what you’re working on. Turn its hooks on in Settings → Integrations.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={dismiss}>
            Not now
          </Button>
          <Button
            onClick={() => {
              dismiss();
              useSettingsDialogStore.getState().openSettings({
                tab: 'integrations',
                integrationSection: section,
                ...(kind === 'self-setup' && { selfSetupPresetId: agent.id }),
              });
            }}
          >
            Open Integrations
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
