import { resolve, sep } from 'path';

/** Whether this platform's default file systems tell names apart by case: not on macOS or Windows. */
export function isCaseInsensitiveFileSystem(): boolean {
  return process.platform === 'darwin' || process.platform === 'win32';
}

// Paths differ only in case on the case-insensitive file systems macOS and Windows default to.
export function isSamePath(a: string, b: string): boolean {
  return samePathKey(a) === samePathKey(b);
}

/** A key that is equal for two paths exactly when isSamePath says they're the same. */
export function samePathKey(path: string): string {
  return isCaseInsensitiveFileSystem() ? resolve(path).toLowerCase() : resolve(path);
}

// Whether a path is a folder or inside it; both must already be real paths.
export function isWithinRoot(realRoot: string, realCandidate: string): boolean {
  return realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${sep}`);
}
