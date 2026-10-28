import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

import { DatabaseService } from '../../../src/main/services/database.service';

vi.mock('electron', () => mockElectron());

describe('DatabaseService', () => {
  let databaseService: DatabaseService;

  beforeEach(() => {
    databaseService = new DatabaseService(':memory:');
  });

  afterEach(() => {
    databaseService.close();
  });

  it('creates the current schema and enables foreign keys', () => {
    const database = databaseService.get();

    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    expect(
      (database.prepare('PRAGMA table_info(ssh_hosts)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    ).toEqual([
      'id',
      'name',
      'hostname',
      'user',
      'port',
      'identity_file',
      'base_path',
      'forward_agent',
      'extra_ssh_args_json',
      'sort_order',
      'setup_pending',
      'capabilities_json',
      'port_forwards_json',
      'isolated',
    ]);
  });

  it('returns the same open connection and can reopen after close', () => {
    const first = databaseService.get();
    expect(databaseService.get()).toBe(first);

    databaseService.close();

    const second = databaseService.get();
    expect(Object.is(second, first)).toBe(false);
    expect(second.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
  });

  it('opens a newer database without changing its version in development', () => {
    const directory = mkdtempSync(join(tmpdir(), 'komla-database-'));
    const databasePath = join(directory, 'komla.db');
    const newerDatabase = new DatabaseSync(databasePath);
    newerDatabase.exec('PRAGMA user_version = 2');
    newerDatabase.close();

    const newerService = new DatabaseService(databasePath);
    try {
      expect(newerService.get().prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
    } finally {
      newerService.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a newer database outside development', async () => {
    const { app } = await import('electron');
    (app as unknown as { isPackaged: boolean }).isPackaged = true;
    const directory = mkdtempSync(join(tmpdir(), 'komla-database-'));
    const databasePath = join(directory, 'komla.db');
    const newerDatabase = new DatabaseSync(databasePath);
    newerDatabase.exec('PRAGMA user_version = 2');
    newerDatabase.close();

    const newerService = new DatabaseService(databasePath);
    try {
      expect(() => newerService.get()).toThrow(
        'Komla database version 2 is newer than supported version 1'
      );
    } finally {
      newerService.close();
      rmSync(directory, { recursive: true, force: true });
      (app as unknown as { isPackaged: boolean }).isPackaged = false;
    }
  });
});
