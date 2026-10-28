import { randomUUID } from 'crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  statSync,
} from 'fs';
import { cpus, totalmem } from 'os';
import { join } from 'path';

import { app, clipboard, ipcMain, nativeImage, type NativeImage } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { removePathSync } from '../../lib/remove-path';
import { agentUsageService } from '../../services/agent-usage/agent-usage.service';
import { announcementService, type Announcement } from '../../services/announcement.service';
import { backgroundProcessService } from '../../services/background-process.service';
import { databaseService } from '../../services/database.service';
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
import {
  agentUsageRefreshArgsSchema,
  clipboardImportImageArgsSchema,
  resourceUsageArgsSchema,
} from '../validation/app-ipc.schemas';
import { errorReportArgsSchema, feedbackSendArgsSchema } from '../validation/config-ipc.schemas';
import { handleValidated } from '../validation/ipc-validators';

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
  executionLocation: 'workspace' | 'local-mirror' = 'workspace'
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
  ipcMain.handle(IPC.APP_GET_SYSTEM_METRICS, async (): Promise<SystemMetrics> => {
    return getSystemMetrics();
  });

  ipcMain.handle(
    IPC.RESOURCE_USAGE_GET,
    handleValidated(
      IPC.RESOURCE_USAGE_GET,
      resourceUsageArgsSchema,
      (_, [hostId, options]): Promise<MachineResourceUsage> =>
        resourceUsageService.get(hostId, options)
    )
  );

  ipcMain.handle(IPC.AGENT_USAGE_GET, (): AgentUsage => agentUsageService.get());
  ipcMain.handle(
    IPC.AGENT_USAGE_REFRESH,
    handleValidated(
      IPC.AGENT_USAGE_REFRESH,
      agentUsageRefreshArgsSchema,
      (_, [options]): Promise<AgentUsage> => agentUsageService.refresh(options)
    )
  );

  ipcMain.handle(
    IPC.APP_GET_HOST_RESOURCES,
    async (): Promise<{ cpuCount: number; totalMemoryGB: number }> => ({
      cpuCount: cpus().length,
      totalMemoryGB: Math.floor(totalmem() / (1024 * 1024 * 1024)),
    })
  );

  // Announcement handlers
  ipcMain.handle(IPC.ANNOUNCEMENTS_GET, async (): Promise<Announcement[]> => {
    return announcementService.getActive();
  });

  ipcMain.handle(IPC.ANNOUNCEMENTS_DISMISS, async (_, id: string): Promise<void> => {
    announcementService.dismiss(id);
  });

  // Update handlers
  ipcMain.handle(IPC.APP_GET_VERSION, async (): Promise<string> => {
    return app.getVersion();
  });

  ipcMain.handle(IPC.APP_GET_BASE_PATH, async (): Promise<string> => {
    return getKomlaBasePath();
  });

  ipcMain.handle(IPC.APP_INSTALL_UPDATE, async (): Promise<void> => {
    updateService.installUpdate();
  });

  ipcMain.handle(IPC.APP_CHECK_UPDATES, async (): Promise<void> => {
    updateService.checkForUpdates();
  });

  ipcMain.handle(IPC.APP_DOWNLOAD_UPDATE, async (): Promise<void> => {
    updateService.downloadUpdate();
  });

  // Feedback handlers
  ipcMain.handle(IPC.FEEDBACK_SELECT_SCREENSHOTS, async (): Promise<string[]> => {
    return feedbackService.selectScreenshots();
  });

  ipcMain.handle(
    IPC.FEEDBACK_SEND,
    handleValidated(
      IPC.FEEDBACK_SEND,
      feedbackSendArgsSchema,
      async (_, [payload]): Promise<FeedbackResult> => {
        return feedbackService.sendFeedback(payload);
      }
    )
  );

  // Error reporting handler (from renderer process)
  ipcMain.handle(
    IPC.ERROR_REPORT,
    handleValidated(IPC.ERROR_REPORT, errorReportArgsSchema, async (_, [error]) => {
      const err = new Error(error.message);
      err.stack = error.stack;
      await errorReportingService.report(err, error.type, error.context);
    })
  );

  // Data management handlers
  ipcMain.handle(IPC.DATA_DELETE_ALL_WORKSPACES, async (): Promise<void> => {
    await workspaceService.deleteAll();
  });

  ipcMain.handle(IPC.DATA_CLEAR_LOGS, async (): Promise<void> => {
    const logsPath = join(getKomlaBasePath(), 'logs');
    rmSync(logsPath, { recursive: true, force: true });
  });

  ipcMain.handle(IPC.DATA_RESET_APP, async (): Promise<void> => {
    const basePath = getKomlaBasePath();
    const licensePath = join(basePath, 'license.json');

    // Preserve license.json if it exists (read before stopping anything)
    let licenseData: string | null = null;
    if (existsSync(licensePath)) {
      licenseData = readFileSync(licensePath, 'utf-8');
    }

    // Stop all services that hold file handles in the data directory.
    // ptyService.killAll() is awaited so node-pty's exit TSFN drains before
    // we proceed (and eventually call app.quit()) — see pty.service.ts.
    await worktreeWatcherService.stopAll();
    await notesService.stopWatching();
    backgroundProcessService.killAll();
    await ptyService.killAll();

    // Delete all workspaces (cleans up worktrees on disk)
    await workspaceService.deleteAll();
    databaseService.close();

    // Remove the entire komla data directory (maxRetries handles race conditions
    // with files being flushed by services that were just stopped)
    removePathSync(basePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

    // Restore license.json
    if (licenseData) {
      mkdirSync(basePath, { recursive: true });
      writeFileSync(licensePath, licenseData, 'utf-8');
    }

    // Relaunch the app
    app.relaunch();
    app.quit();
  });

  // Clipboard handlers
  ipcMain.handle(IPC.CLIPBOARD_WRITE_TEXT, async (_, text: string): Promise<void> => {
    await clipboard.writeText(text);
  });

  ipcMain.handle(IPC.CLIPBOARD_READ_TEXT, async (): Promise<string> => {
    return clipboard.readText();
  });

  ipcMain.handle(
    IPC.CLIPBOARD_IMPORT_IMAGE,
    handleValidated(
      IPC.CLIPBOARD_IMPORT_IMAGE,
      clipboardImportImageArgsSchema,
      async (_, [workspaceId, executionLocation]): Promise<string | null> => {
        return importClipboardImage(workspaceId, executionLocation);
      }
    )
  );

  ipcMain.handle(IPC.CLIPBOARD_STAGE_IMAGE, (): Promise<string | null> => stageClipboardImage());
}
