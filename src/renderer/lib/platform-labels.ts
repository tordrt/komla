const currentPlatform = typeof window !== 'undefined' ? window.api?.platform : undefined;

export function getRevealInFileManagerLabel(platform = currentPlatform): string {
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Show in Explorer';
  return 'Show in File Manager';
}
