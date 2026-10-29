import { createHash } from 'node:crypto';

import { createLogger } from '../../lib/logger';

import {
  agentIds,
  buildSshProjectManifest,
  differingParts,
  localSetupStep,
  parseSshProjectManifest,
  publishableSshProjectManifest,
  sshProjectManifestContentKey,
  sshProjectManifestId,
} from './project-manifest';

import type {
  Action,
  AgentPreset,
  CreateProjectFromRemoteParams,
  Project,
} from '../../../shared/types';
import type {
  SshHostProject,
  SshHostProjectImport,
  SshHostProjectImportResult,
  SshProjectManifest,
  SshProjectManifestQuickCommand,
  SshProjectSettingsPart,
} from '../../../shared/types/ssh-project-manifest';

const logger = createLogger('SshProjectSync');

/** How long a host read counts as current, after which it is read again for files it lost. */
const HOST_READ_TTL_MS = 10 * 60_000;

/** The Project manifests on SSH hosts. */
export interface SshProjectSyncHost {
  /** Every Project manifest's raw text by id. `background` when no one is waiting on it. */
  read: (hostId: string, options: { background: boolean }) => Promise<Map<string, string>>;
  write: (hostId: string, manifestId: string, content: string) => Promise<void>;
  /** Whether the SSH host is configured here. */
  hasHost: (hostId: string) => boolean;
}

export interface SshProjectSyncDependencies {
  host: SshProjectSyncHost;
  projects: {
    get: (id: string) => Project | undefined;
    /** The projects with workspaces on the host, each with the origin it clones there. */
    onHost: (hostId: string) => Array<{ project: Project; gitUrl: string }>;
    /** Resolves to a lookup of this installation's project for a repository origin. */
    lookup: () => Promise<(gitUrl: string) => Project | undefined>;
    createFromRemote: (params: CreateProjectFromRemoteParams) => Promise<Project>;
    update: (id: string, updates: Partial<Project>) => Promise<Project>;
  };
  actions: {
    list: () => Action[];
    replaceAll: (actions: Action[]) => void;
  };
  presets: () => AgentPreset[];
  now: () => number;
  deviceId: () => string;
  /** What each host and this installation last agreed on, kept across restarts. */
  agreements: {
    read: () => string | undefined;
    write: (content: string) => Promise<void>;
  };
}

/**
 * The settings this installation and a host last held in common for a
 * project: what it published or took, and its own settings at the time.
 * Differences since then on one side only say which side changed.
 */
interface Agreement {
  host: string;
  local: string;
}

/**
 * Publishes this installation's project settings on the SSH hosts where the
 * projects have workspaces, and copies other installations' on request. It
 * never takes settings from a host on its own, and never overwrites ones on
 * a host that this installation hasn't seen.
 */
export class SshProjectSync {
  private agreements: Map<string, Agreement> | undefined;
  /** When each host was last read, since it may lose files the agreements say it has. */
  private readonly hostsReadAt = new Map<string, number>();
  /** Settings that couldn't be published, by host and manifest, until they change. */
  private readonly unpublishable = new Map<string, string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private saveQueued = false;

  constructor(private readonly dependencies: SshProjectSyncDependencies) {}

  /** Publishes the settings of projects with workspaces on the host that changed here. */
  syncHost(hostId: string): Promise<void> {
    return this.enqueue(hostId, () => this.publishChanges(hostId)).catch((error: unknown) => {
      logger.warn('Could not publish project settings on an SSH host', {
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * The projects on the host whose published settings this installation
   * hasn't taken: ones it lacks, and ones whose settings differ.
   */
  async listOnHost(hostId: string): Promise<SshHostProject[]> {
    this.assertHost(hostId);
    const manifests = await this.read(hostId, false);
    const lookup = await this.dependencies.projects.lookup();
    const offers: SshHostProject[] = [];
    const deviceId = this.dependencies.deviceId();
    for (const [manifestId, manifest] of manifests) {
      if (!manifest) continue;
      const project = lookup(manifest.gitUrl);
      const local = project && this.build(project, manifest.gitUrl).manifest;
      const differs = differingParts(manifest, local);
      if (project) {
        // What this installation published or took already, which can differ only in what it
        // can't take, such as an agent it doesn't have.
        const agreed = this.agreement(hostId, manifestId);
        if (agreed?.host === sshProjectManifestContentKey(manifest) || differs.length === 0) {
          continue;
        }
      }
      offers.push({
        ...offer(manifestId, manifest, project?.id, differs),
        // This installation's own, for a project removed here since.
        ...(!project && manifest.writtenBy === deviceId ? { removedHere: true } : {}),
      });
    }
    return offers.sort(
      (a, b) => Number(!!a.projectId) - Number(!!b.projectId) || a.name.localeCompare(b.name)
    );
  }

  /**
   * Copies the chosen parts of projects' settings from the host, adding each
   * project this installation lacks. Each project succeeds or fails alone.
   */
  importFromHost(
    hostId: string,
    imports: SshHostProjectImport[]
  ): Promise<SshHostProjectImportResult[]> {
    this.assertHost(hostId);
    return this.enqueue(hostId, async () => {
      const manifests = await this.read(hostId, false);
      const results: SshHostProjectImportResult[] = [];
      for (const { manifestId, parts } of imports) {
        const manifest = manifests.get(manifestId);
        if (!manifest) {
          results.push({
            manifestId,
            ok: false,
            error:
              manifest === null
                ? 'That project’s settings on this SSH host can’t be read here.'
                : 'That project’s settings are no longer on this SSH host.',
          });
          continue;
        }
        try {
          const imported = await this.importOne(manifest, parts);
          results.push({ manifestId, ok: true, ...imported });
          const project = this.dependencies.projects.get(imported.projectId);
          if (project) {
            this.setAgreement(hostId, manifestId, {
              host: sshProjectManifestContentKey(manifest),
              local: sshProjectManifestContentKey(this.build(project, manifest.gitUrl).manifest),
            });
          }
        } catch (error) {
          results.push({
            manifestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    });
  }

  private async publishChanges(hostId: string): Promise<void> {
    const { host } = this.dependencies;
    if (!host.hasHost(hostId)) return;
    const projects = this.dependencies.projects.onHost(hostId).map(({ project, gitUrl }) => {
      const manifestId = sshProjectManifestId(gitUrl);
      const local = this.build(project, gitUrl);
      return { project, manifestId, local, localKey: sshProjectManifestContentKey(local.manifest) };
    });
    // Only changes here are published, so a host read lately that has seen them all needn't be
    // read again.
    const readAt = this.hostsReadAt.get(hostId);
    const stale = readAt === undefined || this.dependencies.now() - readAt > HOST_READ_TTL_MS;
    const changed = projects.filter(
      ({ manifestId, localKey }) =>
        stale ||
        (this.agreement(hostId, manifestId)?.local !== localKey &&
          this.unpublishable.get(key(hostId, manifestId)) !== localKey)
    );
    if (changed.length === 0) return;
    const manifests = await this.read(hostId, true);
    this.hostsReadAt.set(hostId, this.dependencies.now());
    for (const { project, manifestId, local, localKey } of changed) {
      const onHost = manifests.get(manifestId);
      const agreed = this.agreement(hostId, manifestId);
      const next = nextStep(onHost, local.manifest, agreed);
      if (next.kind === 'agree') {
        this.setAgreement(hostId, manifestId, { host: next.hostKey, local: localKey });
      }
      if (next.kind !== 'publish') continue;
      if (!local.text) {
        this.unpublishable.set(key(hostId, manifestId), localKey);
        logger.warn('Project settings are too large or invalid to publish on an SSH host', {
          hostId,
          projectId: project.id,
        });
        continue;
      }
      if (!host.hasHost(hostId)) return;
      try {
        await host.write(hostId, manifestId, local.text);
        this.setAgreement(hostId, manifestId, { host: localKey, local: localKey });
      } catch (error) {
        logger.warn('Could not publish project settings on an SSH host', {
          hostId,
          projectId: project.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async importOne(
    manifest: SshProjectManifest,
    parts: SshProjectSettingsPart[]
  ): Promise<{ projectId: string; added: boolean }> {
    const { projects } = this.dependencies;
    const take = new Set(parts);
    let project = (await projects.lookup())(manifest.gitUrl);
    const added = !project;
    project ??= await projects.createFromRemote({
      remoteUrl: manifest.gitUrl,
      name: manifest.name,
    });

    // Setup steps bring the Quick Commands they start, which the user reviews with them.
    const { setupSteps } = manifest.workspaceSetup;
    const { settings } = manifest;
    const referenced = new Set(
      take.has('workspaceSetup') ? setupSteps.map((step) => step.actionId) : []
    );
    const commands = manifest.quickCommands.filter(
      (entry) => take.has('quickCommands') || referenced.has(entry.id)
    );
    const ids = commands.length > 0 ? this.importCommands(project.id, commands) : new Map();

    const updates: Partial<Project> = {};
    if (take.has('appearance')) {
      if (manifest.color !== undefined) updates.color = manifest.color;
      if (manifest.icon !== undefined) updates.icon = manifest.icon;
    }
    if (take.has('workspaceSetup')) {
      const presets = this.dependencies.presets();
      Object.assign(updates, {
        ...manifest.workspaceSetup,
        setupSteps: setupSteps.map((step) => {
          const local = localSetupStep(step, presets);
          return step.actionId ? { ...local, actionId: ids.get(step.actionId) ?? '' } : local;
        }),
      });
    }
    const projectId = project.id;
    if (!take.has('workspaceSetup') && ids.size > 0 && project.setupSteps) {
      // Steps here that started a shared command the project now has a copy of start the copy.
      updates.setupSteps = project.setupSteps.map((step) =>
        step.actionId ? { ...step, actionId: ids.get(step.actionId) ?? step.actionId } : step
      );
    }
    if (take.has('settings')) {
      // A Quick Command the settings start: one copied for the project, now or before, or one
      // it has here with that id. Another here with the same id may do something else entirely.
      const usedHere = new Set([
        ...this.dependencies.actions
          .list()
          .filter((action) => action.projectIds?.includes(projectId))
          .map((action) => action.id),
        project.aheadTargetActionId,
        project.autoMainActionId,
        project.autoOtherActionId,
      ]);
      const action = (id: string | undefined) => {
        if (!id) return undefined;
        const copied = ids.get(id) ?? copiedCommandId(id, projectId);
        if (ids.has(id) || usedHere.has(copied)) return copied;
        return usedHere.has(id) ? id : undefined;
      };
      const aheadTargetActionId = action(settings.aheadTargetActionId);
      const autoMainActionId = action(settings.autoMainActionId);
      const autoOtherActionId = action(settings.autoOtherActionId);
      // Without its Quick Command, an agent prompt goes back to the default.
      const prompt = <T>(choice: T | undefined, id: string | undefined) =>
        choice === 'agent-prompt' && !id ? undefined : choice;
      // Settings the host leaves unset go back to the defaults here too.
      Object.assign(updates, {
        defaultBranchPrefix: settings.defaultBranchPrefix,
        baseBranch: settings.baseBranch,
        aheadTargetAction: prompt(settings.aheadTargetAction, aheadTargetActionId),
        autoPushAfterMerge: settings.autoPushAfterMerge,
        aheadTargetActionId,
        behindTargetAction: settings.behindTargetAction,
        autoMainBranchAction: prompt(settings.autoMainBranchAction, autoMainActionId),
        autoOtherBranchAction: prompt(settings.autoOtherBranchAction, autoOtherActionId),
        autoMainActionId,
        autoOtherActionId,
        sshWorkspaceMode: settings.sshWorkspaceMode,
      } satisfies Partial<Project>);
    }
    if (Object.keys(updates).length > 0) await projects.update(project.id, updates);
    return { projectId: project.id, added };
  }

  /**
   * Adds the host's Quick Commands to the project and returns the id each has
   * here. One only this project uses here is updated in place. One that other
   * projects or every project uses is never changed: the project shares it if
   * it does the same, else gets a copy of its own. It removes none, so ones
   * only this installation has stay.
   */
  private importCommands(
    projectId: string,
    commands: SshProjectManifestQuickCommand[]
  ): Map<string, string> {
    const { actions } = this.dependencies;
    const presets = this.dependencies.presets();
    const byId = new Map(actions.list().map((action) => [action.id, action]));
    const ids = new Map<string, string>();
    for (const entry of commands) {
      const existing = byId.get(entry.id);
      const shared =
        existing &&
        (!existing.projectIds?.length || existing.projectIds.some((id) => id !== projectId));
      if (!existing || !shared) {
        ids.set(entry.id, entry.id);
        byId.set(entry.id, localQuickCommand(entry, existing, projectId, presets));
        continue;
      }
      const scoped = existing.projectIds?.length ? existing.projectIds : undefined;
      if (sameCommand(existing, entry, presets)) {
        ids.set(entry.id, entry.id);
        if (scoped && !scoped.includes(projectId)) {
          byId.set(entry.id, { ...existing, projectIds: [...scoped, projectId] });
        }
        continue;
      }
      // The project's copy replaces the shared one for it.
      if (scoped?.includes(projectId)) {
        byId.set(entry.id, { ...existing, projectIds: scoped.filter((id) => id !== projectId) });
      }
      const id = copiedCommandId(entry.id, projectId);
      ids.set(entry.id, id);
      byId.set(id, localQuickCommand({ ...entry, id }, byId.get(id), projectId, presets));
    }
    actions.replaceAll([...byId.values()]);
    return ids;
  }

  /** This installation's manifest for a project, as other installations would read it. */
  private build(
    project: Project,
    gitUrl: string
  ): ReturnType<typeof publishableSshProjectManifest> {
    return publishableSshProjectManifest(
      buildSshProjectManifest(
        project,
        gitUrl,
        this.dependencies.actions.list(),
        this.dependencies.presets(),
        this.dependencies.now(),
        this.dependencies.deviceId()
      )
    );
  }

  /**
   * The host's Project manifests by id; null for one this installation can't
   * read, e.g. one a newer Komla wrote, which it must not publish over.
   */
  private async read(
    hostId: string,
    background: boolean
  ): Promise<Map<string, SshProjectManifest | null>> {
    const manifests = new Map<string, SshProjectManifest | null>();
    for (const [manifestId, text] of await this.dependencies.host.read(hostId, { background })) {
      const manifest = parseSshProjectManifest(text);
      // One under another repository's id was not written by Komla.
      manifests.set(
        manifestId,
        manifest && sshProjectManifestId(manifest.gitUrl) === manifestId ? manifest : null
      );
    }
    return manifests;
  }

  private assertHost(hostId: string): void {
    if (!this.dependencies.host.hasHost(hostId)) {
      throw new Error('That SSH host is no longer configured here.');
    }
  }

  /** Runs one host's passes one at a time, so each sees the agreements the last one made. */
  private enqueue<T>(hostId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(hostId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const settled = next.catch(() => undefined);
    this.queues.set(hostId, settled);
    void settled.then(() => {
      if (this.queues.get(hostId) === settled) this.queues.delete(hostId);
    });
    return next;
  }

  private agreement(hostId: string, manifestId: string): Agreement | undefined {
    return this.loadAgreements().get(key(hostId, manifestId));
  }

  private setAgreement(hostId: string, manifestId: string, agreement: Agreement): void {
    const agreements = this.loadAgreements();
    const current = agreements.get(key(hostId, manifestId));
    if (current?.host === agreement.host && current.local === agreement.local) return;
    agreements.set(key(hostId, manifestId), agreement);
    this.saveAgreements();
  }

  private loadAgreements(): Map<string, Agreement> {
    if (this.agreements) return this.agreements;
    this.agreements = new Map();
    try {
      const text = this.dependencies.agreements.read();
      const value: unknown = text ? JSON.parse(text) : {};
      if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
          const { host, local } = (entry ?? {}) as Partial<Agreement>;
          if (typeof host === 'string' && typeof local === 'string') {
            this.agreements.set(key, { host, local });
          }
        }
      }
    } catch (error) {
      logger.warn('Could not read which project settings SSH hosts hold', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return this.agreements;
  }

  private saveAgreements(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    queueMicrotask(() => {
      this.saveQueued = false;
      const content = `${JSON.stringify(Object.fromEntries(this.loadAgreements()))}\n`;
      this.dependencies.agreements.write(content).catch((error: unknown) => {
        logger.warn('Could not save which project settings SSH hosts hold', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }
}

/**
 * What publishing does about one changed project: agree with the host's
 * settings, leave them to the user, or publish this installation's.
 */
function nextStep(
  onHost: SshProjectManifest | null | undefined,
  local: SshProjectManifest,
  agreed: Agreement | undefined
): { kind: 'agree'; hostKey: string } | { kind: 'leave' } | { kind: 'publish' } {
  if (onHost === undefined) return { kind: 'publish' };
  if (onHost === null) return { kind: 'leave' };
  const hostKey = sshProjectManifestContentKey(onHost);
  const localKey = sshProjectManifestContentKey(local);
  if (hostKey === localKey) return { kind: 'agree', hostKey };
  // Unchanged here since: what differs is what this installation couldn't take.
  if (agreed?.local === localKey) return { kind: 'leave' };
  if (agreed) {
    // Another installation's settings, left for the user to take or not.
    return hostKey === agreed.host ? { kind: 'publish' } : { kind: 'leave' };
  }
  // Settings that match in all an import would copy, e.g. when both installations set the
  // project up alike, are agreed on as they are; what only this one has goes with its next
  // change, so another installation's own changes keep publishing.
  return differingParts(onHost, local).length === 0
    ? { kind: 'agree', hostKey }
    : { kind: 'leave' };
}

function key(hostId: string, manifestId: string): string {
  return `${hostId}/${manifestId}`;
}

/** The id of a project's own copy of a host's Quick Command, the same each time it is copied. */
function copiedCommandId(commandId: string, projectId: string): string {
  return createHash('sha256').update(`${commandId}\0${projectId}`).digest('hex').slice(0, 32);
}

/** Whether a Quick Command here does just what one from a host does. */
function sameCommand(
  action: Action,
  entry: SshProjectManifestQuickCommand,
  presets: readonly AgentPreset[]
): boolean {
  const agent = agentIds(presets, entry.agent);
  const command = entry.type === 'command';
  // A host's copy reads back trimmed; an agent this installation lacks it would keep its own.
  return (
    action.title.trim() === entry.title &&
    action.content.trim() === entry.content &&
    (action.type ?? 'prompt') === entry.type &&
    (command ? action.sshExecutionLocation : undefined) ===
      (command ? entry.sshExecutionLocation : undefined) &&
    !!(command && action.background) === !!(command && entry.background) &&
    (!!entry.agent && !agent.presetId
      ? true
      : action.presetId === agent.presetId && action.launchModeId === agent.launchModeId)
  );
}

/** A Quick Command from a host as this installation stores it, over the one here with its id. */
function localQuickCommand(
  entry: SshProjectManifestQuickCommand,
  existing: Action | undefined,
  projectId: string,
  presets: readonly AgentPreset[]
): Action {
  let ids = agentIds(presets, entry.agent);
  // An agent this installation lacks leaves the one picked here alone.
  if (entry.agent && !ids.presetId && existing?.presetId) {
    ids = { presetId: existing.presetId, launchModeId: existing.launchModeId };
  }
  const command = entry.type === 'command';
  // A global one stays global; any other also serves the projects it did.
  const projectIds = !existing
    ? [projectId]
    : existing.projectIds?.length
      ? [...new Set([...existing.projectIds, projectId])]
      : undefined;
  return {
    id: entry.id,
    title: entry.title,
    content: entry.content,
    ...(command ? { type: 'command' as const } : {}),
    ...(projectIds ? { projectIds } : {}),
    ...(existing?.lastUsedAt !== undefined ? { lastUsedAt: existing.lastUsedAt } : {}),
    ...(existing?.lastUserInput !== undefined ? { lastUserInput: existing.lastUserInput } : {}),
    ...ids,
    ...(command && entry.sshExecutionLocation
      ? { sshExecutionLocation: entry.sshExecutionLocation }
      : {}),
    ...(command && entry.background ? { background: true } : {}),
  };
}

function offer(
  manifestId: string,
  manifest: SshProjectManifest,
  projectId: string | undefined,
  differs: SshProjectSettingsPart[]
): SshHostProject {
  const { setupSteps, trashCleanupScript } = manifest.workspaceSetup;
  return {
    manifestId,
    name: manifest.name,
    ...(manifest.color !== undefined ? { color: manifest.color } : {}),
    ...(manifest.icon !== undefined ? { icon: manifest.icon } : {}),
    gitUrl: manifest.gitUrl,
    ...(projectId ? { projectId } : {}),
    differs,
    setupSteps: setupSteps.map((step) => {
      const started = step.actionId
        ? manifest.quickCommands.find((entry) => entry.id === step.actionId)
        : undefined;
      return {
        name: step.name,
        command: step.command,
        ...(step.trigger ? { trigger: step.trigger } : {}),
        ...(step.agent ? { agentName: step.agent.agentName ?? 'Workspace agent' } : {}),
        ...(started
          ? {
              quickCommand: { title: started.title, content: started.content, type: started.type },
            }
          : {}),
      };
    }),
    ...(trashCleanupScript ? { trashCleanupScript } : {}),
    quickCommands: manifest.quickCommands.map(({ title, content, type }) => ({
      title,
      content,
      type,
    })),
    updatedAt: manifest.updatedAt,
  };
}
