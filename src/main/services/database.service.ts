import { chmodSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';

import { app } from 'electron';

import { createLogger } from '../lib/logger';

import { ensureKomlaBasePath } from './paths';

const logger = createLogger('DatabaseService');
const DATABASE_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE ssh_hosts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      hostname TEXT NOT NULL,
      user TEXT,
      port INTEGER CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
      identity_file TEXT,
      base_path TEXT NOT NULL,
      forward_agent INTEGER NOT NULL DEFAULT 0 CHECK (forward_agent IN (0, 1)),
      extra_ssh_args_json TEXT,
      sort_order INTEGER NOT NULL,
      setup_pending INTEGER NOT NULL DEFAULT 0 CHECK (setup_pending IN (0, 1)),
      capabilities_json TEXT,
      port_forwards_json TEXT,
      isolated INTEGER NOT NULL DEFAULT 0 CHECK (isolated IN (0, 1))
    );
  `,
};

export class DatabaseService {
  private connection: DatabaseSync | null = null;

  constructor(private readonly databasePath?: string) {}

  get(): DatabaseSync {
    if (this.connection) return this.connection;

    const path = this.databasePath ?? join(ensureKomlaBasePath(), 'komla.db');
    const connection = new DatabaseSync(path);
    try {
      connection.exec('PRAGMA foreign_keys = ON');
      connection.exec('PRAGMA busy_timeout = 5000');
      if (path !== ':memory:') {
        connection.exec('PRAGMA journal_mode = WAL');
        chmodSync(path, 0o600);
      }
      this.migrate(connection);
      this.connection = connection;
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  close(): void {
    if (!this.connection) return;
    this.connection.close();
    this.connection = null;
  }

  private migrate(connection: DatabaseSync): void {
    const row = connection.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    let version = row?.user_version ?? 0;
    if (version > DATABASE_VERSION) {
      const message = `Komla database version ${version} is newer than supported version ${DATABASE_VERSION}`;
      if (app.isPackaged) {
        throw new Error(message);
      }
      logger.warn(`${message}; continuing in development mode`);
      return;
    }

    while (version < DATABASE_VERSION) {
      const nextVersion = version + 1;
      const migration = MIGRATIONS[nextVersion];
      if (!migration) throw new Error(`Missing database migration ${nextVersion}`);

      connection.exec('BEGIN IMMEDIATE');
      try {
        connection.exec(migration);
        connection.exec(`PRAGMA user_version = ${nextVersion}`);
        connection.exec('COMMIT');
        version = nextVersion;
      } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
      }
    }

    logger.debug('database ready', { version });
  }
}

export const databaseService = new DatabaseService();
