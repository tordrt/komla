import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

import { createLogger } from '../lib/logger';
import { http } from '../lib/node-http';

import { configService } from './config.service';
import { writeHookHelperFiles } from './http-server/hook-helper-files';
import { createRequestHandler } from './http-server/router';
import { MCP_PRELOAD_DELAY_MS, preloadMcp } from './http-server/routes/mcp';
import { getKomlaBasePath } from './paths';
import { settingsApprovalService } from './settings-approval.service';
import { workspaceService } from './workspace.service';

import type { Server } from 'http';

const logger = createLogger('HttpServerService');

class HttpServerService {
  private server: Server | null = null;
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
  private mcpPreloadTimer: NodeJS.Timeout | null = null;

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
      if (!configService.get().disableMcpServer) {
        this.mcpPreloadTimer = setTimeout(preloadMcp, MCP_PRELOAD_DELAY_MS);
        this.mcpPreloadTimer.unref();
      }

      if (port !== this.preferredPort) {
        // Persist the fallback port so later launches start on it.
        configService.update({ notificationPort: port });
        logger.info(
          `Notification server listening on fallback port ${port} (preferred ${this.preferredPort} was in use)`
        );
      } else {
        logger.info(`Notification server listening on port ${port}`);
      }
    });
  }

  stop(): void {
    if (this.mcpPreloadTimer) clearTimeout(this.mcpPreloadTimer);
    this.mcpPreloadTimer = null;
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
}

export const httpServerService = new HttpServerService();
