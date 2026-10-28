import { posix, resolve, sep } from 'path';

export function assertNoNullBytes(value: string, fieldName: string): void {
  if (value.includes('\0')) {
    throw new Error(`${fieldName} contains invalid null byte`);
  }
}

export function assertSafeRelativePath(
  rootPath: string,
  relativePath: string,
  fieldName: string
): void {
  assertNoNullBytes(rootPath, 'rootPath');
  assertNoNullBytes(relativePath, fieldName);

  const resolvedRoot = resolve(rootPath);
  const resolvedTarget = resolve(resolvedRoot, relativePath);

  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`${fieldName} escapes the allowed root path`);
  }
}

export function assertSafePosixRelativePath(relativePath: string, fieldName: string): void {
  assertNoNullBytes(relativePath, fieldName);

  const normalized = posix.normalize(relativePath);
  if (posix.isAbsolute(relativePath) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${fieldName} escapes the allowed root path`);
  }
}
