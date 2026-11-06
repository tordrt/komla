import {
  CaretRight,
  Code,
  FolderOpen,
  Layout,
  Lightning,
  SidebarSimple,
  Trash,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { InfoTip } from '@/components/ui/info-tip';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useToastStore } from '@/stores/toast.store';

import { pluginCardId } from './plugin-card';
import { PluginSettingsForm } from './PluginSettingsForm';
import { SettingsCard } from './SettingsCard';

import type { PluginContributionInfo, PluginInfo } from '../../../../shared/types/plugins';
import type { Icon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

/** Electron wraps main-process errors as "Error invoking remote method '<channel>': Error: <message>". */
function ipcErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

const KINDS: Record<PluginContributionInfo['kind'], { label: string; icon: Icon }> = {
  'status-item': { label: 'Status bar item', icon: Layout },
  hook: { label: 'Hook', icon: Lightning },
  'sidebar-panel': { label: 'Sidebar panel', icon: SidebarSimple },
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

  const deletePlugin = async (plugin: PluginInfo): Promise<boolean> => {
    try {
      setPlugins(await window.api.deletePlugin(plugin.folder));
      return true;
    } catch (error) {
      addToast(`Couldn’t delete ${plugin.name}: ${ipcErrorMessage(error)}`, 'error');
      return false;
    }
  };

  const targets = settingsTargets(plugins ?? []);

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
          variant="outline"
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
          No plugins yet. Copy a plugin’s folder, with its komla-plugin.json, into the plugins
          folder.
        </p>
      )}
      {plugins?.map((plugin, index) => (
        <PluginRow
          key={`${plugin.folder}:${plugin.id}`}
          // Where a plugin's page opens Settings.
          cardId={targets.get(plugin.id) === index ? pluginCardId(plugin.id) : undefined}
          plugin={plugin}
          busy={busyIds.has(plugin.id)}
          onToggle={(enabled) => void toggle(plugin, enabled)}
          onDevelopment={(development) => void setDevelopment(plugin, development)}
          onSaveSettings={(changes) => saveSettings(plugin, changes)}
          onDelete={() => deletePlugin(plugin)}
        />
      ))}
    </SettingsCard>
  );
}

/**
 * The row each plugin id opens Settings at, by index: the one Komla can read, as another folder
 * may have the same id, or else the first.
 */
function settingsTargets(plugins: PluginInfo[]): Map<string, number> {
  const targets = new Map<string, number>();
  plugins.forEach((plugin, index) => {
    const current = targets.get(plugin.id);
    if (
      current === undefined ||
      (plugins[current]!.state === 'invalid' && plugin.state !== 'invalid')
    ) {
      targets.set(plugin.id, index);
    }
  });
  return targets;
}

function PluginRow({
  cardId,
  plugin,
  busy,
  onToggle,
  onDevelopment,
  onSaveSettings,
  onDelete,
}: {
  cardId?: string;
  plugin: PluginInfo;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
  onDevelopment: (development: boolean) => void;
  onSaveSettings: (changes: Record<string, string | number | boolean | null>) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const on = plugin.state === 'on';
  const [deleting, setDeleting] = useState(false);
  const commands = pluginCommands(plugin);
  return (
    <div
      id={cardId}
      data-plugin={plugin.id}
      className="scroll-mt-6 space-y-3 rounded-lg transition-shadow duration-300 data-[search-target]:ring-2 data-[search-target]:ring-primary/40"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-1.5 text-sm font-medium">
            <span className="truncate">{plugin.name}</span>
            {plugin.version && (
              <span className="shrink-0 font-mono text-2xs font-normal text-muted-foreground">
                v{plugin.version}
              </span>
            )}
          </p>
          {plugin.description && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {plugin.description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <IconButton
            label={`Delete ${plugin.name}`}
            size="xs"
            className="rounded-md text-muted-foreground hover:bg-error/10 hover:text-error"
            disabled={busy}
            onClick={() => setDeleting(true)}
          >
            <Trash className="size-3.5" />
          </IconButton>
          <Switch
            checked={on}
            disabled={busy || plugin.state === 'invalid'}
            onCheckedChange={onToggle}
            aria-label={`${on ? 'Turn off' : 'Turn on'} ${plugin.name}`}
          />
        </div>
      </div>
      <DeletePluginDialog
        plugin={plugin}
        open={deleting}
        onOpenChange={setDeleting}
        onDelete={onDelete}
      />
      {plugin.state === 'invalid' && (
        <Callout tone="error" size="sm">
          {plugin.folder} {plugin.problem ?? 'can’t be read'}.
        </Callout>
      )}
      {plugin.state === 'changed' && (
        <Callout tone="warning" size="sm">
          Its files changed since you turned it on, so it doesn’t run. Turn it on again to run it as
          it is now.
        </Callout>
      )}
      {(plugin.contributions.length > 0 || plugin.main) && (
        <div className="overflow-hidden rounded-md border border-border/50">
          <ul className="divide-y divide-border/40">
            {plugin.main && <CodeLine plugin={plugin} />}
            {plugin.contributions.map((contribution) => (
              <ContributionLine key={contribution.id} contribution={contribution} />
            ))}
          </ul>
          {commands.length > 0 && (
            <CommandsDisclosure
              commands={commands}
              // What turning it on approves is in view until it's on.
              approving={!on}
            />
          )}
        </div>
      )}
      {plugin.state !== 'invalid' && plugin.settings && plugin.settings.length > 0 && (
        <PluginSettingsForm plugin={plugin} onSave={onSaveSettings} />
      )}
      {on && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            id={`plugin-development-${plugin.id}`}
            className="-mr-1.5 origin-left scale-75"
            checked={Boolean(plugin.development)}
            onCheckedChange={onDevelopment}
            aria-label={`Run ${plugin.name} as its files change`}
          />
          <label htmlFor={`plugin-development-${plugin.id}`}>Development</label>
          <InfoTip ariaLabel="About development">
            Runs its files as they change, without asking again, and its panels can be inspected and
            loaded again. Only for a plugin you’re writing.
          </InfoTip>
        </div>
      )}
    </div>
  );
}

function DeletePluginDialog({
  plugin,
  open,
  onOpenChange,
  onDelete,
}: {
  plugin: PluginInfo;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      if (await onDelete()) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {plugin.name}?</DialogTitle>
          <DialogDescription>
            Its folder, {plugin.folder}, moves to your computer’s trash, and Komla forgets that you
            turned it on and what you set for its settings.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirm()} disabled={busy}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Each command a plugin runs once, with what runs it, as the same one may run for several. */
function pluginCommands(plugin: PluginInfo): { label: string; command: string }[] {
  const seen = new Set<string>();
  const commands: { label: string; command: string }[] = [];
  for (const contribution of plugin.contributions) {
    const title = `${KINDS[contribution.kind].label} ${contribution.title}`;
    const own = [
      ...(contribution.command ? [{ label: title, command: contribution.command }] : []),
      ...(contribution.moreCommands ?? []).map((c) => ({
        label: `${title}, ${c.label}`,
        command: c.command,
      })),
    ];
    for (const entry of own) {
      if (seen.has(entry.command)) continue;
      seen.add(entry.command);
      commands.push(entry);
    }
  }
  return commands;
}

function CommandsDisclosure({
  commands,
  approving,
}: {
  commands: { label: string; command: string }[];
  approving: boolean;
}) {
  const [open, setOpen] = useState(approving);
  // Turning it on or off shows or hides them again.
  const [wasApproving, setWasApproving] = useState(approving);
  if (wasApproving !== approving) {
    setWasApproving(approving);
    setOpen(approving);
  }
  return (
    <div className="border-t border-border/40 bg-muted/20">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen(!open)}
      >
        <CaretRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {commands.length === 1 ? 'The command it runs' : `The ${commands.length} commands it runs`}
      </button>
      {open && (
        <ul className="space-y-2 px-3 pb-2.5">
          {commands.map(({ label, command }) => (
            <li key={command} className="min-w-0">
              <p className="text-[11px] text-muted-foreground">{label}</p>
              <code
                className="mt-0.5 block truncate rounded bg-background/60 px-2 py-1 font-mono text-[11px] text-foreground/80"
                title={command}
              >
                {command}
              </code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const HOST_STATES = {
  starting: 'Starting',
  running: 'Running',
  failed: 'Stopped',
} as const;
const HOST_DOTS = {
  starting: 'bg-warning',
  running: 'bg-success',
  failed: 'bg-error',
} as const;

function Line({
  icon: KindIcon,
  label,
  title,
  aside,
  children,
}: {
  icon: Icon;
  label: string;
  title?: string;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2.5 px-3 py-2 text-xs">
      <KindIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 truncate">
            <span className="text-muted-foreground">{label}</span>
            {title && <span className="ml-1.5 font-medium text-foreground/90">{title}</span>}
          </p>
          {aside && <div className="ml-auto shrink-0">{aside}</div>}
        </div>
        {children}
      </div>
    </li>
  );
}

/** A plugin's code, with how it runs and what it printed last. */
function CodeLine({ plugin }: { plugin: PluginInfo }) {
  const host = plugin.host;
  return (
    <Line
      icon={Code}
      label="Code"
      title={plugin.main}
      aside={
        host && (
          <span
            className={cn(
              'flex items-center gap-1.5 text-[11px] text-muted-foreground',
              host.state === 'failed' && 'text-error'
            )}
            data-plugin-host-state={host.state}
          >
            <span className={cn('size-1.5 rounded-full', HOST_DOTS[host.state])} />
            {HOST_STATES[host.state]}
          </span>
        )
      }
    >
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        While the plugin is on, with what Komla’s operations and your shell can do
      </p>
      {host?.error && <p className="mt-0.5 text-[11px] text-error">{host.error}</p>}
      {host && host.log.length > 0 && (
        <details className="group mt-1 text-[11px] text-muted-foreground">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
            <CaretRight className="size-3 transition-transform group-open:rotate-90" />
            Output
          </summary>
          <pre className="thin-scrollbar mt-1 max-h-40 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap">
            {host.log.join('\n')}
          </pre>
        </details>
      )}
    </Line>
  );
}

function ContributionLine({ contribution }: { contribution: PluginContributionInfo }) {
  const kind = KINDS[contribution.kind];
  return (
    <Line icon={kind.icon} label={kind.label} title={contribution.title}>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {contribution.when}
        {contribution.runOn === 'local' && ', on this computer'}
        {contribution.runOn === 'local-per-workspace' && ', on this computer for each workspace'}
      </p>
      {contribution.page && (
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Page <span className="font-mono">{contribution.page}</span>
          {contribution.capabilities && `, which may use ${contribution.capabilities.join(', ')}`}
        </p>
      )}
    </Line>
  );
}
