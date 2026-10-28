// fromVersion is the version the data was saved at, before any of this run's migrations.
// Data without a _version, or below 1, is at version 1, the first, like a file written by hand.
type MigrationFn = (data: Record<string, unknown>, fromVersion: number) => Record<string, unknown>;

export function migrate(
  data: Record<string, unknown>,
  targetVersion: number,
  migrations: Record<number, MigrationFn>
): Record<string, unknown> {
  let currentVersion = typeof data._version === 'number' ? Math.max(data._version, 1) : 1;

  if (currentVersion === targetVersion) {
    return data;
  }

  const fromVersion = currentVersion;
  let result = { ...data };
  while (currentVersion < targetVersion) {
    const nextVersion = currentVersion + 1;
    const migrationFn = migrations[nextVersion];
    if (!migrationFn) {
      throw new Error(`Missing migration for version ${nextVersion}`);
    }
    result = migrationFn(result, fromVersion);
    result._version = nextVersion;
    currentVersion = nextVersion;
  }

  return result;
}
