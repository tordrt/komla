import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

import { is } from '@electron-toolkit/utils';
import { app, net } from 'electron';
import pkg from 'electron-updater';
import { load } from 'js-yaml';

import { IPC } from '../../shared/constants/ipc-channels';
import { DOWNLOADS_BASE_URL } from '../lib/api-urls';
import { getBuildDistribution } from '../lib/build-info';
import { createLogger } from '../lib/logger';
import { compareSemver } from '../lib/semver';

import { announcementService } from './announcement.service';
import { licenseService } from './license.service';
import { getKomlaBasePath } from './paths';
import { windowService } from './window.service';

import type { UpdateInfo } from 'electron-updater';

declare const __KOMLA_ENV__: string;

const { autoUpdater } = pkg;

const logger = createLogger('UpdateService');
const isStaging = typeof __KOMLA_ENV__ !== 'undefined' && __KOMLA_ENV__ === 'staging';

const PENDING_UPDATE_FILE = 'pending-update.json';
/** Max age (ms) of a pending-update marker before we ignore it. */
const PENDING_UPDATE_MAX_AGE_MS = 30_000;
/** Delay (ms) before relaunching when the old version starts after an update. */
const RELAUNCH_DELAY_MS = 1_500;

interface PendingUpdate {
  version: string;
  timestamp: number;
}

function getPendingUpdatePath(): string {
  return join(getKomlaBasePath(), PENDING_UPDATE_FILE);
}

/**
 * Write a marker file so the next launch knows an update was in progress.
 * Called right before quitAndInstall().
 */
function writePendingUpdate(version: string): void {
  const data: PendingUpdate = { version, timestamp: Date.now() };
  const filePath = getPendingUpdatePath();
  mkdirSync(getKomlaBasePath(), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data));
}

/**
 * Remove the pending-update marker (update applied successfully or stale).
 */
function clearPendingUpdate(): void {
  try {
    unlinkSync(getPendingUpdatePath());
  } catch {
    // File doesn't exist — fine.
  }
}

/**
 * Call very early in startup (before app.whenReady).
 * If macOS relaunched the old version before Squirrel finished replacing
 * the app bundle, this delays briefly and relaunches so the new binary
 * gets picked up.
 *
 * Returns true if the app is about to relaunch (caller should skip further init).
 */
export function handlePendingUpdateRelaunch(): boolean {
  if (process.platform !== 'darwin') {
    // Only macOS has the Squirrel/reopen race.
    clearPendingUpdate();
    return false;
  }

  const filePath = getPendingUpdatePath();
  if (!existsSync(filePath)) {
    return false;
  }

  let pending: PendingUpdate;
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (typeof raw.version !== 'string' || typeof raw.timestamp !== 'number') {
      throw new Error('invalid marker shape');
    }
    pending = raw;
  } catch {
    clearPendingUpdate();
    return false;
  }

  const currentVersion = app.getVersion();

  // Update applied successfully — clean up.
  if (currentVersion === pending.version) {
    logger.info(`Update to v${pending.version} applied successfully`);
    clearPendingUpdate();
    return false;
  }

  // Marker is stale or has a future timestamp (clock skew).
  const age = Date.now() - pending.timestamp;
  if (age > PENDING_UPDATE_MAX_AGE_MS || age < 0) {
    logger.warn(
      `Stale pending-update marker (expected v${pending.version}, running v${currentVersion}, age=${age}ms). Clearing.`
    );
    clearPendingUpdate();
    return false;
  }

  // We're the old version and the marker is fresh — Squirrel is likely still
  // replacing the .app bundle.  Wait briefly and relaunch.
  logger.info(
    `Running v${currentVersion} but v${pending.version} expected — relaunching in ${RELAUNCH_DELAY_MS}ms`
  );
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, RELAUNCH_DELAY_MS);

  return true;
}

/**
 * Normalize release notes to a string format.
 * electron-updater can return string | ReleaseNoteInfo[] | null
 */
function formatReleaseNotes(releaseNotes: UpdateInfo['releaseNotes']): string | null {
  if (!releaseNotes) {
    return null;
  }
  if (typeof releaseNotes === 'string') {
    return releaseNotes;
  }
  // Array of ReleaseNoteInfo objects - combine them
  return releaseNotes
    .map((note) => {
      if (typeof note === 'string') {
        return note;
      }
      // ReleaseNoteInfo has version and note properties
      return note.note;
    })
    .filter(Boolean)
    .join('\n\n');
}

function isReadOnlyVolumeUpdateError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('Cannot update while running on a read-only volume');
}

function getUpdateErrorMessage(err: unknown): string {
  if (isReadOnlyVolumeUpdateError(err)) {
    return 'Komla cannot update from this location. Move Komla to Applications, relaunch it, then try again.';
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * electron-updater updates a Linux install only while it runs from its AppImage file, which sets
 * APPIMAGE. An unpacked AppImage or someone else's package never updates, and says so only in
 * the log, so Komla checks for a new version itself there and offers it as a download. SNAP
 * doesn't count: Komla ships no Snap, so SNAP comes from a Snap app that started Komla.
 */
function isLinuxInstallWithoutUpdater(): boolean {
  return process.platform === 'linux' && !process.env.APPIMAGE;
}

export interface LinuxReleaseInfo {
  version: string;
  /** The AppImage's file name in the feed. */
  path: string;
  releaseNotes: string | null;
}

/** Reads the fields Komla needs from a latest-linux*.yml manifest that electron-builder wrote. */
export function parseLinuxManifest(text: string): LinuxReleaseInfo | null {
  let manifest: unknown;
  try {
    manifest = load(text);
  } catch {
    return null;
  }
  if (typeof manifest !== 'object' || manifest === null) return null;
  const { version, path, releaseNotes } = manifest as Record<string, unknown>;
  if (typeof version !== 'string' || typeof path !== 'string') return null;
  const notes = typeof releaseNotes === 'string' ? releaseNotes.trimEnd() : '';
  return { version, path, releaseNotes: notes || null };
}

function logUpdateError(message: string, err: unknown): void {
  if (isReadOnlyVolumeUpdateError(err)) {
    logger.warn(message, err);
    return;
  }
  logger.error(message, err);
}

export class UpdateService {
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private downloadedVersion: string | null = null;
  /** Set where electron-updater can't update this install, so Komla checks the feed itself. */
  private manualDownloadFeed: string | null = null;

  init(): void {
    if (is.dev) {
      logger.info('Skipping auto-updater in dev mode');
      return;
    }

    // The official feed would replace a build from source with the official
    // app, so only official builds update themselves.
    const autoUpdates = getBuildDistribution() === 'official';
    if (autoUpdates) {
      this.startAutoUpdater();
    } else {
      logger.info('Skipping auto-updater in a build from source');
    }
    announcementService.refresh();

    // Re-check every 4 hours (updates, announcements, license)
    this.checkInterval = setInterval(
      () => {
        if (autoUpdates) this.check('Periodic update check failed');
        announcementService.refresh();
        licenseService.refreshValidation();
      },
      4 * 60 * 60 * 1000
    );
  }

  private startAutoUpdater(): void {
    // Download updates in the background so the user only has to restart once ready.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = isStaging;

    // Override feed URL to match the build environment (staging vs production)
    autoUpdater.setFeedURL({ provider: 'generic', url: `${DOWNLOADS_BASE_URL}/latest/` });

    // Force channel to 'latest' so electron-updater always fetches latest*.yml manifests.
    // Without this, prerelease versions (e.g. 2.0.0-staging.6) cause electron-updater to
    // derive channel='staging' and look for staging-linux.yml / staging-mac.yml, but our
    // release script uploads manifests as latest-*.yml under the staging/ URL prefix.
    autoUpdater.channel = 'latest';

    // On ARM64 Windows, electron-updater always fetches latest.yml (no arch suffix).
    // Override the channel so it fetches latest-arm64.yml for the correct architecture.
    if (process.platform === 'win32' && process.arch === 'arm64') {
      autoUpdater.channel = 'latest-arm64';
    }

    autoUpdater.on('update-available', (info) => {
      logger.info(`Update available: v${info.version}`);
      const releaseNotes = formatReleaseNotes(info.releaseNotes);
      windowService.broadcastWhenReady(IPC.APP_UPDATE_AVAILABLE, {
        version: info.version,
        releaseNotes,
        releaseName: info.releaseName || null,
      });
    });

    autoUpdater.on('update-not-available', () => {
      logger.debug('No updates available');
      windowService.broadcastWhenReady(IPC.APP_UPDATE_NOT_AVAILABLE);
    });

    autoUpdater.on('update-downloaded', (info) => {
      logger.info(`Update downloaded: v${info.version}`);
      this.downloadedVersion = info.version;
      windowService.broadcastWhenReady(IPC.APP_UPDATE_DOWNLOADED, info.version);
    });

    autoUpdater.on('error', (err) => {
      logUpdateError('Auto-updater error', err);
      windowService.broadcastWhenReady(IPC.APP_UPDATE_ERROR, getUpdateErrorMessage(err));
    });

    if (isLinuxInstallWithoutUpdater()) {
      logger.info('Not running from an AppImage file; new versions are offered as downloads');
      this.manualDownloadFeed = `${DOWNLOADS_BASE_URL}/latest/`;
    }

    // Check on launch
    this.check('Update check failed');
  }

  checkForUpdates(): void {
    // Settings doesn't offer the check in a build from source, which doesn't update itself.
    if (getBuildDistribution() !== 'official') return;
    logger.info('Checking for updates...');
    this.check('Manual update check failed');
  }

  private check(failureMessage: string): void {
    const checked = this.manualDownloadFeed
      ? this.checkForDownload(this.manualDownloadFeed)
      : autoUpdater.checkForUpdates();
    checked.catch((err) => {
      logUpdateError(failureMessage, err);
      if (this.manualDownloadFeed) {
        windowService.broadcastWhenReady(IPC.APP_UPDATE_ERROR, getUpdateErrorMessage(err));
      }
    });
  }

  /** Offers a newer AppImage in the feed as a download, as electron-updater can't install it. */
  private async checkForDownload(feed: string): Promise<void> {
    const manifest = process.arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml';
    // net.fetch, unlike Node's fetch, goes through the system's proxy settings, as
    // electron-updater does.
    const response = await net.fetch(new URL(manifest, feed).href);
    if (!response.ok) throw new Error(`Update check failed: HTTP ${response.status}`);
    const release = parseLinuxManifest(await response.text());
    if (!release) throw new Error(`Update check failed: unreadable ${manifest}`);

    if (compareSemver(release.version, app.getVersion()) <= 0) {
      logger.debug('No updates available');
      windowService.broadcastWhenReady(IPC.APP_UPDATE_NOT_AVAILABLE);
      return;
    }
    logger.info(`Update available for download: v${release.version}`);
    windowService.broadcastWhenReady(IPC.APP_UPDATE_AVAILABLE, {
      version: release.version,
      releaseNotes: release.releaseNotes,
      releaseName: null,
      downloadUrl: new URL(release.path, feed).href,
    });
  }

  downloadUpdate(): void {
    logger.info('Starting update download...');
    autoUpdater.downloadUpdate().catch((err) => {
      logUpdateError('Update download failed', err);
    });
  }

  installUpdate(): void {
    logger.info('Installing update and restarting...');
    // Write a marker so the next launch can detect if it's still the old
    // version (macOS Squirrel race) and relaunch after a brief delay.
    if (this.downloadedVersion) {
      try {
        writePendingUpdate(this.downloadedVersion);
      } catch (err) {
        logger.warn('Failed to write pending-update marker', err);
      }
    }
    autoUpdater.quitAndInstall();
  }

  dispose(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
}

export const updateService = new UpdateService();
