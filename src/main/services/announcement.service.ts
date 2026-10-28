import { app, net } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { API_BASE_URL } from '../lib/api-urls';
import { createLogger } from '../lib/logger';
import { compareSemver } from '../lib/semver';

import { configService } from './config.service';
import { licenseService } from './license.service';
import { windowService } from './window.service';

const logger = createLogger('AnnouncementService');

const ANNOUNCEMENTS_URL = `${API_BASE_URL}/api/v1/announcements`;

export interface Announcement {
  id: string;
  type: 'info' | 'tip' | 'whats-new' | 'warning';
  title: string;
  body: string;
  minVersion?: string;
  maxVersion?: string;
  date: string;
  dismissible?: boolean;
  displayMode: 'banner' | 'dialog' | 'both';
  audience: 'all' | 'licensed' | 'unlicensed';
  platform: 'all' | 'darwin' | 'win32' | 'linux';
  action?: {
    label: string;
    url: string;
  };
}

export function matchesVersion(announcement: Announcement, appVersion: string): boolean {
  if (announcement.minVersion && compareSemver(appVersion, announcement.minVersion) < 0) {
    return false;
  }
  if (announcement.maxVersion && compareSemver(appVersion, announcement.maxVersion) > 0) {
    return false;
  }
  return true;
}

class AnnouncementService {
  private announcements: Announcement[] = [];

  /**
   * Fetch announcements from the server and broadcast to all windows.
   * Called by the update service on launch and on its periodic 4-hour interval.
   */
  refresh(): void {
    this.fetch().catch((err) => {
      logger.error('Announcement fetch failed', err);
    });
  }

  getActive(): Announcement[] {
    const appVersion = app.getVersion();
    const config = configService.get();
    const dismissed = config.dismissedAnnouncementIds ?? [];

    const licensed = licenseService.getStatus().isLicensed;

    return this.announcements.filter((a) => {
      if (dismissed.includes(a.id)) return false;
      if (!matchesVersion(a, appVersion)) return false;
      if (a.audience !== 'all' && a.audience !== (licensed ? 'licensed' : 'unlicensed'))
        return false;
      if (a.platform !== 'all' && a.platform !== process.platform) return false;
      return true;
    });
  }

  dismiss(id: string): void {
    const config = configService.get();
    const dismissed = config.dismissedAnnouncementIds ?? [];
    if (!dismissed.includes(id)) {
      configService.update({ dismissedAnnouncementIds: [...dismissed, id] });
    }
    this.broadcastToAll();
  }

  private async fetch(): Promise<void> {
    const url = ANNOUNCEMENTS_URL;

    try {
      const data = await this.request(url);
      const parsed = JSON.parse(data);
      const list = Array.isArray(parsed) ? parsed : parsed.announcements;
      if (Array.isArray(list)) {
        this.announcements = list;
        this.broadcastToAll();
      }
    } catch {
      // Silent fail - announcements are non-critical
    }
  }

  private broadcastToAll(): void {
    const active = this.getActive();
    windowService.broadcastWhenReady(IPC.ANNOUNCEMENTS_UPDATED, active);
  }

  private request(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        const request = net.request({ method: 'GET', url });

        request.on('response', (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => {
            chunks.push(chunk);
          });
          response.on('end', () => {
            if (response.statusCode === 200) {
              resolve(Buffer.concat(chunks).toString('utf-8'));
            } else {
              reject(new Error(`HTTP ${response.statusCode}`));
            }
          });
        });

        request.on('error', reject);
        request.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}

export const announcementService = new AnnouncementService();
