import { readFile, stat } from 'fs/promises';
import { join } from 'path';

import { MAX_STATUS_ICON_BYTES } from '../../shared/types/status-items';

const DATA_URL = /^data:(image\/(?:svg\+xml|png|webp|gif|jpeg))(;base64)?,(.*)$/s;
const ICON_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};
/** An icon file in the settings folder's icons folder, as status-items.json names it. */
const SETTINGS_ICON = /^icons\/[A-Za-z0-9][A-Za-z0-9._-]*\.(svg|png|webp|gif|jpe?g)$/i;

function dataUrl(type: string, bytes: Buffer): string | undefined {
  if (bytes.length === 0 || bytes.length > MAX_STATUS_ICON_BYTES) return undefined;
  return `data:${type};base64,${bytes.toString('base64')}`;
}

/**
 * An icon as the base64 data URL the status bar shows, from SVG markup or an image data URL;
 * undefined for anything else, or an image too large. The bar shows it as an image, where SVG
 * runs no scripts and loads nothing.
 */
export function statusIconDataUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('<svg')) return dataUrl('image/svg+xml', Buffer.from(trimmed));
  const match = DATA_URL.exec(trimmed);
  if (!match) return undefined;
  const [, type, base64, payload] = match;
  try {
    return dataUrl(
      type,
      base64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload))
    );
  } catch {
    return undefined;
  }
}

export function isSettingsIconPath(value: string): boolean {
  return SETTINGS_ICON.test(value);
}

// Icon files as read, so an item's runs read a file again only once it changes.
const iconFiles = new Map<string, { version: string; url: string | undefined }>();

/**
 * An icon from status-items.json or a command's output: a file in the settings folder's icons
 * folder, such as `icons/acme.svg`, SVG markup or an image data URL.
 */
export async function readStatusIcon(
  settingsPath: string,
  value: string
): Promise<string | undefined> {
  if (!isSettingsIconPath(value)) return statusIconDataUrl(value);
  const extension = value.slice(value.lastIndexOf('.') + 1).toLowerCase();
  const path = join(settingsPath, value);
  try {
    const { mtimeMs, size } = await stat(path);
    const version = `${mtimeMs}:${size}`;
    const cached = iconFiles.get(path);
    if (cached?.version === version) return cached.url;
    const url = dataUrl(ICON_TYPES[extension], await readFile(path));
    iconFiles.set(path, { version, url });
    return url;
  } catch {
    iconFiles.delete(path);
    return undefined;
  }
}
