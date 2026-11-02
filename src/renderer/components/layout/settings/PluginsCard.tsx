import { FolderOpen } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toast.store';

import { PluginSettingsForm } from './PluginSettingsForm';
import { SettingsCard } from './SettingsCard';

import type { PluginContributionInfo, PluginInfo } from '../../../../shared/types/plugins';

/** Electron wraps main-process errors as "Error invoking remote method '<channel>': Error: <message>". */
function ipcErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

const KIND_LABELS: Record<PluginContributionInfo['kind'], string> = {
  'status-item': 'Status bar item',
  hook: 'Hook',
  'sidebar-panel': 'Sidebar panel',
};

/**
 * The plugins in the plugins folder, each with every command it runs beside its switch, so turning
 * one on here is the user's approval of them.
 */
export function PluginsCard() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const addToast = useToastStore((state) => state.addToast);

  useEffect(() => {
    void window.api.listPlugins().then(setPlugins);
    return window.api.onPluginsChange(setPlugins);
  }, []);

  const setDevelopment = async (plugin: PluginInfo, development: boolean) => {
    try {
      setPlugins(await window.api.setPluginDevelopment(plugin.id, development));
    } catch (error) {
      addToast(`Couldn’t change ${plugin.name}: ${ipcErrorMessage(error)}`, 'error');
    }
  };

  const saveSettings = async (
    plugin: PluginInfo,
    changes: Record<string, string | number | boolean | null>
  ): Promise<boolean> => {
    try {
      setPlugins(await window.api.setPluginSettings(plugin.id, changes));
      return true;
    } catch (error) {
      addToast(`Couldn’t save ${plugin.name}’s settings: ${ipcErrorMessage(error)}`, 'error');
      return false;
    }
  };

  const toggle = async (plugin: PluginInfo, enabled: boolean) => {
    // Only a plugin Komla can read has a digest, and only those can be switched on.
    if (enabled && !plugin.digest) return;
    setBusyIds((ids) => new Set(ids).add(plugin.id));
    try {
      setPlugins(await window.api.setPluginEnabled(plugin.id, enabled ? plugin.digest! : false));
    } catch (error) {
      addToast(
        `Couldn’t turn ${enabled ? 'on' : 'off'} ${plugin.name}: ${ipcErrorMessage(error)}`,
        'error'
      );
    } finally {
      setBusyIds((ids) => {
        const next = new Set(ids);
        next.delete(plugin.id);
        return next;
      });
    }
  };

  return (
    <SettingsCard
      title="Plugins"
      description="Status bar items, sidebar panels, hooks and code bundled as a folder in the plugins folder, to share and turn on or off as one. A plugin runs what’s below only while it’s on, and stops when its files change until you turn it on again."
      action={
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={() => void window.api.openPluginsFolder()}
        >
          <FolderOpen className="size-3.5" />
          Open plugins folder
        </Button>
      }
    >
      {plugins?.length === 0 && (
        <p className="!py-3 !pl-4 text-xs text-muted-foreground">
          No plugins yet. Copy or clone a plugin’s folder, with its komla-plugin.json, into the
          plugins folder.
        </p>
      )}
      {plugins?.map((plugin) => (
        <PluginRow
          key={`${plugin.folder}:${plugin.id}`}
          plugin={plugin}
          busy={busyIds.has(plugin.id)}
          onToggle={(enabled) => void toggle(plugin, enabled)}
          onDevelopment={(development) => void setDevelopment(plugin, development)}
          onSaveSettings={(changes) => saveSettings(plugin, changes)}
        />
      ))}
    </SettingsCard>
  );
}

function PluginRow({
  plugin,
  busy,
  onToggle,
  onDevelopment,
  onSaveSettings,
}: {
  plugin: PluginInfo;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onDevelopment: (development: boolean) => void;
  onSaveSettings: (changes: Record<string, string | number | boolean | null>) => Promise<boolean>;
}) {
  const on = plugin.state === 'on';
  return (
    <div className="flex items-start gap-3 !py-3 !pl-4">
      <Switch
        className="mt-0.5"
        checked={on}
        disabled={busy || plugin.state === 'invalid'}
        onCheckedChange={onToggle}
        aria-label={`${on ? 'Turn off' : 'Turn on'} ${plugin.name}`}
      />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="space-y-0.5">
          <p className={cn('truncate text-sm font-medium', !on && 'text-muted-foreground')}>
            {plugin.name}
            {plugin.version && (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {plugin.version}
              </span>
            )}
          </p>
          {plugin.description && (
            <p className="text-xs text-muted-foreground">{plugin.description}</p>
          )}
        </div>
        {plugin.state === 'invalid' && (
          <Callout tone="error" size="sm">
            {plugin.folder} {plugin.problem ?? 'can’t be read'}.
          </Callout>
        )}
        {plugin.state === 'changed' && (
          <Callout tone="warning" size="sm">
            Its files changed since you turned it on, so it doesn’t run. Turn it on again to run it
            as it is now.
          </Callout>
        )}
        {(plugin.contributions.length > 0 || plugin.main) && (
          <ul className="space-y-1">
            {plugin.main && <CodeLine plugin={plugin} />}
            {plugin.contributions.map((contribution) => (
              <ContributionLine key={contribution.id} contribution={contribution} />
            ))}
          </ul>
        )}
        {plugin.state !== 'invalid' && plugin.settings && plugin.settings.length > 0 && (
          <PluginSettingsForm plugin={plugin} onSave={onSaveSettings} />
        )}
        {on && (
          <label className="flex items-start gap-2 pt-1 text-xs text-muted-foreground">
            <Switch
              className="mt-0.5 scale-75"
              checked={Boolean(plugin.development)}
              onCheckedChange={onDevelopment}
              aria-label={`Run ${plugin.name} as its files change`}
            />
            <span>
              <span className="text-foreground/80">Development</span> · Runs its files as they
              change, without asking again, and its panels can be inspected and loaded again. Only
              for a plugin you’re writing.
            </span>
          </label>
        )}
      </div>
    </div>
  );
}

const HOST_STATES = { starting: 'Starting', running: 'Running', failed: 'Stopped' } as const;

/** A plugin's code, with how it runs and what it printed last. */
function CodeLine({ plugin }: { plugin: PluginInfo }) {
  const host = plugin.host;
  return (
    <li className="text-xs text-muted-foreground">
      <span className="text-foreground/80">Code {plugin.main}</span>
      <span aria-hidden="true"> · </span>
      While the plugin is on, with what Komla’s operations and your shell can do
      {host && (
        <span
          className={cn('block', host.state === 'failed' && 'text-destructive')}
          data-plugin-host-state={host.state}
        >
          {HOST_STATES[host.state]}
          {host.error && `: ${host.error}`}
        </span>
      )}
      {host && host.log.length > 0 && (
        <details className="mt-0.5">
          <summary className="cursor-pointer select-none">Output</summary>
          <pre className="thin-scrollbar mt-1 max-h-40 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap">
            {host.log.join('\n')}
          </pre>
        </details>
      )}
    </li>
  );
}

function ContributionLine({ contribution }: { contribution: PluginContributionInfo }) {
  const commands = [
    ...(contribution.command ? [contribution.command] : []),
    ...(contribution.moreCommands ?? []).map((c) => c.command),
  ];
  return (
    <li className="text-xs text-muted-foreground">
      <span className="text-foreground/80">
        {KIND_LABELS[contribution.kind]} {contribution.title}
      </span>
      <span aria-hidden="true"> · </span>
      {contribution.when}
      {contribution.runOn === 'local' && ', on this computer'}
      {contribution.page && (
        <span className="block">
          Page {contribution.page}
          {contribution.capabilities && `, which may use ${contribution.capabilities.join(', ')}`}
        </span>
      )}
      {commands.map((command, index) => (
        <code
          key={index}
          className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground-90"
          title={command}
        >
          {command}
        </code>
      ))}
    </li>
  );
}
