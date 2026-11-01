import { createLogger } from '../lib/logger';

const logger = createLogger('SshHostLegacyDatabase');

interface LegacySshHostRow {
  id: string;
  name: string;
  hostname: string;
  user: string | null;
  port: number | null;
  identity_file: string | null;
  base_path: string;
  forward_agent: number;
  isolated: number;
  extra_ssh_args_json: string | null;
  port_forwards_json: string | null;
  setup_pending: number;
  capabilities_json: string | null;
}

function parseJsonColumn(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    logger.warn('ignoring invalid JSON in a legacy SSH host', { error: String(error) });
    return undefined;
  }
}

/**
 * The hosts in komla.db, where they were stored before ssh-hosts.json, in the shape of that file.
 * The only code in the app that uses SQLite: delete this module, and the move in SshHostService,
 * once installs have had a release to run it.
 *
 * The move has to read through SQLite rather than the file itself, as installs that weren't
 * checkpointed keep all their tables and rows in komla.db-wal. Opened read-only, so a failed or
 * rolled-back move finds the database as it was. It loads on demand, so that installs without a
 * database never load the experimental module.
 */
export function readLegacySshHosts(databasePath: string): Record<string, unknown>[] {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const hasTable = database
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ssh_hosts'`)
      .get();
    if (!hasTable) return [];
    const rows = database
      .prepare('SELECT * FROM ssh_hosts ORDER BY sort_order, rowid')
      .all() as unknown as LegacySshHostRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      user: row.user,
      port: row.port,
      identityFile: row.identity_file,
      basePath: row.base_path,
      forwardAgent: row.forward_agent === 1,
      isolated: row.isolated === 1,
      extraSshArgs: parseJsonColumn(row.extra_ssh_args_json),
      portForwards: parseJsonColumn(row.port_forwards_json),
      setupPending: row.setup_pending === 1,
      capabilities: parseJsonColumn(row.capabilities_json),
    }));
  } finally {
    database.close();
  }
}
