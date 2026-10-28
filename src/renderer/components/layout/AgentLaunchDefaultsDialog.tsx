import { CaretDown, CaretUp } from '@phosphor-icons/react';
import { useState } from 'react';

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
import { Switch } from '@/components/ui/switch';
import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { useAgentLaunchDefaultsDialogStore } from '@/stores/agent-launch-defaults-dialog.store';
import { useConfigStore } from '@/stores/config.store';
import { useToastStore } from '@/stores/toast.store';

import {
  agentCapabilitiesUpdate,
  isAgentCapabilityEnabled,
} from '../../../shared/constants/agent-capabilities';

import { AgentCapabilitiesBlock } from './settings/AgentCapabilitiesBlock';
import { AgentLaunchDefaultsFields } from './settings/AgentLaunchDefaultsCard';
import { KomlaSkillHelp } from './settings/IntegrationHelp';
import { SettingsCard } from './settings/SettingsCard';
import { SettingsRow } from './settings/SettingsRow';

const LAUNCH_CAPABILITIES = ['agent.launch.workspace', 'agent.launch.tab'] as const;

/**
 * Introduces the Komla CLI launch defaults once agents can start other agents, or, from Tips,
 * asks before installing the Komla skill and shows them alongside.
 */
export function AgentLaunchDefaultsDialog() {
  const open = useAgentLaunchDefaultsDialogStore((s) => s.open);
  const installSkill = useAgentLaunchDefaultsDialogStore((s) => s.installSkill);
  const close = useAgentLaunchDefaultsDialogStore((s) => s.close);
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const [installing, setInstalling] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Advanced starts hidden each time the dialog opens.
  const dismiss = () => {
    setShowAdvanced(false);
    close();
  };
  // Advanced, as Settings → Integrations, turns the two launch commands off one by one.
  const launchEnabled = LAUNCH_CAPABILITIES.some((id) =>
    isAgentCapabilityEnabled(id, config ?? {})
  );

  const install = async () => {
    setInstalling(true);
    try {
      await window.api.enableKomlaSkill();
      // The defaults were on show here, so turning on the skill elsewhere needn't show them again.
      void updateConfig({ agentLaunchDefaultsShown: true });
      useToastStore.getState().addToast('Komla skill added', 'success');
      dismiss();
    } catch (err) {
      console.error('Failed to install the Komla skill:', err);
      useToastStore
        .getState()
        .addToast(`Couldn’t install the Komla skill: ${ipcErrorMessage(err)}`, 'error');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {installSkill ? 'Install the Komla skill' : 'Komla CLI launch defaults'}
          </DialogTitle>
          <DialogDescription>
            {installSkill ? (
              <span className="inline-flex items-center gap-1">
                Teaches your agents to use Komla, such as starting other agents.
                <KomlaSkillHelp />
              </span>
            ) : launchEnabled ? (
              'Your agents can now start other agents. Change this anytime in Settings → Integrations.'
            ) : (
              'Your agents can use Komla. Change this anytime in Settings → Integrations.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <SettingsCard>
            <SettingsRow label="Let agents start other agents">
              <Switch
                checked={launchEnabled}
                onCheckedChange={(checked) => {
                  void updateConfig(
                    agentCapabilitiesUpdate(config ?? {}, LAUNCH_CAPABILITIES, checked)
                  );
                }}
              />
            </SettingsRow>
            {launchEnabled && <AgentLaunchDefaultsFields />}
          </SettingsCard>
          <button
            type="button"
            className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? <CaretUp className="size-4" /> : <CaretDown className="size-4" />}
            {showAdvanced ? 'Hide advanced' : 'Show advanced'}
          </button>
          {showAdvanced && (
            <SettingsCard>
              <AgentCapabilitiesBlock
                config={config}
                onToggle={(capabilityId, enabled) => {
                  void updateConfig(agentCapabilitiesUpdate(config ?? {}, [capabilityId], enabled));
                }}
                onSetServerDisabled={(disabled) => {
                  void updateConfig({ disableMcpServer: disabled });
                }}
              />
            </SettingsCard>
          )}
        </DialogBody>
        <DialogFooter>
          {installSkill ? (
            <>
              <Button variant="outline" onClick={dismiss}>
                Cancel
              </Button>
              <Button disabled={installing} onClick={() => void install()}>
                {installing ? 'Installing…' : 'Install skill'}
              </Button>
            </>
          ) : (
            <Button onClick={dismiss}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
