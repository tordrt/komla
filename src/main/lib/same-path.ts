import { resolve, sep } from 'path';

// Paths differ only in case on the case-insensitive file systems macOS and Windows default to.
export function isSamePath(a: string, b: string): boolean {
  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
  return caseInsensitive
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
}

// Whether a path is a folder or inside it; both must already be real paths.
export function isWithinRoot(realRoot: string, realCandidate: string): boolean {
  return realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${sep}`);
}
