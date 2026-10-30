// Wire-shape types for the remote-control IPC surface. Shared between the
// main service (source of truth) and the renderer (consumer) so the preload
// surface stays a single typed seam — no mismatch when the state shape grows.

export interface RemoteControlError {
  /** WebSocket close code if the failure originated at the socket layer. */
  code?: number;
  /** Short machine-readable reason. */
  reason?: string;
  /** Human-readable message — safe to surface in the UI. */
  message: string;
}

export interface RemoteControlDirectServerInfo {
  host: string;
  port: number;
  preferredPort: number;
  localOrigin: string;
  httpOrigin: string;
  wsUrl: string;
  fingerprint: string;
}

export interface RemoteControlDirectStartOptions {
  publicOrigin?: string;
}

export interface RemoteControlDirectTailscaleServeResult {
  server: RemoteControlDirectServerInfo;
  command: string;
}

export interface RemoteControlDirectTailscaleStatus {
  installed: boolean;
  /** What publishing runs, on the HTTPS port of the saved origin or else the suggested one. */
  command: string;
  hostname?: string;
  /** Installed, but this computer isn't on the tailnet: signed out, not approved, or stopped. */
  needsSignIn?: boolean;
  suggestedOrigin?: string;
  /** Another Tailscale Serve route already has the HTTPS port `command` publishes on. */
  httpsPortTaken?: boolean;
  serveConfigured?: boolean;
  error?: string;
}

export interface RemoteControlDirectPortChange {
  oldPort: number;
  newPort: number;
}

export interface RemoteControlDirectPairingOffer {
  pairUrl: string;
  fingerprint: string;
  pairingSecret: string;
}

export interface RemoteControlConnectedDevice {
  credentialId: string;
  label: string;
  connectedAt: number;
}

/** Phone access to one SSH host through its Remote Companion (ADR 0005). */
export interface RemoteControlHostAccessStatus {
  hostId: string;
  hostName: string;
  enabled: boolean;
  /** `pending`: on, but the host has not heard about a change yet. */
  state: 'off' | 'setting-up' | 'pending' | 'ready' | 'needs-attention';
  message?: string;
  /** WebSocket URL the phone opens, published with Tailscale Serve on the host. */
  url?: string;
  syncedAt?: number;
}

/** An SSH host a signed-in phone may open directly. */
export interface RemoteControlHostEndpoint {
  id: string;
  name: string;
  url: string;
  fingerprint: string;
}

export interface RemoteControlDirectState {
  server: RemoteControlDirectServerInfo | null;
  pairingOffer: RemoteControlDirectPairingOffer | null;
  portChange: RemoteControlDirectPortChange | null;
  connectedDevice?: RemoteControlConnectedDevice | null;
}
