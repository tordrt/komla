import { describe, it, expect } from 'vitest';
import { migrate } from '../../../src/main/lib/migration';

describe('migrate', () => {
  it('returns data unchanged when already at target version', () => {
    const data = { _version: 2, name: 'test' };
    const result = migrate(data, 2, {});
    expect(result).toEqual(data);
  });

  it('applies migrations sequentially from current version to target', () => {
    const data = { _version: 1, oldField: 'value' };
    const migrations = {
      2: (d: Record<string, unknown>) => {
        d.newField = d.oldField;
        delete d.oldField;
        return d;
      },
    };
    const result = migrate(data, 2, migrations);
    expect(result).toEqual({ _version: 2, newField: 'value' });
  });

  it('applies multiple migrations in order', () => {
    const data = { _version: 1, a: 1 };
    const migrations = {
      2: (d: Record<string, unknown>) => ({ ...d, b: 2 }),
      3: (d: Record<string, unknown>) => ({ ...d, c: 3 }),
    };
    const result = migrate(data, 3, migrations);
    expect(result).toEqual({ _version: 3, a: 1, b: 2, c: 3 });
  });

  it('treats data without _version as version 1', () => {
    expect(migrate({ name: 'hand-written' }, 1, {})).toEqual({ name: 'hand-written' });

    const migrations = {
      2: (d: Record<string, unknown>) => ({ ...d, migrated: true }),
    };
    const result = migrate({ name: 'hand-written' }, 2, migrations);
    expect(result).toEqual({ _version: 2, name: 'hand-written', migrated: true });
  });

  it('treats a _version below 1 as version 1', () => {
    expect(migrate({ _version: 0, name: 'hand-written' }, 1, {})).toEqual({
      _version: 0,
      name: 'hand-written',
    });
  });

  it('throws if a required migration step is missing', () => {
    const data = { _version: 1 };
    const migrations = {
      3: (d: Record<string, unknown>) => d,
    };
    expect(() => migrate(data, 3, migrations)).toThrow('Missing migration for version 2');
  });
});
