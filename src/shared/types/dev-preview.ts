import type { TerminalExecutionLocation } from './terminal';

export interface DevPreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type DevPreviewNavigationDirection = 'back' | 'forward';

/** A browser tab of a workspace, which has its own native page. */
export interface DevPreviewTabRef {
  workspaceId: string;
  tabId: string;
}

export interface DevPreviewNavigationState extends DevPreviewTabRef {
  url: string;
  /** Empty while the page has no title of its own. */
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Why the page last failed to load, until it loads again. */
  loadError: string | null;
}

export interface DevPreviewSnapshot extends DevPreviewTabRef {
  dataUrl: string;
}

/** A page asked to open a URL in a new window, which Komla opens as a tab instead. */
export interface DevPreviewOpenTabRequest extends DevPreviewTabRef {
  url: string;
}

/** A TCP port that a process started from one of the workspace's terminals or background runs listens on. */
export interface DevPreviewService {
  port: number;
  /** Scheme the port answered HTTP on, or null when it did not answer HTTP. */
  scheme: 'http' | 'https' | null;
  pid: number;
  processName: string;
  /** Missing for a server a background run started. */
  terminalId?: string;
  executionLocation: TerminalExecutionLocation;
}

/** An HTTP server the user runs outside Komla, on the machine the workspace's terminals run on. */
export interface DevPreviewOtherServer {
  port: number;
  scheme: 'http' | 'https';
  processName: string;
  /** `workspace` is the SSH host in an SSH workspace, as for terminal services. */
  executionLocation: TerminalExecutionLocation;
}

export interface DevPreviewServiceDetection {
  /** In an SSH workspace, services with the `workspace` location run on the SSH host. */
  services: DevPreviewService[];
  /** HTTP servers on the same machine that no Komla terminal started. */
  otherServers: DevPreviewOtherServer[];
  /** Requested ports that accepted a connection on this machine's loopback interface. */
  openPorts: number[];
  /** Requested SSH host ports something listens on, or null when they could not be checked. */
  remoteOpenPorts: number[] | null;
  /**
   * Of the requested `ownPorts`, those a process of this computer's user listens on, on the
   * workspace's machine (the SSH host for an SSH workspace): never another user's. Null when
   * that could not be checked; missing when none were requested.
   */
  ownOpenPorts?: number[] | null;
  /** When main began reading the ports, as Date.now() there; set with `ownOpenPorts`. */
  checkedAt?: number;
}

/** A page to describe, as on this machine or, in an SSH workspace, on the SSH host. */
export interface LinkPreviewRequest {
  url: string;
  workspaceId: string;
  /** The URL points at the SSH host's loopback interface. */
  onSshHost: boolean;
  /** The process serving a local page, so a new server on the same port is read again. */
  pid?: number;
}

/** What a page says about itself, read from the start of its HTML. */
export interface LinkPreview {
  /** The page's og:title; for a page on this computer, else its <title>. */
  title?: string;
  siteName?: string;
  description?: string;
  /** The og:image, which `getLinkPreviewImage` fetches when it's shown. */
  imageUrl?: string;
  /** The site's icon, as a data: URL. */
  iconDataUrl?: string;
  /** What serves the page, as in "Vite", "Next.js" or "uvicorn". */
  servedBy?: string;
  /** The page isn't HTML but JSON, as an API's is. */
  isJson?: boolean;
  /**
   * The details are the site's, from its home page, as the page has no Open Graph title
   * of its own or needs you signed in.
   */
  fromSite?: boolean;
}

/**
 * Where `komla desktop run --browser` or `--app` opens an SSH host's virtual desktop: in the
 * browser preview through noVNC, or in the app this computer opens vnc:// links with, such as
 * Screen Sharing on macOS.
 */
export const VIRTUAL_DESKTOP_VIEWERS = ['preview', 'vnc-app'] as const;
export type VirtualDesktopViewer = (typeof VIRTUAL_DESKTOP_VIEWERS)[number];
