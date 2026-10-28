import { MAX_BROWSER_URL_LENGTH, isBrowserUrl } from './browser-tabs';

import type { WorkspaceVirtualDesktop } from '../types/workspace';

/** A machine numbers its virtual desktops :1 to :99. */
export const MAX_VIRTUAL_DESKTOPS = 99;
// VNC passwords stop at 8 characters.
export const MAX_VNC_PASSWORD_LENGTH = 8;
export const MAX_VIRTUAL_DESKTOP_NAME_LENGTH = 200;

const FIRST_VNC_PORT = 5900;

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function savedText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

/** A workspace's saved desktops, as `desktop.open` saves them, for a hand-edited file. */
export function normalizeVirtualDesktops(value: unknown): WorkspaceVirtualDesktop[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ports = new Set<number>();
  const desktops: WorkspaceVirtualDesktop[] = [];
  for (const entry of value.slice(0, MAX_VIRTUAL_DESKTOPS)) {
    if (!entry || typeof entry !== 'object') continue;
    const { vncPort, vncPassword, url, app, vncApp, shownAt } = entry as Record<string, unknown>;
    if (!isPort(vncPort) || ports.has(vncPort)) continue;
    if (typeof shownAt !== 'number' || !Number.isInteger(shownAt) || shownAt < 0) continue;
    ports.add(vncPort);
    const desktop: WorkspaceVirtualDesktop = { vncPort, shownAt };
    const password = savedText(vncPassword, MAX_VNC_PASSWORD_LENGTH);
    if (password) desktop.vncPassword = password;
    if (typeof url === 'string' && url.length <= MAX_BROWSER_URL_LENGTH && isBrowserUrl(url)) {
      desktop.url = url;
    }
    const appName = savedText(app, MAX_VIRTUAL_DESKTOP_NAME_LENGTH);
    if (appName) desktop.app = appName;
    const vncAppName = savedText(vncApp, MAX_VIRTUAL_DESKTOP_NAME_LENGTH);
    if (vncAppName) desktop.vncApp = vncAppName;
    desktops.push(desktop);
  }
  return desktops.length > 0 ? desktops : undefined;
}

/** The desktop's X display, as in ":3". */
export function virtualDesktopDisplay(desktop: WorkspaceVirtualDesktop): string {
  return `:${desktop.vncPort - FIRST_VNC_PORT}`;
}

/** The port its noVNC page is served on, if it has one. */
export function virtualDesktopViewerPort(desktop: WorkspaceVirtualDesktop): number | undefined {
  if (!desktop.url) return undefined;
  try {
    const port = Number(new URL(desktop.url).port);
    return isPort(port) ? port : undefined;
  } catch {
    return undefined;
  }
}
