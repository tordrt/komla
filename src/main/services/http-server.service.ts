import { writeFileSync, unlinkSync } from 'fs';
import http from 'http';
import { join } from 'path';

import { BrowserWindow } from 'electron';

import { IPC } from '../../shared/constants/ipc-channels';
import { createLogger } from '../lib/logger';

import { configService } from './config.service';
import { writeHookHelperFiles } from './http-server/hook-helper-files';
import { createRequestHandler } from './http-server/router';
import { getKomlaBasePath } from './paths';
import { settingsApprovalService } from './settings-approval.service';
import { workspaceService } from './workspace.service';

const logger = createLogger('HttpServerService');

class HttpServerService {
  private server: http.Server | null = null;
  private preferredPort = 52863;
  private actualPort: number | null = null;
  private maxPortRetries = 10;
  private portFilePath = join(getKomlaBasePath(), 'port');
  private startedCallbacks: Array<() => void> = [];
  private portWaiters: Array<{
    resolve: (port: number) => void;
    reject: (error: Error) => void;
  }> = [];
  private startError: Error | null = null;
  private portChangeEvent: { oldPort: number; newPort: number } | null = null;

  start(preferredPort?: number): void {
    if (this.server) {
      return;
    }

    writeHookHelperFiles(this.portFilePath);

    if (preferredPort !== undefined) {
      this.preferredPort = preferredPort;
    }

    this.startError = null;
    this.server = http.createServer(createRequestHandler());
    this.tryListen(this.preferredPort);
  }

  private tryListen(port: number, attempt: number = 0): void {
    if (!this.server) return;

    // A failed listen() leaves its callback on 'listening', so the next port's success runs it too.
    let failed = false;
    const bindErrorHandler = (error: NodeJS.ErrnoException) => {
      failed = true;
      if (
        (error.code === 'EADDRINUSE' || error.code === 'EACCES') &&
        attempt < this.maxPortRetries
      ) {
        const nextPort = this.preferredPort + attempt + 1;
        logger.info(`Port ${port} unavailable (${error.code}), trying ${nextPort}...`);
        this.tryListen(nextPort, attempt + 1);
      } else {
        logger.error('Notification server error:', error);
        this.startError = error;
        for (const waiter of this.portWaiters) {
          waiter.reject(error);
        }
        this.portWaiters = [];
      }
    };

    this.server.once('error', bindErrorHandler);

    this.server.listen(port, '127.0.0.1', () => {
      if (failed) return;
      // Remove the bind-time error listener so it doesn't misfire on runtime errors
      this.server?.removeListener('error', bindErrorHandler);
      this.actualPort = port;
      process.env.KOMLA_API_URL = `http://127.0.0.1:${port}`;
      this.writePortFile(port);
      for (const waiter of this.portWaiters) {
        waiter.resolve(port);
      }
      this.portWaiters = [];
      for (const callback of this.startedCallbacks) {
        callback();
      }
      // One-shot — drop references so pre-bind callers aren't retained.
      this.startedCallbacks = [];

      if (port !== this.preferredPort) {
        // Persist fallback port so future boots use it. Always — even on first
        // run — so the chosen port becomes sticky from boot 2 onwards.
        configService.update({ notificationPort: port });
        // Only surface the "port changed" banner when there was a prior known
        // port to deviate from. On a first run (no config.json on disk), the
        // port we end up on is just our initial assignment, not a change —
        // and no MCP integrations can be pointing at a stale port yet.
        if (configService.wasLoadedFromDisk()) {
          this.portChangeEvent = { oldPort: this.preferredPort, newPort: port };
          const windows = BrowserWindow.getAllWindows();
          for (const window of windows) {
            window.webContents.send(IPC.SERVER_PORT_CHANGED, this.portChangeEvent);
          }
        }
        logger.info(
          `Notification server listening on fallback port ${port} (preferred ${this.preferredPort} was in use)`
        );
      } else {
        logger.info(`Notification server listening on port ${port}`);
      }
    });
  }

  stop(): void {
    settingsApprovalService.dismissAll();
    workspaceService.attention.hooksStopped();
    const error = new Error('HTTP server stopped before a port became available');
    for (const waiter of this.portWaiters) {
      waiter.reject(error);
    }
    this.portWaiters = [];
    if (this.server) {
      this.server.close();
      this.server = null;
      if (
        this.actualPort !== null &&
        process.env.KOMLA_API_URL === `http://127.0.0.1:${this.actualPort}`
      ) {
        delete process.env.KOMLA_API_URL;
      }
      this.actualPort = null;
      this.startError = null;
      this.removePortFile();
    }
  }

  getActualPort(): number | null {
    return this.actualPort;
  }

  waitForActualPort(): Promise<number> {
    if (this.actualPort !== null) {
      return Promise.resolve(this.actualPort);
    }
    if (this.startError) {
      return Promise.reject(this.startError);
    }
    return new Promise((resolve, reject) => {
      this.portWaiters.push({ resolve, reject });
    });
  }

  private writePortFile(port: number): void {
    try {
      writeFileSync(this.portFilePath, String(port));
    } catch (error) {
      logger.warn('Failed to write port file:', error);
    }
  }

  private removePortFile(): void {
    try {
      unlinkSync(this.portFilePath);
    } catch {
      // File may already be gone
    }
  }

  getPort(): number {
    return this.actualPort ?? this.preferredPort;
  }

  onStarted(callback: () => void): void {
    if (this.actualPort !== null) {
      callback();
      return;
    }
    this.startedCallbacks.push(callback);
  }

  getPortChangeEvent(): { oldPort: number; newPort: number } | null {
    return this.portChangeEvent;
  }
}

export const httpServerService = new HttpServerService();
