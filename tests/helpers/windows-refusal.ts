import type { execFile } from 'child_process';

/**
 * An execFile for a program Windows won't start, such as one Smart App Control blocks: like
 * Node, it throws instead of calling back.
 */
export function refusingExecFile(code = 'UNKNOWN'): typeof execFile {
  return ((): never => {
    throw Object.assign(new Error(`spawn ${code}`), { code, syscall: 'spawn' });
  }) as unknown as typeof execFile;
}
