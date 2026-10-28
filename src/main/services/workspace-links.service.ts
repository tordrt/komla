import { existsSync } from 'fs';
import { lstat, mkdir, readdir, readlink, rmdir, symlink, unlink } from 'fs/promises';
import { basename, dirname, join, posix as pathPosix, resolve } from 'path';

import { shellQuotePosix } from '../../shared/lib/shell-quote';
import { isSshWorkspace, type Workspace } from '../../shared/types';
import { createLogger } from '../lib/logger';

import { addGitExcludeRule } from './git/git-exclude';
import { sshWorkspaceService } from './ssh-workspace.service';
import { workspaceService } from './workspace.service';

const logger = createLogger('WorkspaceLinksService');

export const LINKED_WORKSPACES_DIR = 'linked-workspaces';

const GIT_EXCLUDE_LINE = `/${LINKED_WORKSPACES_DIR}/*`;
const GIT_EXCLUDE_HEADER =
  '# Added by Komla: linked-workspaces folder contains symlinks to sibling workspaces';
const REMOTE_LINK_RESULT_PREFIX = 'KOMLA_LINK_CREATED';

interface RemoteLinkCreation {
  createdAB: boolean;
  createdBA: boolean;
}

// Windows treats these basenames as reserved across all extensions
// (`con`, `con.txt`, `nul.anything` all fail to create). slugify already
// lowercases its output, so we compare lowercase.
const WINDOWS_RESERVED_LOWER = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/**
 * Slugify a string into something safe to use as a directory entry on all
 * platforms: lowercase, no spaces, no Windows-reserved chars, no leading/
 * trailing dots or dashes. Prefixes Windows-reserved device names (`con`,
 * `nul`, `com1`...) so the result remains creatable. Empty input yields ''.
 */
function slugify(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[<>:"/\\|?*\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!cleaned) return '';
  const basename = cleaned.split('.', 1)[0];
  if (WINDOWS_RESERVED_LOWER.has(basename)) return `_${cleaned}`;
  return cleaned;
}

function buildPeerLinkName(workspace: Workspace, prefix: string): string {
  const branch = workspace.branchName ? slugify(workspace.branchName) : '';
  let name: string;
  if (prefix && branch) name = `${prefix}-${branch}`;
  else if (prefix) name = prefix;
  else if (branch) name = branch;
  else {
    const workspacePath = isSshWorkspace(workspace)
      ? workspace.backend.remoteDirectory
      : workspace.workingDirectory;
    name = slugify(
      isSshWorkspace(workspace) ? pathPosix.basename(workspacePath) : basename(workspacePath)
    );
  }
  return name.slice(0, 80) || 'workspace';
}

async function getProjectPrefix(workspace: Workspace): Promise<string> {
  if (!workspace.projectId) return '';
  try {
    const { projectService } = await import('./project.service');
    const projectName = projectService.get(workspace.projectId)?.name;
    return projectName ? slugify(projectName) : '';
  } catch {
    return '';
  }
}

/**
 * Build possible symlink folder names for a peer. The first entry is the name
 * used for new links. Later entries are legacy fallbacks so unlink can still
 * remove symlinks created before project-name resolution existed.
 */
async function getPeerLinkNameCandidates(workspace: Workspace): Promise<string[]> {
  const prefixes: string[] = [];
  const projectPrefix = await getProjectPrefix(workspace);
  if (projectPrefix) prefixes.push(projectPrefix);
  const repoPrefix = workspace.repoName ? slugify(workspace.repoName) : '';
  if (repoPrefix) prefixes.push(repoPrefix);
  prefixes.push('');
  const names = prefixes.map((prefix) => buildPeerLinkName(workspace, prefix));
  return [...new Set(names)];
}

async function getPeerLinkName(workspace: Workspace): Promise<string> {
  return (await getPeerLinkNameCandidates(workspace))[0];
}

class WorkspaceLinksService {
  private readonly workspaceTransactions = new Map<string, Promise<void>>();

  /**
   * Bidirectionally link `originId` to each id in `targetIds`. For each pair
   * (origin, target) this creates a symlink in BOTH directions, ensures the
   * `linked-workspaces/` folder exists on both sides, ignores that Komla-managed
   * folder in git, and updates the `linkedWorkspaceIds` arrays on both workspaces.
   */
  async link(originId: string, targetIds: string[]): Promise<void> {
    if (!workspaceService.get(originId)) throw new Error(`Workspace ${originId} not found`);
    this.assertNotDeleting(originId);

    for (const targetId of new Set(targetIds)) {
      if (targetId === originId) continue;
      const origin = workspaceService.get(originId);
      const target = workspaceService.get(targetId);
      if (!origin) throw new Error(`Workspace ${originId} not found`);
      if (!target) {
        logger.warn(`Skipping link: target workspace ${targetId} not found`);
        continue;
      }
      try {
        this.validatePair(origin, target);
        if (isSshWorkspace(origin) && isSshWorkspace(target)) {
          await this.withWorkspaceTransactions([originId, targetId], async () => {
            const liveOrigin = workspaceService.get(originId);
            const liveTarget = workspaceService.get(targetId);
            if (!liveOrigin) throw new Error(`Workspace ${originId} not found`);
            if (!liveTarget) {
              logger.warn(`Skipping link: target workspace ${targetId} not found`);
              return;
            }
            this.assertNotDeleting(originId, targetId);
            this.validatePair(liveOrigin, liveTarget);
            await this.createPair(liveOrigin, liveTarget);
          });
        } else {
          await this.createPair(origin, target);
        }
      } catch (error) {
        logger.error(`Failed to link ${origin.id} ↔ ${target.id}:`, error);
        throw error;
      }
    }
  }

  /**
   * Remove the bidirectional link between `originId` and `targetId`.
   * Best-effort: missing files are ignored.
   */
  async unlink(originId: string, targetId: string): Promise<void> {
    const origin = workspaceService.get(originId);
    const target = workspaceService.get(targetId);
    if (!origin && !target) return;
    if (
      (origin !== undefined && isSshWorkspace(origin)) ||
      (target !== undefined && isSshWorkspace(target))
    ) {
      await this.withWorkspaceTransactions([originId, targetId], () =>
        this.unlinkPair(originId, targetId)
      );
      return;
    }
    await this.unlinkPair(originId, targetId);
  }

  private async unlinkPair(originId: string, targetId: string): Promise<void> {
    const origin = workspaceService.get(originId);
    const target = workspaceService.get(targetId);
    if (!origin && !target) return;
    const shouldPersistImmediately =
      (origin !== undefined && isSshWorkspace(origin)) ||
      (target !== undefined && isSshWorkspace(target));
    const previousOriginLinks = origin?.linkedWorkspaceIds
      ? [...origin.linkedWorkspaceIds]
      : undefined;
    const previousTargetLinks = target?.linkedWorkspaceIds
      ? [...target.linkedWorkspaceIds]
      : undefined;
    let removedRemotePair = false;

    if (origin && target) {
      if (
        isSshWorkspace(origin) &&
        isSshWorkspace(target) &&
        origin.backend.hostId === target.backend.hostId
      ) {
        await this.removeRemotePair(origin, target);
        removedRemotePair = true;
      } else if (!isSshWorkspace(origin) && !isSshWorkspace(target)) {
        await this.removeSymlink(origin, target);
        await this.removeSymlink(target, origin);
      }
    } else if (origin) {
      // Target gone: still try to clean up origin's stale symlink if we can guess it
      await this.cleanupStaleSymlinksForWorkspace(origin);
    } else if (target) {
      await this.cleanupStaleSymlinksForWorkspace(target);
    }

    const updateAndPersistMetadata = async (save?: () => Promise<void>): Promise<void> => {
      if (origin) {
        const updated = (origin.linkedWorkspaceIds ?? []).filter((id) => id !== targetId);
        workspaceService.update(origin.id, { linkedWorkspaceIds: updated });
        await this.removeFolderIfEmpty(origin);
      }
      if (target) {
        const updated = (target.linkedWorkspaceIds ?? []).filter((id) => id !== originId);
        workspaceService.update(target.id, { linkedWorkspaceIds: updated });
        await this.removeFolderIfEmpty(target);
      }
      if (shouldPersistImmediately) {
        try {
          if (!save) throw new Error('SSH link persistence transaction is unavailable');
          await save();
        } catch (error) {
          if (origin) {
            workspaceService.update(origin.id, { linkedWorkspaceIds: previousOriginLinks });
          }
          if (target) {
            workspaceService.update(target.id, { linkedWorkspaceIds: previousTargetLinks });
          }
          if (
            removedRemotePair &&
            origin &&
            target &&
            isSshWorkspace(origin) &&
            isSshWorkspace(target)
          ) {
            try {
              await this.createRemotePair(origin, target);
            } catch (rollbackError) {
              logger.warn(
                `Failed to restore remote pair ${origin.id} ↔ ${target.id}:`,
                rollbackError
              );
            }
          }
          throw error;
        }
      }
    };
    if (shouldPersistImmediately) {
      await workspaceService.withPersistenceTransaction(updateAndPersistMetadata);
    } else {
      await updateAndPersistMetadata();
    }
  }

  private async withWorkspaceTransactions<T>(
    workspaceIds: string[],
    transaction: () => Promise<T>
  ): Promise<T> {
    const ids = [...new Set(workspaceIds)].sort();
    const predecessors = ids.map((id) => this.workspaceTransactions.get(id) ?? Promise.resolve());
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const id of ids) this.workspaceTransactions.set(id, current);

    await Promise.all(predecessors);
    try {
      return await transaction();
    } finally {
      release();
      for (const id of ids) {
        if (this.workspaceTransactions.get(id) === current) {
          this.workspaceTransactions.delete(id);
        }
      }
    }
  }

  /**
   * Remove all links involving `workspaceId`. Called when a workspace is being
   * deleted so peers don't hold dangling symlinks or stale ids.
   */
  async unlinkAll(workspaceId: string): Promise<void> {
    const workspace = workspaceService.get(workspaceId);
    if (!workspace) return;
    const peers = [...(workspace.linkedWorkspaceIds ?? [])];
    for (const peerId of peers) {
      try {
        await this.unlink(workspaceId, peerId);
      } catch (error) {
        logger.warn(`unlinkAll: failed to remove link ${workspaceId} ↔ ${peerId}:`, error);
      }
    }
    await this.cleanupLinksPointingTo(workspace);
  }

  async reconcileAllFromDisk(): Promise<boolean> {
    const workspaces = workspaceService.list();
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    const idByPath = new Map(
      workspaces
        .filter((workspace) => !isSshWorkspace(workspace))
        .map((workspace) => [resolve(workspace.workingDirectory), workspace.id])
    );
    let changed = false;

    for (const workspace of workspaces) {
      // SSH link metadata is persisted locally. Reaching out to every configured
      // host during startup would make disconnected hosts block reconciliation.
      if (isSshWorkspace(workspace)) {
        changed = this.pruneMissingSshPeers(workspace, workspaceIds) || changed;
        continue;
      }
      const folder = this.getFolderPath(workspace);
      const linkedIds = new Set<string>();
      if (existsSync(folder)) {
        // Heal `info/exclude` for folders that pre-date the exclude logic or
        // where a prior write was skipped (silent early-returns in
        // addToGitExclude). Idempotent: no-op when the line already exists.
        await this.addToGitExclude(workspace);
        let entries: string[];
        try {
          entries = await readdir(folder);
        } catch {
          entries = [];
        }
        for (const entry of entries) {
          const linkPath = join(folder, entry);
          const targetPath = await this.readSymlinkTarget(linkPath);
          if (!targetPath) continue;
          const linkedId = idByPath.get(targetPath);
          if (linkedId && linkedId !== workspace.id) linkedIds.add(linkedId);
        }
      }

      const next = [...linkedIds].sort();
      const current = [...(workspace.linkedWorkspaceIds ?? [])].sort();
      if (next.length === current.length && next.every((id, index) => id === current[index])) {
        continue;
      }
      workspaceService.update(workspace.id, { linkedWorkspaceIds: next });
      changed = true;
    }

    return changed;
  }

  private pruneMissingSshPeers(workspace: Workspace, workspaceIds: Set<string>): boolean {
    const current = workspace.linkedWorkspaceIds ?? [];
    const next = current.filter((id) => workspaceIds.has(id));
    if (next.length === current.length) return false;
    workspaceService.update(workspace.id, { linkedWorkspaceIds: next });
    return true;
  }

  private async createPair(a: Workspace, b: Workspace): Promise<void> {
    if (isSshWorkspace(a) && isSshWorkspace(b)) {
      const createdRemoteLinks = await this.createRemotePair(a, b);
      await workspaceService.withPersistenceTransaction(async (save) => {
        const liveA = workspaceService.get(a.id);
        const liveB = workspaceService.get(b.id);
        const deletingId = [a.id, b.id].find((id) => workspaceService.isDeleting(id));
        if (!liveA || !liveB || deletingId) {
          await this.rollbackRemoteLinkCreation(a, b, createdRemoteLinks);
          if (deletingId) throw new Error(`Workspace ${deletingId} is being deleted`);
          throw new Error(`Workspace ${!liveA ? a.id : b.id} not found`);
        }
        const previousALinks = liveA.linkedWorkspaceIds ? [...liveA.linkedWorkspaceIds] : undefined;
        const previousBLinks = liveB.linkedWorkspaceIds ? [...liveB.linkedWorkspaceIds] : undefined;
        this.updatePairMetadata(liveA, liveB);
        try {
          await save();
        } catch (error) {
          if (workspaceService.get(a.id)) {
            workspaceService.update(a.id, { linkedWorkspaceIds: previousALinks });
          }
          if (workspaceService.get(b.id)) {
            workspaceService.update(b.id, { linkedWorkspaceIds: previousBLinks });
          }
          await this.rollbackRemoteLinkCreation(a, b, createdRemoteLinks);
          throw error;
        }
      });
      return;
    }

    if (!existsSync(a.workingDirectory)) {
      throw new Error(`Workspace ${a.id} working directory missing: ${a.workingDirectory}`);
    }
    if (!existsSync(b.workingDirectory)) {
      throw new Error(`Workspace ${b.id} working directory missing: ${b.workingDirectory}`);
    }

    await this.ensureFolder(a);
    await this.ensureFolder(b);

    const createdAB = await this.createSymlink(a, b);
    try {
      await this.createSymlink(b, a);
    } catch (error) {
      // Roll back ONLY if we created A→B in this call — otherwise an
      // already-valid A→B (e.g. from a prior partial-success retry) would
      // be wrongly deleted.
      if (createdAB) {
        try {
          await this.removeSymlink(a, b);
        } catch (cleanupError) {
          logger.warn(`Failed to roll back partial pair ${a.id} → ${b.id}:`, cleanupError);
        }
      }
      throw error;
    }

    this.updatePairMetadata(a, b);
  }

  private async rollbackRemoteLinkCreation(
    a: Workspace & { backend: Extract<Workspace['backend'], { kind: 'ssh' }> },
    b: Workspace & { backend: Extract<Workspace['backend'], { kind: 'ssh' }> },
    createdLinks: RemoteLinkCreation
  ): Promise<void> {
    if (!createdLinks.createdAB && !createdLinks.createdBA) return;
    try {
      await this.removeRemotePair(a, b, createdLinks);
    } catch (rollbackError) {
      logger.warn(`Failed to roll back remote pair ${a.id} ↔ ${b.id}:`, rollbackError);
    }
  }

  private updatePairMetadata(a: Workspace, b: Workspace): void {
    const liveA = workspaceService.get(a.id) ?? a;
    const aLinks = new Set(liveA.linkedWorkspaceIds ?? []);
    aLinks.add(b.id);
    workspaceService.update(a.id, { linkedWorkspaceIds: [...aLinks] });

    const liveB = workspaceService.get(b.id) ?? b;
    const bLinks = new Set(liveB.linkedWorkspaceIds ?? []);
    bLinks.add(a.id);
    workspaceService.update(b.id, { linkedWorkspaceIds: [...bLinks] });
  }

  private validatePair(a: Workspace, b: Workspace): void {
    if (isSshWorkspace(a)) {
      if (!isSshWorkspace(b)) {
        throw new Error('SSH workspaces can only be linked to other SSH workspaces');
      }
      if (a.backend.hostId !== b.backend.hostId) {
        throw new Error('SSH workspaces can only be linked on the same SSH host');
      }
      return;
    }
    if (isSshWorkspace(b)) {
      throw new Error('Local workspaces can only be linked to other local workspaces');
    }
  }

  private assertNotDeleting(...workspaceIds: string[]): void {
    const deletingId = workspaceIds.find((id) => workspaceService.isDeleting(id));
    if (deletingId) throw new Error(`Workspace ${deletingId} is being deleted`);
  }

  private async createRemotePair(
    a: Workspace & { backend: Extract<Workspace['backend'], { kind: 'ssh' }> },
    b: Workspace & { backend: Extract<Workspace['backend'], { kind: 'ssh' }> }
  ): Promise<RemoteLinkCreation> {
    const nameAB = await getPeerLinkName(b);
    const nameBA = await getPeerLinkName(a);
    const fallbackAB = `${nameAB}-${b.id.slice(0, 8)}`;
    const fallbackBA = `${nameBA}-${a.id.slice(0, 8)}`;
    const q = shellQuotePosix;
    const command = [
      `owner_a=${q(a.backend.remoteDirectory)}`,
      `owner_b=${q(b.backend.remoteDirectory)}`,
      `name_ab=${q(nameAB)}`,
      `name_ba=${q(nameBA)}`,
      `fallback_ab=${q(fallbackAB)}`,
      `fallback_ba=${q(fallbackBA)}`,
      'ensure_exclude() {',
      '  owner="$1"',
      '  exclude=$(cd "$owner" && git rev-parse --git-path info/exclude 2>/dev/null) || return 0',
      '  case "$exclude" in /*) ;; *) exclude="$owner/$exclude" ;; esac',
      '  mkdir -p "$(dirname "$exclude")" || return $?',
      '  touch "$exclude" || return $?',
      `  if ! grep -Fqx ${q(GIT_EXCLUDE_LINE)} "$exclude"; then`,
      '    if [ -s "$exclude" ] && [ "$(tail -c 1 "$exclude" | wc -l)" -eq 0 ]; then',
      `      printf '\n' >> "$exclude" || return $?`,
      '    fi',
      `    printf '%s\n%s\n' ${q(GIT_EXCLUDE_HEADER)} ${q(GIT_EXCLUDE_LINE)} >> "$exclude" || return $?`,
      '  fi',
      '}',
      'ensure_link() {',
      '  owner="$1"',
      '  peer="$2"',
      '  name="$3"',
      '  fallback="$4"',
      '  [ -d "$owner" ] || { printf "Workspace directory missing: %s\\n" "$owner" >&2; return 1; }',
      `  folder="$owner/${LINKED_WORKSPACES_DIR}"`,
      '  [ ! -L "$folder" ] || { printf "Refusing symlinked link directory: %s\\n" "$folder" >&2; return 1; }',
      '  mkdir -p "$folder" || return $?',
      '  [ -d "$folder" ] && [ ! -L "$folder" ] || { printf "Invalid link directory: %s\\n" "$folder" >&2; return 1; }',
      '  ensure_exclude "$owner" || return $?',
      '  link_created=0',
      '  for candidate in "$folder/$name" "$folder/$fallback"; do',
      '    if [ -L "$candidate" ] && [ "$(readlink "$candidate")" = "$peer" ]; then',
      '      link_path="$candidate"',
      '      return 0',
      '    fi',
      '    if [ ! -e "$candidate" ]; then',
      '      [ ! -L "$candidate" ] || rm -f "$candidate" || return $?',
      '      ln -s "$peer" "$candidate" || return $?',
      '      link_created=1',
      '      link_path="$candidate"',
      '      return 0',
      '    fi',
      '  done',
      '  printf "Cannot allocate link path for %s in %s\\n" "$peer" "$folder" >&2',
      '  return 1',
      '}',
      'ensure_link "$owner_a" "$owner_b" "$name_ab" "$fallback_ab" || exit $?',
      'created_ab=$link_created',
      'path_ab=$link_path',
      'if ensure_link "$owner_b" "$owner_a" "$name_ba" "$fallback_ba"; then',
      '  :',
      'else',
      '  status=$?',
      '  [ "$created_ab" -eq 0 ] || rm -f "$path_ab"',
      '  exit "$status"',
      'fi',
      'created_ba=$link_created',
      `printf '%s %s %s\\n' ${q(REMOTE_LINK_RESULT_PREFIX)} "$created_ab" "$created_ba"`,
    ].join('\n');

    const host = sshWorkspaceService.getHost(a.backend.hostId);
    const output = await sshWorkspaceService.run(host, command);
    const result = output.match(/^KOMLA_LINK_CREATED ([01]) ([01])$/m);
    if (!result) {
      throw new Error('Remote workspace link command returned an invalid result');
    }
    return { createdAB: result[1] === '1', createdBA: result[2] === '1' };
  }

  private async removeRemotePair(
    a: Workspace & { backend: Extract<Workspace['backend'], { kind: 'ssh' }> },
    b: Workspace & { backend: Extract<Workspace['backend'], { kind: 'ssh' }> },
    links: RemoteLinkCreation = { createdAB: true, createdBA: true }
  ): Promise<void> {
    if (!links.createdAB && !links.createdBA) return;
    const namesAB = await this.getRemoteLinkNameCandidates(b);
    const namesBA = await this.getRemoteLinkNameCandidates(a);
    const q = shellQuotePosix;
    const command = [
      `owner_a=${q(a.backend.remoteDirectory)}`,
      `owner_b=${q(b.backend.remoteDirectory)}`,
      'unlink_matching() {',
      '  owner="$1"',
      '  peer="$2"',
      '  shift 2',
      '  removed_path=',
      `  folder="$owner/${LINKED_WORKSPACES_DIR}"`,
      '  [ ! -L "$folder" ] || { printf "Refusing symlinked link directory: %s\\n" "$folder" >&2; return 1; }',
      '  [ -d "$folder" ] || return 0',
      '  for name in "$@"; do',
      '    candidate="$folder/$name"',
      '    if [ -L "$candidate" ] && [ "$(readlink "$candidate")" = "$peer" ]; then',
      '      rm -f "$candidate" || return $?',
      '      removed_path="$candidate"',
      '      return 0',
      '    fi',
      '  done',
      '  for candidate in "$folder"/*; do',
      '    [ -L "$candidate" ] || continue',
      '    [ "$(readlink "$candidate")" = "$peer" ] || continue',
      '    rm -f "$candidate" || return $?',
      '    removed_path="$candidate"',
      '    break',
      '  done',
      '}',
      ...(links.createdAB
        ? [
            `unlink_matching "$owner_a" "$owner_b" ${namesAB.map(q).join(' ')} || exit $?`,
            'removed_ab="$removed_path"',
          ]
        : ['removed_ab=']),
      ...(links.createdBA
        ? [`if unlink_matching "$owner_b" "$owner_a" ${namesBA.map(q).join(' ')}; then`]
        : ['if true; then']),
      `  rmdir "$owner_a/${LINKED_WORKSPACES_DIR}" 2>/dev/null || true`,
      `  rmdir "$owner_b/${LINKED_WORKSPACES_DIR}" 2>/dev/null || true`,
      'else',
      '  status=$?',
      '  if [ -n "$removed_ab" ]; then',
      '    ln -s "$owner_b" "$removed_ab" || {',
      '      rollback_status=$?',
      '      printf "Failed to restore remote workspace link: %s\\n" "$removed_ab" >&2',
      '      exit "$rollback_status"',
      '    }',
      '  fi',
      '  exit "$status"',
      'fi',
    ].join('\n');

    const host = sshWorkspaceService.getHost(a.backend.hostId);
    await sshWorkspaceService.run(host, command);
  }

  private async getRemoteLinkNameCandidates(peer: Workspace): Promise<string[]> {
    const names = await getPeerLinkNameCandidates(peer);
    return [...new Set(names.flatMap((name) => [name, `${name}-${peer.id.slice(0, 8)}`]))];
  }

  private async cleanupStaleSymlinksForWorkspace(workspace: Workspace): Promise<void> {
    if (!isSshWorkspace(workspace)) {
      await this.cleanupStaleSymlinks(workspace);
      return;
    }
    const q = shellQuotePosix;
    const folder = pathPosix.join(workspace.backend.remoteDirectory, LINKED_WORKSPACES_DIR);
    const command = [
      `folder=${q(folder)}`,
      '[ ! -L "$folder" ] || { printf "Refusing symlinked link directory: %s\\n" "$folder" >&2; exit 1; }',
      '[ -d "$folder" ] || exit 0',
      'for candidate in "$folder"/*; do',
      '  [ -L "$candidate" ] || continue',
      '  if [ ! -e "$candidate" ]; then',
      '    rm -f "$candidate" || exit $?',
      '  fi',
      'done',
      'rmdir "$folder" 2>/dev/null || true',
    ].join('\n');
    const host = sshWorkspaceService.getHost(workspace.backend.hostId);
    await sshWorkspaceService.run(host, command);
  }

  private async ensureFolder(workspace: Workspace): Promise<void> {
    const folder = this.getFolderPath(workspace);
    await mkdir(folder, { recursive: true });
    await this.addToGitExclude(workspace);
  }

  /**
   * Returns true if a new symlink was created or replaced, false if a valid
   * symlink to peer already existed (idempotent no-op). Callers can use this
   * to know whether they need to roll back on a subsequent failure.
   */
  private async createSymlink(owner: Workspace, peer: Workspace): Promise<boolean> {
    const folder = this.getFolderPath(owner);
    const peerPath = resolve(peer.workingDirectory);
    const linkPath = await this.resolvePeerLinkPath(folder, peer);

    // Idempotent re-link: chosen path already points at this peer.
    if (await this.linkPointsTo(linkPath, peerPath)) return false;

    if (await this.entryExists(linkPath)) {
      try {
        await unlink(linkPath);
      } catch {
        // Could be a non-symlink directory — refuse to clobber.
        throw new Error(`Cannot create link: ${linkPath} already exists and isn't replaceable`);
      }
    }

    const type = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(peer.workingDirectory, linkPath, type);
    return true;
  }

  private async removeSymlink(owner: Workspace, peer: Workspace): Promise<void> {
    const folder = this.getFolderPath(owner);
    if (!existsSync(folder)) return;
    const linkPath = await this.findExistingPeerLink(owner, peer);
    if (!linkPath) return;
    try {
      await unlink(linkPath);
    } catch (error) {
      logger.warn(`Failed to remove link ${linkPath}:`, error);
    }
  }

  /**
   * If a peer was deleted before we could remove its symlink, scan our folder
   * and drop entries pointing at non-existent paths.
   */
  private async cleanupStaleSymlinks(owner: Workspace): Promise<void> {
    const folder = this.getFolderPath(owner);
    if (!existsSync(folder)) return;
    const entries = await readdir(folder);
    for (const entry of entries) {
      const linkPath = join(folder, entry);
      if (!existsSync(linkPath)) {
        try {
          await unlink(linkPath);
        } catch {
          // ignore
        }
      }
    }
  }

  private async findExistingPeerLink(owner: Workspace, peer: Workspace): Promise<string | null> {
    const folder = this.getFolderPath(owner);
    const peerPath = resolve(peer.workingDirectory);
    // Two peers can collide on the same slug — A linked first as `foo`, B
    // gets the `-<id>` fallback. We must verify the symlink actually points
    // at this peer before returning it, otherwise unlink-by-base-name can
    // delete the wrong peer's link.
    for (const base of await getPeerLinkNameCandidates(peer)) {
      const desired = join(folder, base);
      if (await this.linkPointsTo(desired, peerPath)) return desired;
      const fallback = join(folder, `${base}-${peer.id.slice(0, 8)}`);
      if (await this.linkPointsTo(fallback, peerPath)) return fallback;
    }
    // Last-resort scan: target paths can have moved if a peer's working
    // directory was renamed. Match by readlink across all entries to catch
    // legacy/stale links that no longer line up with current candidates.
    if (!existsSync(folder)) return null;
    const entries = await readdir(folder);
    for (const entry of entries) {
      const linkPath = join(folder, entry);
      if (await this.linkPointsTo(linkPath, peerPath)) return linkPath;
    }
    return null;
  }

  private async cleanupLinksPointingTo(target: Workspace): Promise<void> {
    if (isSshWorkspace(target)) {
      await this.cleanupRemoteLinksPointingTo(target);
      return;
    }
    const targetPath = resolve(target.workingDirectory);
    for (const workspace of workspaceService.list()) {
      if (workspace.id === target.id) continue;
      if (isSshWorkspace(workspace)) continue;
      const folder = this.getFolderPath(workspace);
      if (!existsSync(folder)) continue;
      const entries = await readdir(folder);
      let removed = false;
      for (const entry of entries) {
        const linkPath = join(folder, entry);
        if (!(await this.linkPointsTo(linkPath, targetPath))) continue;
        try {
          await unlink(linkPath);
          removed = true;
        } catch (error) {
          logger.warn(`Failed to remove stale workspace link ${linkPath}:`, error);
        }
      }
      const updated = (workspace.linkedWorkspaceIds ?? []).filter((id) => id !== target.id);
      if (updated.length !== (workspace.linkedWorkspaceIds ?? []).length) {
        workspaceService.update(workspace.id, { linkedWorkspaceIds: updated });
      }
      if (removed) await this.removeFolderIfEmpty(workspace);
    }
  }

  private async cleanupRemoteLinksPointingTo(
    target: Workspace & { backend: Extract<Workspace['backend'], { kind: 'ssh' }> }
  ): Promise<void> {
    const owners = workspaceService
      .list()
      .filter(
        (workspace) =>
          workspace.id !== target.id &&
          isSshWorkspace(workspace) &&
          workspace.backend.hostId === target.backend.hostId
      );
    if (owners.length === 0) return;

    const q = shellQuotePosix;
    const command = [
      `target=${q(target.backend.remoteDirectory)}`,
      'cleanup_owner() {',
      `  folder="$1/${LINKED_WORKSPACES_DIR}"`,
      '  [ ! -L "$folder" ] || { printf "Refusing symlinked link directory: %s\\n" "$folder" >&2; return 1; }',
      '  [ -d "$folder" ] || return 0',
      '  for candidate in "$folder"/*; do',
      '    [ -L "$candidate" ] || continue',
      '    [ "$(readlink "$candidate")" = "$target" ] || continue',
      '    rm -f "$candidate" || return $?',
      '  done',
      '  rmdir "$folder" 2>/dev/null || true',
      '}',
      ...owners.map((workspace) => {
        if (!isSshWorkspace(workspace)) return '';
        return `cleanup_owner ${q(workspace.backend.remoteDirectory)} || exit $?`;
      }),
    ].join('\n');
    const host = sshWorkspaceService.getHost(target.backend.hostId);
    try {
      await sshWorkspaceService.run(host, command);
    } finally {
      await this.withWorkspaceTransactions(
        owners.map((owner) => owner.id),
        () =>
          workspaceService.withPersistenceTransaction(async (save) => {
            let metadataChanged = false;
            for (const owner of owners) {
              const liveOwner = workspaceService.get(owner.id);
              if (!liveOwner) continue;
              const current = liveOwner.linkedWorkspaceIds ?? [];
              const updated = current.filter((id) => id !== target.id);
              if (updated.length !== current.length) {
                workspaceService.update(owner.id, { linkedWorkspaceIds: updated });
                metadataChanged = true;
              }
            }
            if (metadataChanged) {
              await save();
            }
          })
      );
    }
  }

  private async linkPointsTo(linkPath: string, targetPath: string): Promise<boolean> {
    return (await this.readSymlinkTarget(linkPath)) === targetPath;
  }

  private async readSymlinkTarget(linkPath: string): Promise<string | null> {
    try {
      const stats = await lstat(linkPath);
      if (!stats.isSymbolicLink()) return null;
      return resolve(dirname(linkPath), await readlink(linkPath));
    } catch {
      return null;
    }
  }

  private async entryExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pick a non-colliding path for `peer`'s symlink within `folder`. Prefers
   * `<project>-<branch>`; falls back to `<base>-<id-prefix>` on collision.
   * Returns an existing path when it already points at peer so re-linking is
   * idempotent. Refuses to return a path occupied by something other than
   * peer — better to throw than overwrite an unrelated entry (which could be
   * another peer's canonical link or a foreign file).
   */
  private async resolvePeerLinkPath(folder: string, peer: Workspace): Promise<string> {
    const peerPath = resolve(peer.workingDirectory);
    const base = await getPeerLinkName(peer);
    const candidate = join(folder, base);

    // Idempotent: path already points at peer, reuse it.
    if (await this.linkPointsTo(candidate, peerPath)) return candidate;
    // Path is empty or a broken symlink (existsSync follows symlinks) — safe to write.
    if (!existsSync(candidate)) return candidate;

    const fallback = join(folder, `${base}-${peer.id.slice(0, 8)}`);
    if (await this.linkPointsTo(fallback, peerPath)) return fallback;
    if (!existsSync(fallback)) return fallback;

    throw new Error(
      `Cannot allocate link path for ${peer.id} in ${folder}: both ${base} and ${base}-${peer.id.slice(0, 8)} are occupied by unrelated entries`
    );
  }

  private getFolderPath(workspace: Workspace): string {
    return join(workspace.workingDirectory, LINKED_WORKSPACES_DIR);
  }

  private async removeFolderIfEmpty(workspace: Workspace): Promise<void> {
    const remaining = (workspace.linkedWorkspaceIds ?? []).filter((id) => id !== workspace.id);
    // Re-fetch since `workspace` is a snapshot; the live entry has the update applied.
    const live = workspaceService.get(workspace.id);
    const liveRemaining = live?.linkedWorkspaceIds ?? remaining;
    if (liveRemaining.length > 0) return;
    const folder = this.getFolderPath(workspace);
    if (!existsSync(folder)) return;
    // Sweep only symlinks that look komla-owned: targets that match a known
    // workspace working directory, or broken targets (orphans from a peer
    // that was deleted). Foreign symlinks pointing at unrelated paths and
    // any non-symlink content survive. Then rmdir non-recursively.
    let entries: string[];
    try {
      entries = await readdir(folder);
    } catch (error) {
      logger.warn(`Failed to scan linked-workspaces for ${workspace.id}:`, error);
      return;
    }
    const knownWorkspacePaths = new Set(
      workspaceService.list().map((w) => resolve(w.workingDirectory))
    );
    for (const entry of entries) {
      const linkPath = join(folder, entry);
      const target = await this.readSymlinkTarget(linkPath);
      if (target === null) continue; // not a symlink
      const isOrphan = !existsSync(target);
      const pointsAtKnownWorkspace = knownWorkspacePaths.has(target);
      if (!isOrphan && !pointsAtKnownWorkspace) continue;
      try {
        await unlink(linkPath);
      } catch (error) {
        logger.warn(`Failed to remove orphan symlink ${linkPath}:`, error);
      }
    }
    try {
      await rmdir(folder);
    } catch {
      // Folder still has content — leave it.
    }
  }

  /**
   * Add `linked-workspaces/` to the `info/exclude` git reads for this workspace so Komla-owned
   * symlinks do not appear as untracked files in commit flows.
   */
  private async addToGitExclude(workspace: Workspace): Promise<void> {
    try {
      await addGitExcludeRule(workspace.workingDirectory, GIT_EXCLUDE_HEADER, GIT_EXCLUDE_LINE);
    } catch (error) {
      logger.warn(`Failed to add linked-workspaces to git exclude for ${workspace.id}:`, error);
    }
  }
}

export const workspaceLinksService = new WorkspaceLinksService();

// Exported for tests
export const __testing = {
  slugify,
  getPeerLinkName,
  GIT_EXCLUDE_LINE,
};
