declare module 'node:sqlite' {
  import type { PathLike } from 'node:fs';

  type SqlValue = null | number | bigint | string | Uint8Array;

  interface StatementResult {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  class StatementSync {
    all(...anonymousParameters: SqlValue[]): Record<string, SqlValue>[];
    get(...anonymousParameters: SqlValue[]): Record<string, SqlValue> | undefined;
    run(...anonymousParameters: SqlValue[]): StatementResult;
  }

  class DatabaseSync {
    constructor(path: PathLike);
    readonly isOpen: boolean;
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
