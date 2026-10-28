const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.ogv'];
const HTML_EXTENSIONS = ['.html', '.htm'];
const BROWSER_PREVIEW_EXTENSIONS = [...HTML_EXTENSIONS, '.svg', '.pdf'];
const UNSUPPORTED_BINARY_EXTENSIONS = ['.heic', '.heif'];
const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];
const VIEWABLE_TEXT_EXTENSIONS = ['.txt', '.log', '.json', '.jsonl', '.ndjson', '.csv', '.tsv'];

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

export function isImageFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isAudioFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isVideoFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isMediaFile(filePath: string): boolean {
  return isAudioFile(filePath) || isVideoFile(filePath);
}

export function isHtmlFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return HTML_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isBrowserPreviewableFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return BROWSER_PREVIEW_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isPdfFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.pdf');
}

export function isUnsupportedBinaryFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return UNSUPPORTED_BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function getMediaKind(filePath: string): 'audio' | 'video' | null {
  if (isAudioFile(filePath)) return 'audio';
  if (isVideoFile(filePath)) return 'video';
  return null;
}

export function getMimeType(filePath: string): string {
  const lower = filePath.toLowerCase();
  for (const ext of [
    ...IMAGE_EXTENSIONS,
    ...AUDIO_EXTENSIONS,
    ...VIDEO_EXTENSIONS,
    ...BROWSER_PREVIEW_EXTENSIONS,
  ]) {
    if (lower.endsWith(ext)) return MIME_TYPES[ext];
  }
  return 'application/octet-stream';
}

export type ViewableFileKind =
  | 'image'
  | 'svg'
  | 'html'
  | 'pdf'
  | 'markdown'
  | 'audio'
  | 'video'
  | 'text';

/** How the file viewer shows a file, or null for a type it has no view for. */
export function getViewableFileKind(filePath: string): ViewableFileKind | null {
  const lower = filePath.toLowerCase();
  if (isImageFile(lower)) return 'image';
  if (lower.endsWith('.svg')) return 'svg';
  if (isHtmlFile(lower)) return 'html';
  if (isPdfFile(lower)) return 'pdf';
  if (MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'markdown';
  const mediaKind = getMediaKind(lower);
  if (mediaKind) return mediaKind;
  if (VIEWABLE_TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return 'text';
  return null;
}
