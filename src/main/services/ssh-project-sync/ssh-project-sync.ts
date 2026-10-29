import { createHash } from 'node:crypto';

import { SSH_PROJECT_SETTINGS_PARTS } from '../../../shared/types/ssh-project-manifest';
import { createLogger } from '../../lib/logger';
import {
  actionConfig,
  describeActionChanges,
  describeBranchSettingsChanges,
  describeSetupChanges,
  workspaceSetup,
} from '../settings-approval-changes';
import { withSortedKeys } from '../ssh-workspace-sync/workspace-manifest';

import {
  agentIds,
  buildSshProjectManifest,
  differingParts,
  localSetupStep,
  parseSshProjectManifest,
  publishableSshProjectManifest,
  sshProjectManifestContentKey,
  sshProjectManifestId,
  sshProjectManifestPartKeys,
  withSshProjectManifestParts,
} from './project-manifest';

import type {
  Action,
  AgentPreset,
  CreateProjectFromRemoteParams,
  Project,
  SettingsApprovalChange,
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
/** How often a host is read for changes to the projects kept in sync with it. */
const KEPT_IN_SYNC_READ_MS = 60_000;

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
    list: () => Project[];
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
  /**
   * Asks the user whether to apply settings copied from a host; `unanswered`
   * when the prompt ended without their choice, e.g. as the window closed.
   */
  approve: (request: SshProjectApprovalRequest) => Promise<'apply' | 'cancel' | 'unanswered'>;
}

export interface SshProjectApprovalRequest {
  hostId: string;
  project: { id?: string; name: string };
  changes: SettingsApprovalChange[];
  /** Nobody asked for it: the host changed a project kept in sync. */
  background: boolean;
}

/** What copying parts of a host's settings would change, as the user approves it. */
interface Proposal {
  manifest: SshProjectManifest;
  /** The project here, or none when copying adds it. */
  projectId?: string;
  /** This installation's settings for it at the time. */
  local?: SshProjectManifest;
  changes: SettingsApprovalChange[];
}

type PartKeys = Partial<Record<SshProjectSettingsPart, string>>;

/**
 * The settings this installation and a host last held in common for a
 * project, part by part: what it published or took, and its own settings at
 * the time. Differences since then on one side only say which side changed.
 */
interface Agreement {
  /** This installation's project, as last agreed. */
  projectId?: string;
  host: PartKeys;
  local: PartKeys;
  /** The host's Quick Commands then, to tell the ones removed there since. */
  hostCommands: string[];
}

/**
 * How a part of the host's settings and this installation's compare: the
 * same; different only in what this installation couldn't take; changed on
 * one side since they agreed; or changed on both, or never agreed.
 */
type PartState = 'same' | 'kept' | 'host' | 'local' | 'both';

/**
 * Publishes this installation's project settings on the SSH hosts where the
 * projects have workspaces, part by part, and copies other installations'.
 * It copies them on request, or for a project kept in sync, as they change.
 * Anything on the host can write them, so beyond an icon and color it copies
 * only what the user approves, and only if the host and this installation are
 * still as they were when the user did. It never overwrites a part on a host
 * that changed since it last read it.
 */
export class SshProjectSync {
  private agreements: Map<string, Agreement> | undefined;
  /** When each host was last read, since it may lose files the agreements say it has. */
  private readonly hostsReadAt = new Map<string, number>();
  /**
   * This installation's settings when each was last synced with a host, by
   * host and manifest, which needn't sync again until they change.
   */
  private readonly syncedAs = new Map<string, string>();
  /** The host's changes the user was asked about, by host and manifest. */
  private readonly asked = new Map<string, PartKeys>();
  /** The projects, by host and manifest, whose changes the user is being asked about. */
  private readonly reviewing = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private saveQueued = false;

  constructor(private readonly dependencies: SshProjectSyncDependencies) {}

  /**
   * Publishes the settings of projects with workspaces on the host that
   * changed here, and takes the host's changes to projects kept in sync.
   */
  syncHost(hostId: string): Promise<void> {
    return this.enqueue(hostId, () => this.syncChanges(hostId)).catch((error: unknown) => {
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
      if (!project) {
        offers.push({
          ...offer(manifestId, manifest, undefined, differingParts(manifest, undefined)),
          // This installation's own, for a project removed here since.
          ...(manifest.writtenBy === deviceId ? { removedHere: true } : {}),
        });
        continue;
      }
      const { states, differs } = this.compare(hostId, manifestId, manifest, project);
      // A part changed only here is this installation's to publish, and one that differs only in
      // what it couldn't take, such as an agent it lacks, was taken already.
      const offered = differs.filter((part) => states[part] === 'host' || states[part] === 'both');
      if (offered.length === 0) continue;
      offers.push({
        ...offer(manifestId, manifest, project.id, offered),
        ...(project.keepSshSettingsInSync ? { keepsInSync: true } : {}),
      });
    }
    return offers.sort(
      (a, b) => Number(!!a.projectId) - Number(!!b.projectId) || a.name.localeCompare(b.name)
    );
  }

  /**
   * Copies the chosen parts of projects' settings from the host once the user
   * approves what they change, adding each project this installation lacks.
   * Each project succeeds or fails alone.
   */
  async importFromHost(
    hostId: string,
    imports: SshHostProjectImport[]
  ): Promise<SshHostProjectImportResult[]> {
    this.assertHost(hostId);
    const results: SshHostProjectImportResult[] = [];
    for (const entry of imports) {
      results.push((await this.importDecided(hostId, entry, false)).result);
    }
    return results;
  }

  /** Copies what the user approves of the import, with what they were shown. */
  private async importDecided(
    hostId: string,
    { manifestId, parts, keepInSync }: SshHostProjectImport,
    background: boolean
  ): Promise<{ result: SshHostProjectImportResult; proposal?: Proposal }> {
    let proposal: Proposal | undefined;
    try {
      proposal = await this.enqueue(hostId, () =>
        this.propose(hostId, manifestId, parts, background)
      );
      const shown = proposal;
      if (shown.changes.length > 0) {
        const decision = await this.whileAsking(hostId, manifestId, () =>
          this.dependencies.approve({
            hostId,
            project: { id: shown.projectId, name: shown.manifest.name },
            changes: shown.changes,
            background,
          })
        );
        // One the user declined isn't asked about again until the host changes it.
        if (decision === 'cancel') this.markAsked(hostId, manifestId, shown.manifest, parts);
        if (decision !== 'apply') {
          const result: SshHostProjectImportResult =
            decision === 'cancel'
              ? { manifestId, ok: false, cancelled: true, error: 'The changes weren’t applied.' }
              : { manifestId, ok: false, error: 'The review closed before you answered.' };
          return { result, proposal };
        }
      }
      const imported = await this.enqueue(hostId, () =>
        this.importProposed(hostId, manifestId, parts, shown, keepInSync, background)
      );
      return { result: { manifestId, ok: true, ...imported }, proposal };
    } catch (error) {
      return {
        result: {
          manifestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        proposal,
      };
    }
  }

  /** Runs `ask` with the project marked as being asked about, so no other prompt stacks on it. */
  private async whileAsking<T>(hostId: string, manifestId: string, ask: () => Promise<T>) {
    const reviewKey = key(hostId, manifestId);
    this.reviewing.set(reviewKey, (this.reviewing.get(reviewKey) ?? 0) + 1);
    try {
      return await ask();
    } finally {
      const left = (this.reviewing.get(reviewKey) ?? 1) - 1;
      if (left > 0) this.reviewing.set(reviewKey, left);
      else this.reviewing.delete(reviewKey);
    }
  }

  /** What copying the parts of the host's settings for a project would change here. */
  private async propose(
    hostId: string,
    manifestId: string,
    parts: readonly SshProjectSettingsPart[],
    background: boolean
  ): Promise<Proposal> {
    const manifest = await this.readOne(hostId, manifestId, background);
    const project = (await this.dependencies.projects.lookup())(manifest.gitUrl);
    const local = project ? this.build(project, manifest.gitUrl).manifest : undefined;
    return {
      manifest,
      ...(project ? { projectId: project.id, local } : {}),
      changes: this.describeImport(hostId, manifestId, manifest, parts, project, local),
    };
  }

  /**
   * Copies what the user approved, provided the host's settings and this
   * installation's would change just as they were shown.
   */
  private async importProposed(
    hostId: string,
    manifestId: string,
    parts: readonly SshProjectSettingsPart[],
    proposal: Proposal,
    keepInSync: boolean | undefined,
    background: boolean
  ): Promise<{ projectId: string; added: boolean }> {
    const manifest = await this.readOne(hostId, manifestId, background);
    let project = (await this.dependencies.projects.lookup())(manifest.gitUrl);
    const changes = this.describeImport(hostId, manifestId, manifest, parts, project);
    if (
      project?.id !== proposal.projectId ||
      JSON.stringify(changes) !== JSON.stringify(proposal.changes)
    ) {
      throw new Error('These settings changed while you were reviewing them. Review them again.');
    }
    const added = !project;
    project ??= await this.dependencies.projects.createFromRemote({
      remoteUrl: manifest.gitUrl,
      name: manifest.name,
    });
    const before = added ? undefined : this.compare(hostId, manifestId, manifest, project);
    project = await this.importParts(project, manifest, parts, before?.removed ?? [], keepInSync);
    // What was copied, and what copying wouldn't change, is agreed on; what the user left is
    // still offered, and what changed only here is still to publish.
    const local = this.build(project, manifest.gitUrl).manifest;
    const differs = differingParts(
      manifest,
      local,
      parts.includes('quickCommands') ? [] : (before?.removed ?? [])
    );
    const left = differs.filter((part) => !parts.includes(part));
    this.agree(
      hostId,
      manifestId,
      project.id,
      manifest,
      local,
      SSH_PROJECT_SETTINGS_PARTS.filter(
        (part) => before?.states[part] !== 'local' && !left.includes(part)
      )
    );
    // Left until the user picks them in the dialog, or the host changes them.
    this.markAsked(hostId, manifestId, manifest, left);
    return { projectId: project.id, added };
  }

  /**
   * Asks the user about the host's changes to a project kept in sync, once
   * per change. Declining leaves the project as it is until the host changes
   * those parts again.
   */
  private async reviewInBackground(
    hostId: string,
    manifestId: string,
    parts: SshProjectSettingsPart[]
  ): Promise<void> {
    const { result, proposal } = await this.importDecided(hostId, { manifestId, parts }, true);
    if (result.ok) return;
    if (!result.cancelled) {
      // Asked again on a later pass.
      this.asked.delete(key(hostId, manifestId));
      logger.warn('Could not copy project settings from an SSH host', {
        hostId,
        error: result.error,
      });
      return;
    }
    const local = proposal?.local;
    const projectId = proposal?.projectId;
    if (!local || !projectId) return;
    await this.enqueue(hostId, async () => {
      const manifest = await this.readOne(hostId, manifestId, true);
      if (askedKey(manifest, parts) !== askedKey(proposal.manifest, parts)) return;
      if (!this.dependencies.projects.get(projectId)) return;
      // As this installation's settings were when the user was asked, so edits made since still
      // publish.
      this.agree(hostId, manifestId, projectId, manifest, local, parts);
    }).catch(() => undefined);
  }

  /**
   * The changes to the project's Workspace Setup, Quick Commands and branch
   * settings that copying the parts would make, for the user to approve.
   * Copying an icon and color needs no approval.
   */
  private describeImport(
    hostId: string,
    manifestId: string,
    manifest: SshProjectManifest,
    parts: readonly SshProjectSettingsPart[],
    project: Project | undefined,
    local?: SshProjectManifest
  ): SettingsApprovalChange[] {
    // A project copying adds starts with nothing of its own.
    const before = project ?? newProject(manifest);
    const removed = project
      ? this.compare(hostId, manifestId, manifest, project, local).removed
      : [];
    const plan = this.plan(manifest, parts, before, removed);
    const after = { ...before, ...plan.updates };
    const actionsBefore = this.dependencies.actions.list();
    const actionsAfter = plan.actions ?? actionsBefore;
    return [
      ...describeSetupChanges(workspaceSetup(before), workspaceSetup(after), actionsAfter),
      ...describeActionChanges(
        projectQuickCommands(actionsBefore, before.id),
        projectQuickCommands(actionsAfter, before.id),
        this.dependencies.presets()
      ),
      ...describeBranchSettingsChanges(before, after, actionsAfter),
    ];
  }

  private async syncChanges(hostId: string): Promise<void> {
    const { host, now } = this.dependencies;
    if (!host.hasHost(hostId)) return;
    const projects = this.dependencies.projects.onHost(hostId).map(({ project, gitUrl }) => ({
      project,
      manifestId: sshProjectManifestId(gitUrl),
      local: this.build(project, gitUrl),
    }));
    // A host read lately that has seen every change here needn't be read again, unless it has
    // changes to take for a project kept in sync.
    const readAt = this.hostsReadAt.get(hostId);
    const readBefore = (ms: number) => readAt === undefined || now() - readAt > ms;
    const changed = projects.filter(
      ({ project, manifestId, local }) =>
        readBefore(HOST_READ_TTL_MS) ||
        (project.keepSshSettingsInSync && readBefore(KEPT_IN_SYNC_READ_MS)) ||
        this.syncedAs.get(key(hostId, manifestId)) !== sshProjectManifestContentKey(local.manifest)
    );
    // Projects kept in sync with a host they were copied from or published to before they had
    // workspaces there.
    const listed = new Set(projects.map(({ project }) => project.id));
    const keptElsewhere =
      readBefore(KEPT_IN_SYNC_READ_MS) && this.keepsInSyncWithoutWorkspaces(hostId, listed);
    if (changed.length === 0 && !keptElsewhere) return;
    const manifests = await this.read(hostId, true);
    this.hostsReadAt.set(hostId, now());
    if (keptElsewhere) changed.push(...(await this.keptInSyncWith(hostId, manifests, listed)));
    for (const entry of changed) {
      if (!host.hasHost(hostId)) return;
      try {
        const review = await this.syncProject(hostId, manifests.get(entry.manifestId), entry);
        // Asked after this pass, which it waits behind.
        if (review.length > 0) void this.reviewInBackground(hostId, entry.manifestId, review);
        // As they are after taking the host's changes, which aren't changes here to publish.
        const project = this.dependencies.projects.get(entry.project.id) ?? entry.project;
        this.syncedAs.set(
          key(hostId, entry.manifestId),
          sshProjectManifestContentKey(this.build(project, entry.local.manifest.gitUrl).manifest)
        );
      } catch (error) {
        logger.warn('Could not sync project settings with an SSH host', {
          hostId,
          projectId: entry.project.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Whether a project not in `listed` keeps in sync with the host, having synced with it. */
  private keepsInSyncWithoutWorkspaces(hostId: string, listed: ReadonlySet<string>): boolean {
    const kept = new Set(
      this.dependencies.projects
        .list()
        .filter((project) => project.keepSshSettingsInSync && !listed.has(project.id))
        .map((project) => project.id)
    );
    if (kept.size === 0) return false;
    return [...this.loadAgreements()].some(
      ([agreed, { projectId }]) =>
        agreed.startsWith(`${hostId}/`) && !!projectId && kept.has(projectId)
    );
  }

  /** The projects not in `listed` kept in sync with the host, which they synced with before. */
  private async keptInSyncWith(
    hostId: string,
    manifests: Map<string, SshProjectManifest | null>,
    listed: ReadonlySet<string>
  ): Promise<Array<{ project: Project; manifestId: string; local: Publishable }>> {
    const lookup = await this.dependencies.projects.lookup();
    const kept = new Map<string, { project: Project; manifestId: string; local: Publishable }>();
    for (const [manifestId, manifest] of manifests) {
      const project = manifest ? lookup(manifest.gitUrl) : undefined;
      if (!manifest || !project?.keepSshSettingsInSync || listed.has(project.id)) continue;
      if (!this.agreement(hostId, manifestId) || kept.has(project.id)) continue;
      kept.set(project.id, { project, manifestId, local: this.build(project, manifest.gitUrl) });
    }
    return [...kept.values()];
  }

  /**
   * Agrees on the parts that match, takes the host's new icon and color for a
   * project kept in sync, and publishes the parts changed here over the
   * host's. Returns the host's other changes to it, to ask the user about.
   */
  private async syncProject(
    hostId: string,
    onHost: SshProjectManifest | null | undefined,
    { project, manifestId, local }: { project: Project; manifestId: string; local: Publishable }
  ): Promise<SshProjectSettingsPart[]> {
    if (onHost === null) return [];
    if (onHost === undefined) {
      await this.publish(hostId, manifestId, project, local, undefined, SSH_PROJECT_SETTINGS_PARTS);
      return [];
    }
    const { states, differs } = this.compare(hostId, manifestId, onHost, project, local.manifest);
    const fromHost = (part: SshProjectSettingsPart) =>
      states[part] === 'host' || states[part] === 'both';
    // Parts that match in all copying would change, e.g. when both installations set the project
    // up alike, are agreed on as they are; what only this one has goes with its next change.
    const agreed = SSH_PROJECT_SETTINGS_PARTS.filter(
      (part) => states[part] === 'same' || (fromHost(part) && !differs.includes(part))
    );
    const incoming = project.keepSshSettingsInSync ? differs.filter((part) => fromHost(part)) : [];
    // An icon and color changed only on the host are taken as they are, and one changed here too
    // is left to copy by hand; the rest waits for the user.
    const take = incoming.filter((part) => part === 'appearance' && states[part] === 'host');
    const review = incoming.filter((part) => part !== 'appearance');
    let current = local;
    if (take.length > 0) {
      const updated = await this.importParts(project, onHost, take, [], undefined);
      current = this.build(updated, local.manifest.gitUrl);
    }
    this.agree(hostId, manifestId, project.id, onHost, current.manifest, [...agreed, ...take]);
    const outgoing = SSH_PROJECT_SETTINGS_PARTS.filter((part) => states[part] === 'local');
    if (outgoing.length > 0) {
      await this.publish(hostId, manifestId, project, current, onHost, outgoing);
    }
    return this.toAsk(hostId, manifestId, onHost, review);
  }

  /** Writes the parts changed here over the host's manifest, or all of them where it has none. */
  private async publish(
    hostId: string,
    manifestId: string,
    project: Project,
    local: Publishable,
    onHost: SshProjectManifest | undefined,
    parts: readonly SshProjectSettingsPart[]
  ): Promise<void> {
    const onHostIds = new Set(onHost?.quickCommands.map((entry) => entry.id));
    // With the project's own copies of them.
    const removedOnHost = (this.agreement(hostId, manifestId)?.hostCommands ?? [])
      .filter((id) => !onHostIds.has(id))
      .flatMap((id) => [id, copiedCommandId(id, project.id)]);
    const published = onHost
      ? publishableSshProjectManifest(
          withSshProjectManifestParts(onHost, local.manifest, parts, removedOnHost)
        )
      : local;
    if (!published.text) {
      logger.warn('Project settings are too large or invalid to publish on an SSH host', {
        hostId,
        projectId: project.id,
      });
      return;
    }
    if (!this.dependencies.host.hasHost(hostId)) return;
    await this.dependencies.host.write(hostId, manifestId, published.text);
    this.agree(hostId, manifestId, project.id, published.manifest, local.manifest, parts);
  }

  /** The parts of the host's changes the user wasn't asked about yet. */
  private toAsk(
    hostId: string,
    manifestId: string,
    onHost: SshProjectManifest,
    review: SshProjectSettingsPart[]
  ): SshProjectSettingsPart[] {
    const askedAbout = key(hostId, manifestId);
    if (review.length === 0) {
      this.asked.delete(askedAbout);
      return [];
    }
    // A newer change waits until the user answers about the one on screen.
    if (this.reviewing.has(askedAbout)) return [];
    const keys = sshProjectManifestPartKeys(onHost);
    const asked = this.asked.get(askedAbout);
    if (review.every((part) => asked?.[part] === keys[part])) return [];
    this.markAsked(hostId, manifestId, onHost, review);
    return review;
  }

  /** Records that the user was asked about the host's version of the parts. */
  private markAsked(
    hostId: string,
    manifestId: string,
    onHost: SshProjectManifest,
    parts: readonly SshProjectSettingsPart[]
  ): void {
    const keys = sshProjectManifestPartKeys(onHost);
    const asked = { ...this.asked.get(key(hostId, manifestId)) };
    for (const part of parts) asked[part] = keys[part];
    this.asked.set(key(hostId, manifestId), asked);
  }

  /** How the host's settings for a project compare with this installation's, part by part. */
  private compare(
    hostId: string,
    manifestId: string,
    onHost: SshProjectManifest,
    project: Project,
    local = this.build(project, onHost.gitUrl).manifest
  ): {
    local: SshProjectManifest;
    states: Record<SshProjectSettingsPart, PartState>;
    differs: SshProjectSettingsPart[];
    /** The project's Quick Commands here that the host removed since they agreed. */
    removed: string[];
  } {
    const agreed = this.agreement(hostId, manifestId);
    const removed = removedQuickCommands(onHost, local, agreed, project.id);
    return {
      local,
      states: partStates(
        sshProjectManifestPartKeys(onHost),
        sshProjectManifestPartKeys(local),
        agreed
      ),
      differs: differingParts(onHost, local, removed),
      removed,
    };
  }

  /** Copies the parts of the host's settings into the project and returns it updated. */
  private async importParts(
    project: Project,
    manifest: SshProjectManifest,
    parts: readonly SshProjectSettingsPart[],
    removed: readonly string[],
    keepInSync: boolean | undefined
  ): Promise<Project> {
    const { updates, actions } = this.plan(manifest, parts, project, removed);
    if (actions) this.dependencies.actions.replaceAll(actions);
    if (keepInSync !== undefined && !!project.keepSshSettingsInSync !== keepInSync) {
      updates.keepSshSettingsInSync = keepInSync;
    }
    if (Object.keys(updates).length === 0) return project;
    return this.dependencies.projects.update(project.id, updates);
  }

  /** The project updates, and the Quick Commands here, that copying the parts makes. */
  private plan(
    manifest: SshProjectManifest,
    parts: readonly SshProjectSettingsPart[],
    project: Project,
    removed: readonly string[]
  ): { updates: Partial<Project>; actions?: Action[] } {
    const take = new Set(parts);

    // Setup steps bring the Quick Commands they start, which the user reviews with them.
    const { setupSteps } = manifest.workspaceSetup;
    const { settings } = manifest;
    const referenced = new Set(
      take.has('workspaceSetup') ? setupSteps.map((step) => step.actionId) : []
    );
    const commands = manifest.quickCommands.filter(
      (entry) => take.has('quickCommands') || referenced.has(entry.id)
    );
    const removing = take.has('quickCommands') ? removed : [];
    const copied =
      commands.length > 0 || removing.length > 0
        ? this.planCommands(project.id, commands, removing)
        : undefined;
    const ids = copied?.ids ?? new Map<string, string>();

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
        ...(copied?.actions ?? this.dependencies.actions.list())
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
      } satisfies Partial<Project>);
    }
    return { updates, ...(copied ? { actions: copied.actions } : {}) };
  }

  /**
   * The Quick Commands here once the host's are added to the project, and the
   * id each has here. One only this project uses here is updated in place. One that other
   * projects or every project uses is never changed: the project shares it if
   * it does the same, else gets a copy of its own. Of the ones here, it
   * removes only `removed` from the project, so ones only this installation
   * has stay, and a global one stays too.
   */
  private planCommands(
    projectId: string,
    commands: SshProjectManifestQuickCommand[],
    removed: readonly string[]
  ): { ids: Map<string, string>; actions: Action[] } {
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
          byId.set(entry.id, {
            ...existing,
            projectIds: [...scoped, projectId],
          });
        }
        continue;
      }
      // The project's copy replaces the shared one for it.
      if (scoped?.includes(projectId)) {
        byId.set(entry.id, {
          ...existing,
          projectIds: scoped.filter((id) => id !== projectId),
        });
      }
      const id = copiedCommandId(entry.id, projectId);
      ids.set(entry.id, id);
      byId.set(id, localQuickCommand({ ...entry, id }, byId.get(id), projectId, presets));
    }
    for (const id of removed) {
      const existing = byId.get(id);
      if (!existing?.projectIds?.includes(projectId)) continue;
      const others = existing.projectIds.filter((other) => other !== projectId);
      if (others.length > 0) byId.set(id, { ...existing, projectIds: others });
      else byId.delete(id);
    }
    return { ids, actions: [...byId.values()] };
  }

  /** This installation's manifest for a project, as other installations would read it. */
  private build(project: Project, gitUrl: string): Publishable {
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

  /** The host's manifest by id, throwing when it is gone or can't be read here. */
  private async readOne(
    hostId: string,
    manifestId: string,
    background: boolean
  ): Promise<SshProjectManifest> {
    const manifest = (await this.read(hostId, background)).get(manifestId);
    if (manifest) return manifest;
    throw new Error(
      manifest === null
        ? 'That project’s settings on this SSH host can’t be read here.'
        : 'That project’s settings are no longer on this SSH host.'
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
    for (const [manifestId, text] of await this.dependencies.host.read(hostId, {
      background,
    })) {
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

  /** Records that the host's and this installation's settings agree in `parts`, as they are. */
  private agree(
    hostId: string,
    manifestId: string,
    projectId: string | undefined,
    onHost: SshProjectManifest,
    local: SshProjectManifest,
    parts: readonly SshProjectSettingsPart[]
  ): void {
    const agreements = this.loadAgreements();
    const current = agreements.get(key(hostId, manifestId));
    // With no parts agreed, it still records whose project it is, so the host is kept in sync.
    if (parts.length === 0 && (!projectId || current?.projectId === projectId)) return;
    const hostKeys = sshProjectManifestPartKeys(onHost);
    const localKeys = sshProjectManifestPartKeys(local);
    // What another project here agreed on, such as one removed since, doesn't carry over.
    const previous = projectId && current?.projectId !== projectId ? undefined : current;
    const next: Agreement = {
      ...(projectId ? { projectId } : {}),
      host: { ...previous?.host },
      local: { ...previous?.local },
      hostCommands: parts.includes('quickCommands')
        ? onHost.quickCommands.map((entry) => entry.id)
        : (previous?.hostCommands ?? []),
    };
    for (const part of parts) {
      next.host[part] = hostKeys[part];
      next.local[part] = localKeys[part];
    }
    if (
      current &&
      JSON.stringify(withSortedKeys(current)) === JSON.stringify(withSortedKeys(next))
    ) {
      return;
    }
    agreements.set(key(hostId, manifestId), next);
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
          const agreement = parseAgreement(entry);
          if (agreement) this.agreements.set(key, agreement);
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

type Publishable = ReturnType<typeof publishableSshProjectManifest>;

function partStates(
  hostKeys: Record<SshProjectSettingsPart, string>,
  localKeys: Record<SshProjectSettingsPart, string>,
  agreed: Agreement | undefined
): Record<SshProjectSettingsPart, PartState> {
  const states = {} as Record<SshProjectSettingsPart, PartState>;
  for (const part of SSH_PROJECT_SETTINGS_PARTS) {
    const hostChanged = hostKeys[part] !== agreed?.host[part];
    const localChanged = localKeys[part] !== agreed?.local[part];
    states[part] =
      hostKeys[part] === localKeys[part]
        ? 'same'
        : hostChanged
          ? localChanged
            ? 'both'
            : 'host'
          : localChanged
            ? 'local'
            : 'kept';
  }
  return states;
}

/**
 * The project's Quick Commands here, or its copies of them, that the host had
 * when they last agreed and has since removed.
 */
function removedQuickCommands(
  onHost: SshProjectManifest,
  local: SshProjectManifest,
  agreed: Agreement | undefined,
  projectId: string
): string[] {
  if (!agreed) return [];
  const onHostIds = new Set(onHost.quickCommands.map((entry) => entry.id));
  const here = new Set(local.quickCommands.map((entry) => entry.id));
  return agreed.hostCommands
    .filter((id) => !onHostIds.has(id))
    .flatMap((id) => [id, copiedCommandId(id, projectId)])
    .filter((id) => here.has(id));
}

function parseAgreement(value: unknown): Agreement | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { projectId, host, local, hostCommands } = value as Record<string, unknown>;
  const partKeys = (keys: unknown): PartKeys | undefined => {
    if (!keys || typeof keys !== 'object') return undefined;
    const parsed: PartKeys = {};
    for (const part of SSH_PROJECT_SETTINGS_PARTS) {
      const partKey = (keys as Record<string, unknown>)[part];
      if (typeof partKey === 'string') parsed[part] = partKey;
    }
    return parsed;
  };
  const hostKeys = partKeys(host);
  const localKeys = partKeys(local);
  if (!hostKeys || !localKeys || !Array.isArray(hostCommands)) return undefined;
  return {
    ...(typeof projectId === 'string' ? { projectId } : {}),
    host: hostKeys,
    local: localKeys,
    hostCommands: hostCommands.filter((id): id is string => typeof id === 'string'),
  };
}

/** Identifies the host's version of the parts the user is asked about. */
function askedKey(manifest: SshProjectManifest, parts: readonly SshProjectSettingsPart[]): string {
  const keys = sshProjectManifestPartKeys(manifest);
  return parts.map((part) => `${part}:${keys[part]}`).join(' ');
}

/** A project's own Quick Commands, as the user sees them in its settings. */
function projectQuickCommands(actions: readonly Action[], projectId: string): Action[] {
  return actions
    .filter((action) => action.projectIds?.includes(projectId))
    .map((action) => {
      const { projectIds: _projectIds, ...config } = actionConfig(action);
      return config;
    });
}

/** A project as copying would add it, before it takes the host's settings. */
function newProject(manifest: SshProjectManifest): Project {
  return {
    id: '',
    kind: 'git',
    name: manifest.name,
    repositoryPath: '',
    defaultBranchPrefix: '',
    createdAt: 0,
    order: 0,
    managed: true,
  };
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
  return {
    manifestId,
    name: manifest.name,
    ...(manifest.color !== undefined ? { color: manifest.color } : {}),
    ...(manifest.icon !== undefined ? { icon: manifest.icon } : {}),
    gitUrl: manifest.gitUrl,
    ...(projectId ? { projectId } : {}),
    differs,
    updatedAt: manifest.updatedAt,
  };
}
