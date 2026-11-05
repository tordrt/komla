import { randomUUID } from 'crypto';
import { readdirSync, writeFileSync, rmSync, mkdirSync, statSync } from 'fs';
import { cpus, totalmem } from 'os';
import { join } from 'path';

import { app, clipboard, nativeImage, type NativeImage } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { removePathSync } from '../../lib/remove-path';
import { agentUsageService } from '../../services/agent-usage/agent-usage.service';
import { announcementService, type Announcement } from '../../services/announcement.service';
import { backgroundProcessService } from '../../services/background-process.service';
import { errorReportingService } from '../../services/error-reporting.service';
import { feedbackService, FeedbackResult } from '../../services/feedback.service';
import { notesService } from '../../services/notes.service';
import { getKomlaBasePath } from '../../services/paths';
import { ptyService } from '../../services/pty.service';
import { resourceUsageService } from '../../services/resource-usage/resource-usage.service';
import { updateService } from '../../services/update.service';
import { workspaceFileService } from '../../services/workspace-file.service';
import { workspaceService } from '../../services/workspace.service';
import { worktreeWatcherService } from '../../services/worktree-watcher.service';
import { handleIpc } from '../validation/ipc-validators';

import type { AgentUsage } from '../../../shared/types/agent-usage';
import type { MachineResourceUsage } from '../../../shared/types/resource-usage';

export interface SystemMetrics {
  cpuPercent: number;
  memoryMB: number;
}

export function getSystemMetrics(): SystemMetrics {
  const metrics = app.getAppMetrics();

  let totalCpu = 0;
  let totalMemoryKB = 0;
  for (const proc of metrics) {
    totalCpu += proc.cpu.percentCPUUsage;
    totalMemoryKB += proc.memory.workingSetSize;
  }

  return {
    cpuPercent: Math.round(totalCpu * 10) / 10,
    memoryMB: Math.round(totalMemoryKB / 1024),
  };
}

function clipboardImagePreferredName(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return `clipboard-image-${timestamp}.png`;
}

function isImageMimeType(type: string): type is `image/${string}` {
  return type.startsWith('image/');
}

// Electron 44 removed clipboard.readImage(); images now come from
// clipboard.read() as MIME-typed blobs.
async function readClipboardImage(): Promise<NativeImage | null> {
  for (const item of await clipboard.read()) {
    const type = item.types.includes('image/png') ? 'image/png' : item.types.find(isImageMimeType);
    if (!type) continue;
    const blob = await item.getType(type);
    return nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
  }
  return null;
}

// Long enough for a draft that keeps a pasted image to still find it.
const STAGED_IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Saves the clipboard image for a prompt whose workspace doesn't exist yet; creating
 * the workspace imports it. Each image gets its own folder so it keeps its name.
 */
export async function stageClipboardImage(now = new Date()): Promise<string | null> {
  const image = await readClipboardImage();
  if (!image || image.isEmpty()) return null;

  const png = image.toPNG();
  if (png.length === 0) return null;

  const stagingDir = join(app.getPath('temp'), 'komla-clipboard-images', 'staged');
  mkdirSync(stagingDir, { recursive: true });
  for (const entry of readdirSync(stagingDir, { withFileTypes: true })) {
    const entryPath = join(stagingDir, entry.name);
    try {
      if (now.getTime() - statSync(entryPath).mtimeMs > STAGED_IMAGE_MAX_AGE_MS) {
        rmSync(entryPath, { recursive: true, force: true });
      }
    } catch {
      // Gone already, or not ours to remove.
    }
  }

  const imageDir = join(stagingDir, randomUUID());
  mkdirSync(imageDir);
  const imagePath = join(imageDir, clipboardImagePreferredName(now));
  writeFileSync(imagePath, png);
  return imagePath;
}

export async function importClipboardImage(
  workspaceId: string,
  executionLocation: 'workspace' | 'local-copy' = 'workspace'
): Promise<string | null> {
  const image = await readClipboardImage();
  if (!image || image.isEmpty()) return null;

  const png = image.toPNG();
  if (png.length === 0) return null;

  const tempDir = join(app.getPath('temp'), 'komla-clipboard-images');
  mkdirSync(tempDir, { recursive: true });
  const tempPath = join(tempDir, `${randomUUID()}.png`);

  try {
    writeFileSync(tempPath, png);
    return await workspaceFileService.importExternalFile(
      workspaceId,
      tempPath,
      clipboardImagePreferredName(),
      executionLocation
    );
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function registerAppHandlers(): void {
  handleIpc(IPC.APP_GET_SYSTEM_METRICS, async (): Promise<SystemMetrics> => {
    return getSystemMetrics();
  });

  handleIpc(IPC.RESOURCE_USAGE_GET, (_, [hostId, options]): Promise<MachineResourceUsage> =>
    resourceUsageService.get(hostId, options)
  );

  handleIpc(IPC.AGENT_USAGE_GET, (): AgentUsage => agentUsageService.get());
  handleIpc(IPC.AGENT_USAGE_REFRESH, (_, [options]): Promise<AgentUsage> =>
    agentUsageService.refresh(options)
  );

  handleIpc(
    IPC.APP_GET_HOST_RESOURCES,
    async (): Promise<{ cpuCount: number; totalMemoryGB: number }> => ({
      cpuCount: cpus().length,
      totalMemoryGB: Math.floor(totalmem() / (1024 * 1024 * 1024)),
    })
  );

  // Announcement handlers
  handleIpc(IPC.ANNOUNCEMENTS_GET, async (): Promise<Announcement[]> => {
    return announcementService.getActive();
  });

  handleIpc(IPC.ANNOUNCEMENTS_DISMISS, async (_, [id]): Promise<void> => {
    announcementService.dismiss(id);
  });

  // Update handlers
  handleIpc(IPC.APP_GET_VERSION, async (): Promise<string> => {
    return app.getVersion();
  });

  handleIpc(IPC.APP_GET_BASE_PATH, async (): Promise<string> => {
    return getKomlaBasePath();
  });

  handleIpc(IPC.APP_INSTALL_UPDATE, async (): Promise<void> => {
    updateService.installUpdate();
  });

  handleIpc(IPC.APP_CHECK_UPDATES, async (): Promise<void> => {
    updateService.checkForUpdates();
  });

  handleIpc(IPC.APP_DOWNLOAD_UPDATE, async (): Promise<void> => {
    updateService.downloadUpdate();
  });

  // Feedback handlers
  handleIpc(IPC.FEEDBACK_SELECT_SCREENSHOTS, async (): Promise<string[]> => {
    return feedbackService.selectScreenshots();
  });

  handleIpc(IPC.FEEDBACK_SEND, async (_, [payload]): Promise<FeedbackResult> => {
    return feedbackService.sendFeedback(payload);
  });

  // Error reporting handler (from renderer process)
  handleIpc(IPC.ERROR_REPORT, async (_, [error]) => {
    const err = new Error(error.message);
    err.stack = error.stack;
    await errorReportingService.report(err, error.type, error.context);
  });

  // Data management handlers
  handleIpc(IPC.DATA_DELETE_ALL_WORKSPACES, async (): Promise<void> => {
    await workspaceService.deleteAll();
  });

  handleIpc(IPC.DATA_CLEAR_LOGS, async (): Promise<void> => {
    const logsPath = join(getKomlaBasePath(), 'logs');
    rmSync(logsPath, { recursive: true, force: true });
  });

  handleIpc(IPC.DATA_RESET_APP, async (): Promise<void> => {
    const basePath = getKomlaBasePath();

    // Stop all services that hold file handles in the data directory.
    // ptyService.killAll() is awaited so node-pty's exit TSFN drains before
    // we proceed (and eventually call app.quit()) — see pty.service.ts.
    await worktreeWatcherService.stopAll();
    await notesService.stopWatching();
    backgroundProcessService.killAll();
    await ptyService.killAll();

    // Delete all workspaces (cleans up worktrees on disk)
    await workspaceService.deleteAll();

    // Remove the entire komla data directory (maxRetries handles race conditions
    // with files being flushed by services that were just stopped)
    removePathSync(basePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

    // Relaunch the app
    app.relaunch();
    app.quit();
  });

  // Clipboard handlers
  handleIpc(IPC.CLIPBOARD_WRITE_TEXT, async (_, [text]): Promise<void> => {
    await clipboard.writeText(text);
  });

  handleIpc(IPC.CLIPBOARD_READ_TEXT, async (): Promise<string> => {
    return clipboard.readText();
  });

  handleIpc(
    IPC.CLIPBOARD_IMPORT_IMAGE,
    async (_, [workspaceId, executionLocation]): Promise<string | null> => {
      return importClipboardImage(workspaceId, executionLocation);
    }
  );

  handleIpc(IPC.CLIPBOARD_STAGE_IMAGE, (): Promise<string | null> => stageClipboardImage());
}
