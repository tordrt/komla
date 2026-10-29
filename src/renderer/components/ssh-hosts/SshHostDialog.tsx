import { CaretDown, CheckCircle, Info, Plus, Trash, Warning, XCircle } from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { offerAgentLaunchDefaults } from '@/stores/agent-launch-defaults-dialog.store';
import { useConfigStore } from '@/stores/config.store';
import { useSshHostProjectsDialogStore } from '@/stores/ssh-host-projects-dialog.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import {
  isSshWorkspace,
  type SshConfigHost,
  type SshHost,
  type SshHostSetupResult,
  type SshIntegrationStatus,
  type SshPortForwardStatus,
} from '@/types';

import { FormError } from '../layout/settings/FormError';
import { RemoteAgentIntegrationsPanel } from '../layout/settings/RemoteAgentIntegrationsPanel';

import { SshGuideLink } from './ssh-guide';
import {
  applySshHostInput,
  capabilitySnapshot,
  createPortForwardId,
  draftToHost,
  EMPTY_DRAFT,
  hostToDraft,
  savedHostChangeError,
  setupRequirementsMet,
  validateDraft,
  type HostDraft,
  type PortForwardDraft,
} from './ssh-host-draft';
import {
  addedConfigAliases,
  SshConfigHostPicker,
  sshConfigHostSummary,
} from './SshConfigHostPicker';
import { SshHostChecklist } from './SshHostChecklist';

import type { SshHostProject } from '../../../shared/types/ssh-project-manifest';
import type { SshHostDialogRequest } from '@/stores/ssh-host-dialog.store';

type SetupState = 'idle' | 'checking' | 'checked' | 'preparing' | 'error';
type View = 'form' | 'config' | 'ready';

// Check results and errors land below the fold of a long form, so they scroll into view.
const revealOnMount = (node: HTMLElement | null) =>
  node?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });

interface SshHostDialogProps {
  request: SshHostDialogRequest;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Adds or edits an SSH host: connection details, a check, setup, then agent integrations. */
export function SshHostDialog({ request, open, onOpenChange }: SshHostDialogProps) {
  const addToast = useToastStore((s) => s.addToast);
  const hosts = useSshHostsStore((s) => s.hosts);
  const saveHost = useSshHostsStore((s) => s.saveHost);
  const beginPendingSetup = useSshHostsStore((s) => s.beginPendingSetup);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  const startingConfigHost = request.kind === 'add' ? request.configHost : undefined;
  const [initialDraft] = useState<HostDraft>(() => {
    const host =
      request.kind === 'edit' ? hosts.find((candidate) => candidate.id === request.hostId) : null;
    if (host) return hostToDraft(host);
    return startingConfigHost ? withConfigHost(EMPTY_DRAFT, startingConfigHost) : EMPTY_DRAFT;
  });
  const [draft, setDraft] = useState(initialDraft);
  const [view, setView] = useState<View>(() => (request.kind === 'ready' ? 'ready' : 'form'));
  const [readyHostId, setReadyHostId] = useState(() =>
    request.kind === 'ready' ? request.hostId : null
  );
  const [readyStatus, setReadyStatus] = useState<SshIntegrationStatus | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(() =>
    Boolean(
      initialDraft.identityFile || initialDraft.extraSshArgs || initialDraft.portForwards.length > 0
    )
  );
  const [setupState, setSetupState] = useState<SetupState>('idle');
  const [setupResult, setSetupResult] = useState<(SshHostSetupResult & { hostId: string }) | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  // Bumped by each check, setup and edit, so each reports only on the details it was given.
  const checkAttempt = useRef(0);
  const [saving, setSaving] = useState(false);
  const configHosts = useSshConfigHosts();
  const [configAlias, setConfigAlias] = useState(startingConfigHost?.alias ?? null);
  const returnFocus = useReturnFocus();
  // The integrations step holds the launch defaults until the dialog has closed, rather than
  // stacking them on it: a first host's setup is pending until then, and the defaults can't pin
  // agents to a pending host. An integration that finishes turning on after the close offers them.
  const launchDefaultsHeld = useRef(false);
  const closed = useRef(false);
  const offerLaunchDefaults = () => {
    if (useSshHostsStore.getState().hosts.some((host) => host.id === readyHostId)) {
      offerAgentLaunchDefaults();
    }
  };

  const isEdit = draft.id !== null;
  const isDirty = JSON.stringify(draft) !== JSON.stringify(initialDraft);
  const readyHost = hosts.find((host) => host.id === readyHostId);
  const workspaceCount = useWorkspacesStore((s) =>
    draft.id
      ? s.workspaces.filter(
          (workspace) => isSshWorkspace(workspace) && workspace.backend.hostId === draft.id
        ).length
      : 0
  );
  const locksConnectionIdentity = workspaceCount > 0;
  const canSetUp = canSetUpAfter(setupState, setupResult);
  const preparing = setupState === 'preparing';
  const busy = isBusy(setupState);
  const portForwardStatus = usePortForwardStatus(draft, open);

  const updateDraft = <K extends keyof HostDraft>(key: K, value: HostDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    checkAttempt.current += 1;
    setSetupState('idle');
    setSetupResult(null);
  };

  const validateHostForSetup = (candidate: HostDraft) => {
    const existingHost = candidate.id ? hosts.find((host) => host.id === candidate.id) : undefined;
    const host = draftToHost(candidate, setupResult?.hostId);
    const validationError =
      savedHostChangeError(candidate, existingHost, locksConnectionIdentity) ??
      validateDraft(candidate, host.id);
    if (validationError) {
      setError(validationError);
      return null;
    }
    return { host, existingHost };
  };

  const checkHost = async (candidate: HostDraft) => {
    const validated = validateHostForSetup(candidate);
    if (!validated) return;
    const attempt = ++checkAttempt.current;
    setSetupState('checking');
    setSetupResult(null);
    setError(null);
    try {
      const result = await window.api.verifySshHost(validated.host);
      if (attempt !== checkAttempt.current) return;
      setSetupResult({ ...result, hostId: validated.host.id });
      setSetupState('checked');
    } catch (verifyError) {
      if (attempt !== checkAttempt.current) return;
      setSetupState('error');
      setError((verifyError as Error).message || 'Failed to check SSH host.');
    }
  };

  const prepareHost = async (candidate: HostDraft) => {
    const validated = validateHostForSetup(candidate);
    if (!validated) return;
    const { host, existingHost } = validated;
    const isFirstHost = !candidate.id && hosts.length === 0;
    const attempt = ++checkAttempt.current;
    setSetupState('preparing');
    setError(null);
    if (isFirstHost) beginPendingSetup();

    try {
      const result = await window.api.verifySshHost(host, { prepare: true });
      if (!result.prepared) {
        setSetupResult({ ...result, hostId: host.id });
        setSetupState('checked');
        return;
      }
      const configuredHost: SshHost = {
        ...host,
        basePath: existingHost?.basePath ?? result.resolvedBasePath,
        capabilities: capabilitySnapshot(result),
        // The first host stays pending until its integrations step closes.
        ...(isFirstHost ? { setupPending: true } : {}),
      };
      const saved = await saveHost(configuredHost);
      if (!saved.ok) {
        setError(saved.error ?? 'Failed to save SSH host.');
        setSetupState('error');
        return;
      }
      if (existingHost) {
        addToast('SSH host saved', 'success');
        onOpenChange(false);
        return;
      }

      void window.api.trackSshHostAdded(request.kind === 'add' ? request.source : 'settings');
      // New workspaces start on a newly added host until another environment is picked.
      if (!isFirstHost) {
        void updateConfig({ lastWorkspaceEnvironment: { kind: 'ssh', hostId: configuredHost.id } });
      }
      if (request.kind === 'add') request.onAdded?.(configuredHost.id);
      setReadyStatus(await window.api.getSshIntegrationStatus(configuredHost.id).catch(() => null));
      setReadyHostId(configuredHost.id);
      setSetupState('idle');
      setView('ready');
    } catch (verifyError) {
      if (attempt !== checkAttempt.current) return;
      setSetupState('error');
      setSetupResult(null);
      setError((verifyError as Error).message || 'Failed to configure SSH host.');
    }
  };

  /** Resolves to whether setup finished and the dialog closed. */
  const finishSetup = async (): Promise<boolean> => {
    if (readyHost?.setupPending) {
      setSaving(true);
      try {
        const saved = await saveHost({ ...readyHost, setupPending: false });
        if (!saved.ok) {
          setError(saved.error ?? 'Failed to complete SSH setup.');
          return false;
        }
      } finally {
        setSaving(false);
      }
    }
    onOpenChange(false);
    return true;
  };

  const openConfigPicker = () => {
    setView('config');
    configHosts.load();
  };

  const pickConfigHost = (configHost: SshConfigHost) => {
    setDraft((current) => withConfigHost(current, configHost));
    setConfigAlias(configHost.alias);
    setSetupState('idle');
    setSetupResult(null);
    setError(null);
    setView('form');
  };

  // A click outside shouldn't throw away typed details, details the opener filled in, or a
  // check in progress.
  const hasDetails = isDirty || startingConfigHost !== undefined;
  const guardOutsideDismiss = (event: Event) => {
    if (busy || (view !== 'ready' && hasDetails)) event.preventDefault();
  };
  // Escape in the ~/.ssh/config list goes back to the form, like Back.
  const handleEscape = (event: KeyboardEvent) => {
    if (view !== 'config') return;
    event.preventDefault();
    setView('form');
  };

  // The entry the dialog started from still describes its alias if reading the file fails.
  const hostHint = configAliasHint(
    configAlias,
    draft.hostname,
    startingConfigHost ? [...(configHosts.hosts ?? []), startingConfigHost] : configHosts.hosts
  );
  const fromConfig = hostHint !== undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Setup changes the machine and saves the host, so it finishes before the dialog closes.
        if (next || !preparing) onOpenChange(next);
      }}
    >
      <DialogContent
        className="flex max-w-xl flex-col"
        onInteractOutside={guardOutsideDismiss}
        onEscapeKeyDown={handleEscape}
        onCloseAutoFocus={(event) => {
          returnFocus(event);
          closed.current = true;
          if (launchDefaultsHeld.current) offerLaunchDefaults();
          launchDefaultsHeld.current = false;
        }}
      >
        {view === 'ready' ? (
          <ReadyStep
            host={readyHost}
            status={readyStatus}
            error={error}
            saving={saving}
            onLaunchIntegrationChange={(on) => {
              if (on && closed.current) offerLaunchDefaults();
              else launchDefaultsHeld.current = on;
            }}
            onDone={() => void finishSetup()}
            onImportProjects={(hostId) => {
              void finishSetup().then((done) => {
                if (done) useSshHostProjectsDialogStore.getState().openFor(hostId);
              });
            }}
          />
        ) : view === 'config' ? (
          <SshConfigHostPicker
            hosts={configHosts.hosts}
            error={configHosts.error}
            addedAliases={addedConfigAliases(configHosts.hosts, hosts)}
            onPick={pickConfigHost}
            onBack={() => setView('form')}
          />
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              // Enter submits without leaving the host field, so a pasted address splits here too.
              const submitted = applySshHostInput(draft);
              setDraft(submitted);
              void (canSetUp ? prepareHost(submitted) : checkHost(submitted));
            }}
          >
            <FormHeader isEdit={isEdit} name={initialDraft.name} />

            <DialogBody className="space-y-5">
              {/* Setup uses the details it started with, so they can't change while it runs. */}
              <fieldset disabled={preparing} className="min-w-0 space-y-5">
                <ConnectionFields
                  draft={draft}
                  onChange={updateDraft}
                  onHostBlur={() => setDraft(applySshHostInput)}
                  hostHint={hostHint}
                  fromConfig={fromConfig}
                  isEdit={isEdit}
                  workspaceCount={workspaceCount}
                />
                <ForwardAgentRow
                  checked={draft.forwardAgent}
                  isEdit={isEdit}
                  onCheckedChange={(checked) => updateDraft('forwardAgent', checked)}
                />
                <IsolatedHostRow
                  checked={draft.isolated}
                  onCheckedChange={(checked) => updateDraft('isolated', checked)}
                />
                <AdvancedOptions
                  draft={draft}
                  onChange={updateDraft}
                  expanded={showAdvanced}
                  onExpandedChange={setShowAdvanced}
                  isEdit={isEdit}
                  fromConfig={fromConfig}
                  locked={locksConnectionIdentity}
                  portForwardStatus={portForwardStatus}
                  unsaved={isDirty}
                />
              </fieldset>

              <div role="status" aria-live="polite">
                <CheckStatus
                  setupState={setupState}
                  result={setupResult}
                  hostname={draft.hostname.trim()}
                  isEdit={isEdit}
                />
              </div>

              <RevealedError message={error} />
            </DialogBody>

            <FormFooter
              isEdit={isEdit}
              setupState={setupState}
              canSetUp={canSetUp}
              onFillFromConfig={openConfigPicker}
              onCancel={() => onOpenChange(false)}
            />
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Gives focus back to what had it at open: with no Radix trigger, it would land on the page. */
function useReturnFocus() {
  const [openedFrom] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  );
  return (event: Event) => {
    if (!openedFrom?.isConnected) return;
    event.preventDefault();
    openedFrom.focus();
  };
}

// ssh reads the alias's settings from the file, so the alias is all Komla needs.
const withConfigHost = (draft: HostDraft, configHost: SshConfigHost): HostDraft => ({
  ...draft,
  name: configHost.alias,
  hostname: configHost.alias,
  user: '',
  port: '',
  identityFile: '',
});

/** The Host entries in ~/.ssh/config, read each time the picker opens. */
function useSshConfigHosts() {
  const [hosts, setHosts] = useState<SshConfigHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    window.api
      .listSshConfigHosts()
      .then(setHosts)
      .catch((readError: unknown) => {
        setHosts([]);
        setError((readError as Error).message || 'Could not read ~/.ssh/config.');
      });
  };
  return { hosts, error, load };
}

/** A saved host's port forward tunnel, polled while the dialog is open. */
function usePortForwardStatus(draft: HostDraft, open: boolean) {
  const [status, setStatus] = useState<SshPortForwardStatus | null>(null);
  const hostId = draft.id;
  const active = open && draft.portForwards.length > 0;
  useEffect(() => {
    if (!active || !hostId) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void window.api
        .getSshPortForwardStatus(hostId)
        .then((next: SshPortForwardStatus) => {
          if (!cancelled) setStatus(next);
        })
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [hostId, active]);
  return status;
}

function FormFooter({
  isEdit,
  setupState,
  canSetUp,
  onFillFromConfig,
  onCancel,
}: {
  isEdit: boolean;
  setupState: SetupState;
  canSetUp: boolean;
  onFillFromConfig: () => void;
  onCancel: () => void;
}) {
  const busy = isBusy(setupState);
  return (
    <DialogFooter className="items-center gap-2 sm:justify-between sm:space-x-0">
      {!isEdit ? (
        <Button
          type="button"
          variant="link"
          className="h-auto justify-start p-0 text-xs text-muted-foreground hover:text-foreground"
          onClick={onFillFromConfig}
          disabled={busy}
        >
          Fill from ~/.ssh/config…
        </Button>
      ) : (
        <span />
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={setupState === 'preparing'}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Spinner size="sm" className="mr-1.5" />}
          {primaryLabel(setupState, canSetUp, isEdit)}
        </Button>
      </div>
    </DialogFooter>
  );
}

/** The form's one button moves through check, setup or save, and checking again. */
function primaryLabel(setupState: SetupState, canSetUp: boolean, isEdit: boolean): string {
  if (setupState === 'checking') return 'Checking…';
  if (setupState === 'preparing') return isEdit ? 'Saving…' : 'Setting up…';
  if (canSetUp) return isEdit ? 'Save changes' : 'Set up machine';
  if (setupState === 'checked' || setupState === 'error') return 'Check again';
  return isEdit ? 'Check changes' : 'Check machine';
}

const isBusy = (setupState: SetupState) => setupState === 'checking' || setupState === 'preparing';

/** Setup needs a check of the current details that found everything it requires. */
const canSetUpAfter = (setupState: SetupState, result: SshHostSetupResult | null) =>
  setupState === 'checked' && result !== null && setupRequirementsMet(result);

/**
 * Says which ~/.ssh/config entry the host field connects through, while it still holds the
 * alias picked from the file.
 */
function configAliasHint(
  alias: string | null,
  hostname: string,
  configHosts: SshConfigHost[] | null
): string | undefined {
  if (alias === null || hostname.trim() !== alias) return undefined;
  const entry = configHosts?.find((host) => host.alias === alias);
  const summary = entry ? sshConfigHostSummary(entry) : null;
  return `Uses the settings for ${alias} in ~/.ssh/config${summary ? `: ${summary}` : ''}.`;
}

function FormHeader({ isEdit, name }: { isEdit: boolean; name: string }) {
  return (
    <DialogHeader>
      <DialogTitle>{isEdit ? `Edit ${name}` : 'Add SSH host'}</DialogTitle>
      <DialogDescription>
        {isEdit ? (
          'Changes are checked on the machine before they are saved.'
        ) : (
          <>
            A machine you can log into over SSH. Agents keep working there while this computer
            sleeps. <SshGuideLink>More info ↗</SshGuideLink>
          </>
        )}
      </DialogDescription>
    </DialogHeader>
  );
}

function RevealedError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div ref={revealOnMount}>
      <FormError message={message} />
    </div>
  );
}

type DraftChange = <K extends keyof HostDraft>(key: K, value: HostDraft[K]) => void;

/** A field left empty for a ~/.ssh/config alias takes its value from the file. */
const configPlaceholder = (fromConfig: boolean, fallback?: string) =>
  fromConfig ? 'From ~/.ssh/config' : fallback;

function ReadyStep({
  host,
  status,
  error,
  saving,
  onLaunchIntegrationChange,
  onDone,
  onImportProjects,
}: {
  host: SshHost | undefined;
  status: SshIntegrationStatus | null;
  error: string | null;
  saving: boolean;
  onLaunchIntegrationChange: (on: boolean) => void;
  onDone: () => void;
  onImportProjects: (hostId: string) => void;
}) {
  const hostProjects = useHostProjects(host?.id);
  if (!host) return null;
  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <CheckCircle weight="fill" className="size-5 shrink-0 text-success" />
          <DialogTitle>{host.name} is ready</DialogTitle>
        </div>
        <DialogDescription>
          New workspaces will start on it; switch in the New Workspace dialog. Turn on hooks for the
          agents you use there, so Komla knows when they’re done or need you.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        {hostProjects.length > 0 && (
          <Callout
            className="mb-4"
            title={`Projects on ${host.name}`}
            action={
              <Button size="sm" variant="outline" onClick={() => onImportProjects(host.id)}>
                Review
              </Button>
            }
          >
            {projectNames(hostProjects)} {hostProjects.length === 1 ? 'is' : 'are'} set up there.
            Add {hostProjects.length === 1 ? 'it' : 'them'} here with icons, Workspace Setup and
            Quick Commands.
          </Callout>
        )}
        <RemoteAgentIntegrationsPanel
          target={{ kind: 'ssh', host }}
          initialStatus={status}
          onLaunchIntegrationChange={onLaunchIntegrationChange}
          showIntro={false}
        />
      </DialogBody>
      {error && <FormError message={error} />}
      <DialogFooter>
        <Button onClick={onDone} disabled={saving}>
          {saving && <Spinner size="sm" className="mr-1.5" />}
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * The projects with settings on a newly set up host that this installation lacks or has with
 * other settings; none until read, or when reading fails.
 */
function useHostProjects(hostId: string | undefined): SshHostProject[] {
  const [projects, setProjects] = useState<SshHostProject[]>([]);
  useEffect(() => {
    if (!hostId) return;
    let cancelled = false;
    window.api
      .listSshHostProjects(hostId)
      .then((found) => {
        // Ones removed here are offered in the host's Projects dialog, not pressed on setup.
        if (!cancelled) setProjects(found.filter((project) => !project.removedHere));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [hostId]);
  return projects;
}

/** Up to three names, then how many more. */
function projectNames(projects: SshHostProject[]): string {
  const names = projects.map((project) => project.name);
  if (names.length <= 3) return new Intl.ListFormat('en', { type: 'conjunction' }).format(names);
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function ConnectionFields({
  draft,
  onChange,
  onHostBlur,
  hostHint,
  fromConfig,
  isEdit,
  workspaceCount,
}: {
  draft: HostDraft;
  onChange: DraftChange;
  onHostBlur: () => void;
  hostHint: string | undefined;
  /** The host is an alias in ~/.ssh/config, which fills in the fields left empty. */
  fromConfig: boolean;
  isEdit: boolean;
  /** Workspaces on the host, which keep how Komla connects to it fixed. */
  workspaceCount: number;
}) {
  const locked = workspaceCount > 0;
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-4">
      <Field label="Host or alias" hint={hostHint}>
        {(id, describedBy) => (
          <Input
            id={id}
            aria-describedby={describedBy}
            className="h-9"
            value={draft.hostname}
            onChange={(e) => onChange('hostname', e.target.value)}
            onBlur={onHostBlur}
            placeholder="user@devbox.example.com"
            disabled={locked}
            autoFocus={!isEdit}
          />
        )}
      </Field>
      <Field label="Name">
        {(id) => (
          <Input
            id={id}
            className="h-9"
            value={draft.name}
            onChange={(e) => onChange('name', e.target.value)}
            placeholder={draft.hostname.trim() || 'Devbox'}
          />
        )}
      </Field>
      <Field label="User">
        {(id) => (
          <Input
            id={id}
            className="h-9"
            value={draft.user}
            onChange={(e) => onChange('user', e.target.value)}
            placeholder={configPlaceholder(fromConfig)}
            disabled={locked}
          />
        )}
      </Field>
      <Field label="Port">
        {(id) => (
          <Input
            id={id}
            className="h-9"
            value={draft.port}
            inputMode="numeric"
            onChange={(e) => onChange('port', e.target.value)}
            placeholder={configPlaceholder(fromConfig, '22')}
            disabled={locked}
          />
        )}
      </Field>
      {locked && (
        <p className="col-span-2 text-xs leading-normal text-warning">
          Host address, user, port, identity file, and custom SSH flags are locked while this host
          has {workspaceCount} workspace{workspaceCount === 1 ? '' : 's'}.
        </p>
      )}
    </div>
  );
}

function AdvancedOptions({
  draft,
  onChange,
  expanded,
  onExpandedChange,
  isEdit,
  fromConfig,
  locked,
  portForwardStatus,
  unsaved,
}: {
  draft: HostDraft;
  onChange: DraftChange;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  isEdit: boolean;
  /** The host is an alias in ~/.ssh/config, which fills in the fields left empty. */
  fromConfig: boolean;
  /** Workspaces on the host keep its identity file and SSH arguments fixed. */
  locked: boolean;
  portForwardStatus: SshPortForwardStatus | null;
  /** The dialog holds changes that the saved forwards don't have yet. */
  unsaved: boolean;
}) {
  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
      >
        Advanced
        <CaretDown className={cn('size-3.5 transition-transform', expanded && 'rotate-180')} />
      </Button>
      {expanded && (
        <div className="mt-3 space-y-4">
          <Field label="Identity file" hint="Your SSH agent and ~/.ssh/config are used by default.">
            {(id, describedBy) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                className="h-9"
                value={draft.identityFile}
                onChange={(e) => onChange('identityFile', e.target.value)}
                placeholder={configPlaceholder(fromConfig, '~/.ssh/id_ed25519')}
                disabled={locked}
              />
            )}
          </Field>
          <Field
            label="Remote Komla path"
            hint={
              isEdit
                ? 'Remote Komla path is fixed after this machine is connected. Remove and reconnect the machine to use a different path.'
                : 'Komla keeps repositories, worktrees and its runtime here. Keep the default unless this host needs a different disk.'
            }
          >
            {(id, describedBy) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                className="h-9"
                value={draft.basePath}
                onChange={(e) => onChange('basePath', e.target.value)}
                disabled={isEdit}
              />
            )}
          </Field>
          <Field label="Extra SSH args" hint="One argument per line. Values may contain spaces.">
            {(id, describedBy) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                value={draft.extraSshArgs}
                onChange={(e) => onChange('extraSshArgs', e.target.value)}
                placeholder={'-o\nProxyCommand=ssh -W %h:%p bastion'}
                rows={3}
                disabled={locked}
              />
            )}
          </Field>
          <PortForwardsEditor
            forwards={draft.portForwards}
            status={unsaved ? 'unsaved' : portForwardStatus}
            showStatus={isEdit}
            onChange={(forwards) => onChange('portForwards', forwards)}
          />
        </div>
      )}
    </div>
  );
}

/** What the check found, or what checking does before it has run. */
function CheckStatus({
  setupState,
  result,
  hostname,
  isEdit,
}: {
  setupState: SetupState;
  result: SshHostSetupResult | null;
  hostname: string;
  isEdit: boolean;
}) {
  if (setupState === 'checking') {
    return (
      <p className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-xs text-muted-foreground">
        <Spinner size="sm" />
        Checking {hostname} for Git, tmux and the tools Komla needs…
      </p>
    );
  }
  if (result && (setupState === 'checked' || setupState === 'preparing')) {
    return (
      <div ref={revealOnMount}>
        <SshHostChecklist result={result} />
      </div>
    );
  }
  return <SetupExplainer isEdit={isEdit} />;
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children(id, hintId)}
      {hint && (
        <p id={hintId} className="text-xs leading-normal text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

function ForwardAgentRow({
  checked,
  isEdit,
  onCheckedChange,
}: {
  checked: boolean;
  isEdit: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 text-xs leading-relaxed">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium">
          Forward SSH agent
        </label>
        <div id={`${id}-description`} className="mt-0.5 text-muted-foreground">
          {checked ? (
            <details className="group">
              <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                Agents on the machine can use your SSH keys while Komla is connected. Keys are never
                copied.{' '}
                <span className="text-foreground underline underline-offset-2 group-open:hidden">
                  Learn more
                </span>
                <span className="hidden text-foreground underline underline-offset-2 group-open:inline">
                  Hide details
                </span>
              </summary>
              <p className="mt-1">
                So can other processes there. Agents kept running in tmux lose the keys after Komla
                disconnects, so give the remote user its own Git credentials if they need Git
                unattended.
              </p>
            </details>
          ) : (
            <p>
              The machine needs its own Git credentials to create workspaces from your repositories.
            </p>
          )}
          {isEdit && <p className="mt-1">Changes apply to new SSH sessions.</p>}
        </div>
      </div>
      <Switch
        id={id}
        aria-describedby={`${id}-description`}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="mt-0.5"
      />
    </div>
  );
}

function IsolatedHostRow({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 text-xs leading-relaxed">
        <label htmlFor={id} className="cursor-pointer text-sm font-medium">
          Treat as isolated
        </label>
        <p id={`${id}-description`} className="mt-0.5 text-muted-foreground">
          Agents may start other agents here that skip permission prompts. Turn off for a machine
          you&apos;d mind them changing.
        </p>
      </div>
      <Switch
        id={id}
        aria-describedby={`${id}-description`}
        checked={checked}
        onCheckedChange={onCheckedChange}
        className="mt-0.5"
      />
    </div>
  );
}

function SetupExplainer({ isEdit }: { isEdit: boolean }) {
  // The header already says edits are checked before they're saved.
  if (isEdit) return null;
  return (
    <details className="group text-xs leading-relaxed text-muted-foreground">
      <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        Checking changes nothing on the machine.{' '}
        <span className="text-foreground underline underline-offset-2 group-open:hidden">
          See what setup changes
        </span>
        <span className="hidden text-foreground underline underline-offset-2 group-open:inline">
          Hide setup details
        </span>
      </summary>
      <ul className="mt-2 list-disc space-y-1 pl-4">
        <li>Checks the remote OS, Git, required utilities, tmux, rsync, and Git identity.</li>
        <li>
          Creates Komla-managed repository, worktree, and runtime folders under the configured Komla
          folder.
        </li>
        <li>
          Installs or refreshes the Remote Companion and its private support files so Komla can
          observe workspaces and receive agent events.
        </li>
        <li>
          If needed, configures the remote Git identity using this computer&apos;s global Git name
          and email.
        </li>
        <li>
          Leaves project packages and Git credentials unchanged. Repositories and workspaces are
          created later, when you ask for them.
        </li>
      </ul>
    </details>
  );
}

function PortForwardsEditor({
  forwards,
  status,
  showStatus,
  onChange,
}: {
  forwards: PortForwardDraft[];
  /** The forwards' tunnel, or 'unsaved' while the dialog holds changes. */
  status: SshPortForwardStatus | 'unsaved' | null;
  showStatus: boolean;
  onChange: (forwards: PortForwardDraft[]) => void;
}) {
  const onAdd = () =>
    onChange([
      ...forwards,
      {
        id: createPortForwardId(),
        name: 'Local service',
        direction: 'local-to-remote',
        localPort: '',
        remotePort: '',
        enabled: true,
      },
    ]);
  const onUpdate = <K extends keyof PortForwardDraft>(
    id: string,
    key: K,
    value: PortForwardDraft[K]
  ) =>
    onChange(
      forwards.map((forward) => (forward.id === id ? { ...forward, [key]: value } : forward))
    );
  const onRemove = (id: string) => onChange(forwards.filter((forward) => forward.id !== id));

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-muted-foreground">Port forwards</div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Make services available in either direction between this computer and the SSH host. Both
            ends are restricted to 127.0.0.1.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onAdd}>
          <Plus className="mr-1.5 size-3.5" />
          Add
        </Button>
      </div>

      {forwards.length === 0 ? (
        <EmptyState
          size="sm"
          title="No services are forwarded for this SSH host."
          className="rounded-md border border-dashed border-border py-4"
        />
      ) : (
        <div className="space-y-2">
          {forwards.map((forward) => (
            <div key={forward.id} className="space-y-2 rounded-md border border-border/70 p-3">
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Port forward name"
                  value={forward.name}
                  onChange={(event) => onUpdate(forward.id, 'name', event.target.value)}
                  placeholder="Local PostgreSQL"
                  className="h-8"
                />
                <Switch
                  aria-label={`Enable ${forward.name || 'port forward'}`}
                  checked={forward.enabled}
                  onCheckedChange={(checked) => onUpdate(forward.id, 'enabled', checked)}
                />
                <IconButton
                  label={`Remove ${forward.name || 'port forward'}`}
                  size="md"
                  className="hover:text-destructive"
                  onClick={() => onRemove(forward.id)}
                >
                  <Trash className="size-3.5" />
                </IconButton>
              </div>
              <Select
                aria-label={`Direction for ${forward.name || 'port forward'}`}
                value={forward.direction}
                onChange={(event) =>
                  onUpdate(
                    forward.id,
                    'direction',
                    event.target.value as PortForwardDraft['direction']
                  )
                }
              >
                <option value="local-to-remote">This computer → SSH host</option>
                <option value="remote-to-local">SSH host → this computer</option>
              </Select>
              <div className="grid grid-cols-2 gap-2">
                <PortInput
                  side="This computer"
                  label={`Local port for ${forward.name}`}
                  value={forward.localPort}
                  placeholder="5432"
                  onChange={(value) => onUpdate(forward.id, 'localPort', value)}
                />
                <PortInput
                  side="SSH host"
                  label={`SSH host port for ${forward.name}`}
                  value={forward.remotePort}
                  placeholder="15432"
                  onChange={(value) => onUpdate(forward.id, 'remotePort', value)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {showStatus && forwards.some((forward) => forward.enabled) && (
        <PortForwardsStatus status={status} />
      )}

      {forwards.length > 0 && (
        <div className="flex items-start gap-2 text-xs leading-relaxed text-warning">
          <Warning className="mt-0.5 size-3.5 shrink-0" />
          <p>
            A forwarded service is reachable by processes on its destination machine. Keep service
            authentication enabled; forwards stop when Komla exits.
          </p>
        </div>
      )}
    </div>
  );
}

function PortForwardsStatus({ status }: { status: SshPortForwardStatus | 'unsaved' | null }) {
  const note =
    status === 'unsaved'
      ? {
          tone: 'bg-muted text-muted-foreground',
          icon: <Info className="mt-0.5 size-3.5 shrink-0" />,
          message: 'Save this SSH host to apply port forward changes.',
        }
      : status?.state === 'connected'
        ? {
            tone: 'bg-success/10 text-success',
            icon: <CheckCircle className="mt-0.5 size-3.5 shrink-0" />,
            message: 'Port forwards connected.',
          }
        : status?.state === 'error'
          ? {
              tone: 'bg-error/10 text-error',
              icon: <XCircle className="mt-0.5 size-3.5 shrink-0" />,
              message: status.error || 'Port forwards could not connect.',
            }
          : {
              tone: 'bg-muted text-muted-foreground',
              icon: <Spinner size="sm" className="mt-0.5" />,
              message: 'Connecting port forwards…',
            };
  return (
    <div
      className={cn('flex items-start gap-2 rounded-md px-3 py-2 text-xs', note.tone)}
      role="status"
    >
      {note.icon}
      <span className="min-w-0 break-words">{note.message}</span>
    </div>
  );
}

function PortInput({
  side,
  label,
  value,
  placeholder,
  onChange,
}: {
  side: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1">
      <span className="block text-ui font-medium text-muted-foreground">{side}</span>
      <div className="flex items-center gap-1.5">
        <code className="text-ui text-muted-foreground">127.0.0.1:</code>
        <Input
          aria-label={label}
          inputMode="numeric"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="h-8"
        />
      </div>
    </label>
  );
}
