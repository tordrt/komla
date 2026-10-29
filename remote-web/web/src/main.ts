// Browser entry for Komla's desktop-served remote-control page.
//
// The same HTML serves two flows:
//
//   1. Enrollment. The one-time QR fragment carries the desktop fingerprint
//      and a 256-bit secret. The browser creates a non-exportable installation
//      key and a user-verified passkey; the desktop binds both credentials.
//
//   2. Authenticated reconnect. The browser loads its installation key from
//      IndexedDB, then proves possession of it and the exact registered
//      passkey. Both proofs are bound to the current encrypted transcript.

import {
  buildDeviceProof,
  classifyRelayFrame,
  decodeBinaryAppFrame,
  encodeBase64,
  encodeBinaryTerminalInput,
  FrameTooLargeError,
  isValidFingerprint,
  PAIR_PROTOCOL_VERSION,
  parsePairFrame,
  parseRemoteAppFrame,
  Peer,
  RELAY_PING_FRAME,
  RELAY_PONG_FRAME,
  REMOTE_CAPABILITIES,
  SESSION_CLOSE,
  signDeviceProof,
  type RemoteAgentPresetSummary,
  type RemoteActionSummary,
  type RemoteAppFrame,
  type RemotePushConfig,
  type RemotePushNotifyWhen,
  type RemoteLaunchEnvironmentSummary,
  type RemoteProjectSummary,
  type RemoteWorkspaceSummary,
  type PairAuthChallenge,
  type PairAuthenticated,
  type PairFrame,
  type PairRegistrationChallenge,
  type PairResumeChallenge,
} from '@komla/remote-protocol';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { floatToPcm16, startAudioCapture, type AudioCaptureHandle } from './audio-capture';
import { agentIconSvg } from './agent-icons';
import { attentionLabel, attentionMessageIsLabel } from './attention';
import { ConnectionWatchdog, reconnectDelayMs } from './connection-watchdog';
import { ReconnectLoop, type ReconnectOutcome } from './reconnect-loop';
import {
  discardRejectedEnrollmentIdentity,
  loadOrCreateEnrollmentDeviceIdentity,
  loadDeviceIdentity,
  removeDeviceIdentity,
  stageEnrollmentDeviceIdentity,
  type PendingDeviceIdentity,
  type StoredDeviceIdentity,
} from './device-identity';
import { deriveDefaultDeviceLabel } from './device-label';
import { parsePairUrl, PairUrlError, pastedPairUrl } from './pair-url';
import {
  mayPromptWithoutTap,
  passkeyErrorMessage,
  signInRejection,
  type PromptEnvironment,
} from './passkey-sign-in';
import { bindSelectPicker, colorDotMark, launchModeColor } from './select-picker';
import {
  currentPushEnvironment,
  isAppleTouchDevice,
  pushSupport,
  subscribeBrowser,
  toPushFrameSubscription,
  unsubscribeBrowser,
} from './push-notifications';
import {
  assertionToJSON,
  attestationToJSON,
  base64UrlToBytes,
  bytesToBase64Url,
  userHandleToFingerprint,
} from './webauthn';
import {
  applyTerminalModifiers,
  flingStep,
  isTerminalTapGesture,
  isTerminalViewportAtBottom,
  railWheelRate,
  scrollThumbLine,
  TerminalMutationQueue,
  terminalProgramScrolls,
} from './terminal-interaction';
import {
  TerminalScreenCache,
  trackMouseEncoding,
  type CachedTerminalScreen,
  type MouseEncodingTracker,
} from './terminal-screen-cache';
import {
  joinSoftWraps,
  readTerminalLogicalLine,
  terminalSelectionText,
  terminalUrls,
  terminalWordAt,
  type TerminalSelectionText,
} from './terminal-text';
import {
  defaultEnvironmentValue,
  environmentValue,
  parseEnvironmentValue,
} from './launch-environment';
import { TerminalSizeOwner, type TerminalSizeWord } from './terminal-size-owner';
import { splitTerminalInput, TerminalStreamCursor, WorkspacePages } from './terminal-stream';
import {
  buildWorkspaceSections,
  hasLiveTerminal,
  parseCollapsedSections,
  workspaceSectionCounts,
  type WorkspaceFilter,
  type WorkspaceSectionId,
} from './workspace-sections';
import {
  endpointHref,
  hasLastEndpoint,
  rememberDesktop,
  rememberedDesktopFingerprint,
  rememberedHosts,
  rememberHosts,
  rememberLastEndpoint,
  selectedHostId,
  startingHostId,
  type HostEndpoint,
} from './endpoints';

const REMOTE_LAUNCH_PREFERENCES_KEY = 'komla.remote.launchPreferences';
const REMOTE_RECONNECT_ATTEMPT_KEY = 'komla.remote.reconnectAttempt';
const REMOTE_RESUME_GRANT_KEY = 'komla.remote.resumeGrant';
const REMOTE_COLLAPSED_SECTIONS_KEY = 'komla.remote.collapsedSections.v2';
// Saved before the Trash section; read once for a page that has no list under the key above.
const REMOTE_LEGACY_COLLAPSED_SECTIONS_KEY = 'komla.remote.collapsedSections';
const REMOTE_REQUEST_TIMEOUT_MS = 15_000;
const TERMINAL_ENTER = '\r';
const PHONE_LAYOUT_QUERY = '(max-width: 760px)';
// Superset Mobile's size: a few more columns on a phone, where width is what runs out.
const PHONE_TERMINAL_FONT_SIZE = 12;
const TERMINAL_FONT_SIZE = 13;
const MOBILE_TERMINAL_KEYS: Record<string, string> = {
  esc: '\x1b',
  enter: TERMINAL_ENTER,
  tab: '\t',
  'shift-tab': '\x1b[Z',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
  left: '\x1b[D',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
};

interface DirectRemoteConfig {
  fingerprint: string;
  wsUrl: string;
}

/** What this page is connected to: the desktop, or an SSH host it vouched for. */
interface AppEndpoint {
  desktopFingerprint: string;
  host: HostEndpoint | null;
}

/** Where this page's sessions go, and the browser installation key it signs in with. */
interface SessionTarget {
  url: string;
  fingerprint: string;
  device: StoredDeviceIdentity;
}

/** One authenticated connection: the socket and the encrypted Peer over it. */
interface LiveConnection {
  ws: WebSocket;
  peer: Peer;
}

/** Protocol features this page offers in its hello. */
const PAGE_CAPABILITIES = [REMOTE_CAPABILITIES.BINARY_FRAMES];
const RELOADED_FOR_BUILD_KEY = 'komla.remote.reloadedForBuild';
// A flick leaves with the speed of its last moments, if fast enough to coast.
const FLING_SAMPLE_MS = 80;
const FLING_START_VELOCITY = 0.3;
// Native momentum fires scroll events this close together; a longer gap means it has ended.
const USER_SCROLL_SETTLE_MS = 150;
// A finger held this long without moving selects text instead of tapping or scrolling.
const LONG_PRESS_MS = 450;
const TAP_SLOP_PX = 10;
// Holding one of these alone, e.g. on the way to a shortcut, doesn't use the terminal.
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);
// iOS empties a selection for a moment while it places the loupe or the menu.
const SELECTION_EMPTY_EXIT_MS = 250;
// Scrollback kept with a terminal's screen for switching back to it.
const CACHED_SCROLLBACK_ROWS = 1000;
const MIN_SCROLL_THUMB_PX = 36;
// A fullscreen program's rail thumb, which only rests mid-rail or gets pulled.
const RAIL_HANDLE_PX = 56;

/** How long one in-place reconnect may take before it is retried. */
const RECONNECT_ATTEMPT_TIMEOUT_MS = 10_000;
/** In-place attempts (about 8 s of backoff) before reloading to the offline screen. */
const RECONNECT_ATTEMPTS_BEFORE_RELOAD = 4;

let directRemoteConfig: DirectRemoteConfig | null = null;
/** Whether /remote/config could not be fetched at all: the desktop is off or unreachable. */
let directRemoteUnreachable = false;

interface UI {
  title: HTMLElement;
  subtitle: HTMLElement;
  status: HTMLElement;
  fingerprintRow: HTMLElement;
  fingerprint: HTMLElement;
  form: HTMLElement;
  label: HTMLInputElement;
  register: HTMLButtonElement;
  error: HTMLElement;
  success: HTMLElement;
  offlineHosts: HTMLElement;
  homeScreenHandoff: HTMLElement;
  copyPairLink: HTMLButtonElement;
  pairLinkForm: HTMLElement;
  pairLink: HTMLInputElement;
  pastePairLink: HTMLButtonElement;
  unlock: HTMLButtonElement;
}

interface RemoteUI {
  pairCard: HTMLElement;
  endpointSwitch: HTMLButtonElement;
  endpointName: HTMLElement;
  endpointSheet: HTMLDialogElement;
  endpointList: HTMLElement;
  shell: HTMLElement;
  remoteNotice: HTMLElement;
  connectionPill: HTMLElement;
  connectionLabel: HTMLElement;
  openSettings: HTMLButtonElement;
  settingsSheet: HTMLDialogElement;
  settingsDeviceLabel: HTMLElement;
  pushToggle: HTMLInputElement;
  pushStatus: HTMLElement;
  pushWhen: HTMLFieldSetElement;
  pushTest: HTMLButtonElement;
  pushHint: HTMLElement;
  workspaceSearch: HTMLInputElement;
  workspaceFilters: HTMLElement;
  workspaceList: HTMLElement;
  openCreateWorkspace: HTMLButtonElement;
  voiceCreateWorkspace: HTMLButtonElement;
  workspaceVoice: HTMLElement;
  workspaceVoiceStatus: HTMLElement;
  workspaceVoiceMeter: HTMLElement;
  workspaceVoiceEdit: HTMLButtonElement;
  workspaceVoiceLaunch: HTMLButtonElement;
  workspaceVoiceCancel: HTMLButtonElement;
  createDialog: HTMLDialogElement;
  cancelCreateWorkspace: HTMLButtonElement;
  projectSelect: HTMLSelectElement;
  presetSelect: HTMLSelectElement;
  launchModeSelect: HTMLSelectElement;
  environmentField: HTMLElement;
  environmentSelect: HTMLSelectElement;
  initialPrompt: HTMLTextAreaElement;
  promptVoice: HTMLButtonElement;
  promptVoiceUnavailable: HTMLElement;
  createWorkspace: HTMLButtonElement;
  createWorkspaceError: HTMLElement;
  backToWorkspacesHeader: HTMLButtonElement;
  workspaceActionsTrigger: HTMLButtonElement;
  workspaceActionsMenu: HTMLDialogElement;
  workspaceActionsTitle: HTMLElement;
  workspaceActionsRoot: HTMLElement;
  workspaceActionsSubmenu: HTMLElement;
  workspaceActionsOpen: HTMLButtonElement;
  newTabAgents: HTMLElement;
  pickerSheet: HTMLDialogElement;
  workspaceActionItems: HTMLElement;
  workspaceRowSheet: HTMLDialogElement;
  workspaceRowTitle: HTMLElement;
  workspaceRowActions: HTMLElement;
  terminalLaunchDialog: HTMLDialogElement;
  cancelTerminalLaunch: HTMLButtonElement;
  terminalLaunchTitle: HTMLElement;
  terminalLaunchDescription: HTMLElement;
  terminalAgentPresetField: HTMLElement;
  terminalAgentPreset: HTMLSelectElement;
  terminalAgentLaunchModeField: HTMLElement;
  terminalAgentLaunchMode: HTMLSelectElement;
  terminalLaunchInputField: HTMLElement;
  terminalLaunchInputLabel: HTMLElement;
  terminalLaunchInput: HTMLTextAreaElement;
  createTerminal: HTMLButtonElement;
  terminalPanel: HTMLElement;
  terminalToolbar: HTMLElement;
  terminalWorkspaceName: HTMLElement;
  terminalEnvironment: HTMLElement;
  terminalWorkspaceStatus: HTMLElement;
  terminalTabs: HTMLElement;
  terminalStatusOverlay: HTMLElement;
  terminalStatusText: HTMLElement;
  terminalJumpLatest: HTMLButtonElement;
  terminalDesktopSize: HTMLElement;
  terminalHost: HTMLElement;
  terminalTouchScroll: HTMLElement;
  terminalTouchScrollSpacer: HTMLElement;
  terminalSelect: HTMLElement;
  terminalSelectText: HTMLElement;
  terminalCopy: HTMLButtonElement;
  terminalSelectDone: HTMLButtonElement;
  terminalScrollIndicator: HTMLElement;
  terminalScrollThumb: HTMLElement;
  mobileKeyboardBar: HTMLElement;
  mobileKeys: HTMLElement;
  voiceBar: HTMLElement;
  voiceIdle: HTMLElement;
  voiceLive: HTMLElement;
  terminalComposer: HTMLInputElement;
  terminalSend: HTMLButtonElement;
  terminalKeysToggle: HTMLButtonElement;
  voiceRecord: HTMLButtonElement;
  voiceAbort: HTMLButtonElement;
  voiceUse: HTMLButtonElement;
  voiceSend: HTMLButtonElement;
  voiceMeter: HTMLElement;
  voiceStatus: HTMLElement;
}

interface LaunchPreferences {
  projectId?: string;
  presetId?: string;
  launchModeId?: string | null;
  environment?: string;
}

interface StoredResumeGrant {
  fingerprint: string;
  deviceId: string;
  token: string;
  expiresAt: number;
}

function ui(): UI {
  return {
    title: byId('page-title'),
    subtitle: byId('page-subtitle'),
    status: byId('status'),
    fingerprintRow: byId('fingerprint-row'),
    fingerprint: byId('fingerprint'),
    form: byId('register-form'),
    label: byId('label') as HTMLInputElement,
    register: byId('register') as HTMLButtonElement,
    error: byId('error'),
    success: byId('success'),
    offlineHosts: byId('offline-hosts'),
    homeScreenHandoff: byId('home-screen-handoff'),
    copyPairLink: byId('copy-pair-link') as HTMLButtonElement,
    pairLinkForm: byId('pair-link-form'),
    pairLink: byId('pair-link') as HTMLInputElement,
    pastePairLink: byId('paste-pair-link') as HTMLButtonElement,
    unlock: byId('unlock') as HTMLButtonElement,
  };
}

function remoteUi(): RemoteUI {
  return {
    pairCard: byId('pair-card'),
    endpointSwitch: byId('endpoint-switch') as HTMLButtonElement,
    endpointName: byId('endpoint-name'),
    endpointSheet: byId('endpoint-sheet') as HTMLDialogElement,
    endpointList: byId('endpoint-list'),
    shell: byId('remote-shell'),
    remoteNotice: byId('remote-notice'),
    connectionPill: byId('connection-pill'),
    connectionLabel: byId('connection-label'),
    openSettings: byId('open-settings') as HTMLButtonElement,
    settingsSheet: byId('settings-sheet') as HTMLDialogElement,
    settingsDeviceLabel: byId('settings-device-label'),
    pushToggle: byId('push-toggle') as HTMLInputElement,
    pushStatus: byId('push-status'),
    pushWhen: byId('push-when') as HTMLFieldSetElement,
    pushTest: byId('push-test') as HTMLButtonElement,
    pushHint: byId('push-hint'),
    workspaceSearch: byId('workspace-search') as HTMLInputElement,
    workspaceFilters: byId('workspace-filters'),
    workspaceList: byId('workspace-list'),
    openCreateWorkspace: byId('open-create-workspace') as HTMLButtonElement,
    voiceCreateWorkspace: byId('voice-create-workspace') as HTMLButtonElement,
    workspaceVoice: byId('workspace-voice'),
    workspaceVoiceStatus: byId('workspace-voice-status'),
    workspaceVoiceMeter: byId('workspace-voice-meter'),
    workspaceVoiceEdit: byId('workspace-voice-edit') as HTMLButtonElement,
    workspaceVoiceLaunch: byId('workspace-voice-launch') as HTMLButtonElement,
    workspaceVoiceCancel: byId('workspace-voice-cancel') as HTMLButtonElement,
    createDialog: byId('create-workspace-dialog') as HTMLDialogElement,
    cancelCreateWorkspace: byId('cancel-create-workspace') as HTMLButtonElement,
    projectSelect: byId('project-select') as HTMLSelectElement,
    presetSelect: byId('preset-select') as HTMLSelectElement,
    launchModeSelect: byId('launch-mode-select') as HTMLSelectElement,
    environmentField: byId('environment-field'),
    environmentSelect: byId('environment-select') as HTMLSelectElement,
    initialPrompt: byId('initial-prompt') as HTMLTextAreaElement,
    promptVoice: byId('prompt-voice') as HTMLButtonElement,
    promptVoiceUnavailable: byId('prompt-voice-unavailable'),
    createWorkspace: byId('create-workspace') as HTMLButtonElement,
    createWorkspaceError: byId('create-workspace-error'),
    backToWorkspacesHeader: byId('back-to-workspaces-header') as HTMLButtonElement,
    workspaceActionsTrigger: byId('workspace-actions-trigger') as HTMLButtonElement,
    workspaceActionsMenu: byId('workspace-actions-menu') as HTMLDialogElement,
    workspaceActionsTitle: byId('workspace-actions-title'),
    workspaceActionsRoot: byId('workspace-actions-root'),
    workspaceActionsSubmenu: byId('workspace-actions-submenu'),
    workspaceActionsOpen: byId('workspace-actions-open') as HTMLButtonElement,
    newTabAgents: byId('new-tab-agents'),
    pickerSheet: byId('picker-sheet') as HTMLDialogElement,
    workspaceActionItems: byId('workspace-action-items'),
    workspaceRowSheet: byId('workspace-row-sheet') as HTMLDialogElement,
    workspaceRowTitle: byId('workspace-row-title'),
    workspaceRowActions: byId('workspace-row-actions'),
    terminalLaunchDialog: byId('terminal-launch-dialog') as HTMLDialogElement,
    cancelTerminalLaunch: byId('cancel-terminal-launch') as HTMLButtonElement,
    terminalLaunchTitle: byId('terminal-launch-title'),
    terminalLaunchDescription: byId('terminal-launch-description'),
    terminalAgentPresetField: byId('terminal-agent-preset-field'),
    terminalAgentPreset: byId('terminal-agent-preset') as HTMLSelectElement,
    terminalAgentLaunchModeField: byId('terminal-agent-launch-mode-field'),
    terminalAgentLaunchMode: byId('terminal-agent-launch-mode') as HTMLSelectElement,
    terminalLaunchInputField: byId('terminal-launch-input-field'),
    terminalLaunchInputLabel: byId('terminal-launch-input-label'),
    terminalLaunchInput: byId('terminal-launch-input') as HTMLTextAreaElement,
    createTerminal: byId('create-terminal') as HTMLButtonElement,
    terminalPanel: byId('terminal-panel'),
    terminalToolbar: byId('terminal-toolbar'),
    terminalWorkspaceName: byId('terminal-workspace-name'),
    terminalEnvironment: byId('terminal-environment'),
    terminalWorkspaceStatus: byId('terminal-workspace-status'),
    terminalTabs: byId('terminal-tabs'),
    terminalStatusOverlay: byId('terminal-status-overlay'),
    terminalStatusText: byId('terminal-status-text'),
    terminalJumpLatest: byId('terminal-jump-latest') as HTMLButtonElement,
    terminalDesktopSize: byId('terminal-desktop-size'),
    terminalHost: byId('terminal'),
    terminalTouchScroll: byId('terminal-touch-scroll'),
    terminalTouchScrollSpacer: byId('terminal-touch-scroll-spacer'),
    terminalSelect: byId('terminal-selection'),
    terminalSelectText: byId('terminal-selection-text'),
    terminalCopy: byId('terminal-copy') as HTMLButtonElement,
    terminalSelectDone: byId('terminal-select-done') as HTMLButtonElement,
    terminalScrollIndicator: byId('terminal-scroll-indicator'),
    terminalScrollThumb: byId('terminal-scroll-thumb'),
    mobileKeyboardBar: byId('mobile-keyboard-bar'),
    mobileKeys: byId('mobile-keys'),
    voiceBar: byId('voice-bar'),
    voiceIdle: byId('voice-idle'),
    voiceLive: byId('voice-live'),
    terminalComposer: byId('terminal-composer') as HTMLInputElement,
    terminalSend: byId('terminal-send') as HTMLButtonElement,
    terminalKeysToggle: byId('terminal-keys-toggle') as HTMLButtonElement,
    voiceRecord: byId('voice-record') as HTMLButtonElement,
    voiceAbort: byId('voice-abort') as HTMLButtonElement,
    voiceUse: byId('voice-use') as HTMLButtonElement,
    voiceSend: byId('voice-send') as HTMLButtonElement,
    voiceMeter: byId('voice-meter'),
    voiceStatus: byId('voice-status'),
  };
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

type StatusKind =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'verifying'
  | 'registered'
  | 'authenticated'
  | 'error';

type RemoteTerminalSummary = RemoteWorkspaceSummary['terminals'][number];

function setStatus(el: HTMLElement, kind: StatusKind, text: string): void {
  el.className = `value status status-${kind}`;
  el.textContent = text;
}

function showError(els: UI, message: string): void {
  els.error.textContent = message;
  els.error.hidden = false;
  els.success.hidden = true;
}

function showSuccess(els: UI, message: string): void {
  els.success.textContent = message;
  els.success.hidden = false;
  els.error.hidden = true;
}

function shortFp(fp: string): string {
  return `${fp.slice(0, 12)}…${fp.slice(-4)}`;
}

function readDirectRemoteConfig(): DirectRemoteConfig | null {
  return directRemoteConfig;
}

function parseDirectRemoteConfig(candidate: unknown): DirectRemoteConfig | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const { fingerprint, wsUrl } = candidate as { fingerprint?: unknown; wsUrl?: unknown };
  if (typeof fingerprint !== 'string' || !isValidFingerprint(fingerprint)) return null;
  if (typeof wsUrl !== 'string' || !/^wss?:\/\//.test(wsUrl)) return null;
  return { fingerprint, wsUrl };
}

async function loadDirectRemoteConfig(): Promise<void> {
  directRemoteUnreachable = false;
  try {
    const response = await fetch('/remote/config', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    // An installed app opened while Komla is closed gets its cached shell, and a 502/503 from
    // Tailscale Serve or a starting desktop: both mean "try again soon".
    if (response.status >= 500) {
      directRemoteUnreachable = true;
      return;
    }
    if (!response.ok) return;
    directRemoteConfig = parseDirectRemoteConfig(await response.json());
    if (directRemoteConfig) rememberDesktop(localStorage, directRemoteConfig.fingerprint);
  } catch {
    directRemoteConfig = null;
    directRemoteUnreachable = true;
  }
}

function registerServiceWorker(): void {
  // Installing the app and receiving notifications both need the worker. It caches only the
  // public app shell, so failing to register just leaves the page an ordinary tab.
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('sw.js', { scope: './' }).catch((err: unknown) => {
    console.warn('Service worker registration failed', err);
  });
}

let reconnectScheduled = false;

/**
 * Reloads the page to reconnect: after `delayMs`, or at once when the network comes back or the
 * page returns to the foreground, since a phone that slept or roamed is likely reachable again.
 * A hidden page never reloads; it waits until the user looks at it.
 */
function scheduleReconnect(delayMs: number): void {
  if (reconnectScheduled) return;
  reconnectScheduled = true;
  let timer: number | null = null;
  const reconnectNow = () => {
    if (document.visibilityState === 'hidden') return;
    if (timer !== null) window.clearTimeout(timer);
    location.reload();
  };
  timer = window.setTimeout(reconnectNow, delayMs);
  window.addEventListener('online', reconnectNow);
  document.addEventListener('visibilitychange', reconnectNow);
}

/**
 * Runs `then` once the Peer has delivered every frame that arrived before the socket closed, so a
 * rejection's reason is read before the close is acted on.
 */
function afterPeerClosed(peer: Peer, evt: CloseEvent, then: () => void): void {
  if (peer.state === 'closed') {
    then();
    return;
  }
  peer.onClose(then);
  peer.handleClose({ code: evt.code, reason: evt.reason });
}

/** A socket and the Peer over it, able to switch to binary frames. */
function openPeerSocket(url: string, fingerprint: string): LiveConnection {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const peer = new Peer({
    role: 'client',
    expectedFingerprint: fingerprint,
    transport: {
      send: (data) => ws.send(data),
      // Envelopes are always backed by a plain ArrayBuffer.
      sendBinary: (data) => ws.send(data as Uint8Array<ArrayBuffer>),
      close: (code, reason) => ws.close(code, reason),
    },
  });
  return { ws, peer };
}

/**
 * Applies what the endpoint agreed to in pair:authenticated. False when the
 * desktop serves another build of this app: the page must reload to run it.
 */
function adoptAuthenticated(peer: Peer, frame: PairAuthenticated, fromDesktop: boolean): boolean {
  if (fromDesktop && frame.build && frame.build !== __REMOTE_APP_BUILD__) {
    // Once per build, so a desktop that names a build it doesn't serve can't loop the page.
    let reloaded: string | null = null;
    try {
      reloaded = sessionStorage.getItem(RELOADED_FOR_BUILD_KEY);
      sessionStorage.setItem(RELOADED_FOR_BUILD_KEY, frame.build);
    } catch {
      // Without storage the page may reload once more than needed.
    }
    if (reloaded !== frame.build) return false;
  }
  if (frame.capabilities?.includes(REMOTE_CAPABILITIES.BINARY_FRAMES)) peer.enableBinaryFrames();
  return true;
}

/**
 * Offers this pairing link to the Home Screen app. On iPhone and iPad that app keeps its own
 * storage, separate from Safari's, so a key paired here is no use there, and a scanned QR code
 * always opens Safari.
 */
function offerHomeScreenHandoff(els: UI): void {
  const env = currentPushEnvironment();
  if (!isAppleTouchDevice(env) || env.standalone) return;
  els.homeScreenHandoff.hidden = false;
  els.copyPairLink.addEventListener('click', () => {
    void navigator.clipboard.writeText(location.href).then(
      () => {
        els.copyPairLink.textContent = 'Copied';
      },
      () => showError(els, "Couldn't copy the link. Copy it from the address bar instead.")
    );
  });
}

/** Pairs this page from a pasted link: the way in for a Home Screen app the QR code can't open. */
function showPairLinkForm(els: UI): void {
  els.pairLinkForm.hidden = false;
  const open = (text: string, reportError: boolean) => {
    try {
      location.assign(pastedPairUrl(text, location.origin));
    } catch (err) {
      if (reportError) showError(els, (err as Error).message);
    }
  };
  els.pairLink.addEventListener('input', () => open(els.pairLink.value, false));
  els.pairLink.addEventListener('change', () => open(els.pairLink.value, true));
  els.pastePairLink.addEventListener('click', () => {
    const pasteHere = () => {
      showError(els, 'Paste the link into the field above.');
      els.pairLink.focus();
    };
    if (!navigator.clipboard?.readText) {
      pasteHere();
      return;
    }
    void navigator.clipboard.readText().then((text) => {
      els.pairLink.value = text;
      open(text, true);
    }, pasteHere);
  });
}

const REPLACED_MESSAGE =
  'Remote control is now open on another device or tab. Reload or reopen Komla to use it here.';

/** A newer sign-in, on this device or another, now has the session. */
function showReplaced(els: UI): void {
  setStatus(els.status, 'idle', 'Open elsewhere');
  showError(els, REPLACED_MESSAGE);
}

function socketUrlForFingerprint(fingerprint: string): string {
  const direct = readDirectRemoteConfig();
  if (!direct || direct.fingerprint !== fingerprint) {
    throw new Error('This page was not served by the Komla desktop in the enrollment URL.');
  }
  return direct.wsUrl;
}

function handleSocketMessage(
  evt: MessageEvent,
  ws: WebSocket,
  peer: Peer,
  onInbound?: () => void
): void {
  onInbound?.();
  if (evt.data instanceof ArrayBuffer) {
    peer.handleBinaryMessage(new Uint8Array(evt.data));
    return;
  }
  const text = typeof evt.data === 'string' ? evt.data : '';
  const heartbeat = classifyRelayFrame(text);
  if (heartbeat === 'ping') {
    ws.send(RELAY_PONG_FRAME);
    return;
  }
  if (heartbeat === 'pong') return;
  peer.handleMessage(text);
}

let advanceCanvas: CanvasRenderingContext2D | null | undefined;

/** How far one character of a monospace font moves the pen, at the given computed style. */
function monospaceAdvance(style: CSSStyleDeclaration): number {
  advanceCanvas ??= document.createElement('canvas').getContext('2d');
  if (!advanceCanvas) return 0;
  advanceCanvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return advanceCanvas.measureText('M').width;
}

/** The text position under a point, in the browser's own terms. */
function caretAtPoint(clientX: number, clientY: number): { node: Node; offset: number } | null {
  if (typeof document.caretPositionFromPoint === 'function') {
    const position = document.caretPositionFromPoint(clientX, clientY);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  const range = document.caretRangeFromPoint?.(clientX, clientY);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

class RemoteAppClient {
  private readonly els = remoteUi();
  private readonly term = new Terminal({
    cursorBlink: true,
    convertEol: false,
    scrollOnUserInput: false,
    fontFamily:
      "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, 'Roboto Mono', 'DejaVu Sans Mono', Consolas, monospace",
    fontSize: window.matchMedia(PHONE_LAYOUT_QUERY).matches
      ? PHONE_TERMINAL_FONT_SIZE
      : TERMINAL_FONT_SIZE,
    // Komla's default terminal colors (src/shared/constants/terminal.ts), so the phone shows what
    // the desktop shows, on a near-black background that runs into the screen's own chrome.
    theme: {
      background: '#0a0c0f',
      foreground: '#ffffff',
      cursor: '#ffffff',
      cursorAccent: '#0a0c0f',
      selectionBackground: '#5a7898',
      selectionForeground: '#ffffff',
      black: '#1d1f21',
      red: '#cc6666',
      green: '#b5bd68',
      yellow: '#f0c674',
      blue: '#81a2be',
      magenta: '#b294bb',
      cyan: '#8abeb7',
      white: '#c5c8c6',
      brightBlack: '#666666',
      brightRed: '#d54e53',
      brightGreen: '#b9ca4a',
      brightYellow: '#e7c547',
      brightBlue: '#7aa6da',
      brightMagenta: '#c397d8',
      brightCyan: '#70c0b1',
      brightWhite: '#eaeaea',
    },
  });
  private readonly fitAddon = new FitAddon();
  private readonly serializeAddon = new SerializeAddon();
  private readonly terminalScreens = new TerminalScreenCache();
  private readonly mouseEncoding: MouseEncodingTracker;
  // The screen shows a cached copy while its attach is under way.
  private paintedFromCache = false;
  // The page went hidden and let go of its terminal; it picks it up again once shown.
  private detachedWhileHidden = false;
  private readonly terminalMutations = new TerminalMutationQueue();
  private workspaces: RemoteWorkspaceSummary[] = [];
  private projects: RemoteProjectSummary[] = [];
  private presets: RemoteAgentPresetSummary[] = [];
  private environments: RemoteLaunchEnvironmentSummary[] = [];
  private launchOptionsLoaded = false;
  private actions: RemoteActionSummary[] = [];
  private defaultLaunchModeId: string | undefined;
  private launchPreferences: LaunchPreferences = readLaunchPreferences();
  private selectedWorkspaceId: string | null = null;
  private attachedTerminalId: string | null = null;
  private pendingAttachWorkspaceId: string | null = null;
  // The one attach this client still wants; replies to any other are stale.
  private pendingAttach: { requestId: string; terminalId: string } | null = null;
  // Typed while that attach is under way, behind a cached screen that already looks live; it
  // goes out once the terminal is attached.
  private heldInput: { terminalId: string; data: string } | null = null;
  /** Whether the desktop took the attached terminal's size back. */
  private readonly sizeOwner = new TerminalSizeOwner();
  // An attached terminal that just reported 'stopped'. A restart follows that
  // with a reset, and the desktop keeps the attachment across it.
  private stoppedTerminalId: string | null = null;
  private pendingCreateRequestId: string | null = null;
  private pendingCreateWorkspace: RemoteWorkspaceSummary | null = null;
  private pendingTerminalActionId: string | null = null;
  private readonly pendingWorkspaceMessages = new Map<string, string>();
  private readonly pendingRequestWorkspaces = new Map<string, string>();
  private readonly pendingRequestTimers = new Map<string, number>();
  private readonly resizeObserver: ResizeObserver | null = null;
  private lastSentTerminalSize: string | null = null;
  private readonly terminalStream = new TerminalStreamCursor();
  private readonly workspacePages = new WorkspacePages<RemoteWorkspaceSummary>();
  private pendingTerminalSnapshot: {
    requestId: string;
    workspaceId: string;
    terminalId: string;
    generation: number;
    seq: number;
    cols: number;
    rows: number;
    chunkCount: number;
    chunks: string[];
    resumed: boolean;
  } | null = null;
  private nextRequestId = 1;
  private workspaceRefreshTimer: number | null = null;
  private disconnected = false;
  private voiceAvailable = false;
  private voiceAvailabilityKnown = false;
  private voiceCapture: AudioCaptureHandle | null = null;
  private voiceLevelTimer: number | null = null;
  private voiceStarting = false;
  private voiceStatusTimer: number | null = null;
  private pendingVoiceRequestId: string | null = null;
  private pendingVoiceSubmit = false;
  private pendingWorkspaceVoiceAction: 'launch' | 'edit' | null = null;
  private workspaceVoiceEditsPrompt = false;
  private voiceTarget: 'terminal' | 'workspace' | null = null;
  private terminalKeysOpen = true;
  private ctrlLatched = false;
  private altLatched = false;
  private mobileTouchScrollDriving = false;
  private mobileTerminalTouch: {
    identifier: number;
    startX: number;
    startY: number;
    startScrollTop: number;
    maxMovement: number;
    // Where the last wheel input left off, while the drag goes to the program as wheel input.
    wheelY: number | null;
    // Recent positions, for the velocity a flick leaves with.
    samples: Array<{ y: number; time: number }>;
  } | null = null;
  private terminalLongPressTimer: number | null = null;
  // Select mode: the buffer frozen as plain text while the user selects in it.
  private terminalSelection: TerminalSelectionText | null = null;
  // The last thing selected, kept for Copy: a tap on the button may clear the selection first.
  private terminalSelectedText = '';
  private terminalSelectionEmptyTimer: number | null = null;
  // Set by a link's activation, so a tap knows it opened one.
  private terminalLinkOpened = false;
  // Scrolling the user started (a drag or its momentum) runs until then, and output doesn't move
  // the scroller under them meanwhile.
  private mobileUserScrollUntil = 0;
  private terminalFlingFrame: number | null = null;
  private scrollRailDrag: {
    pointerId: number;
    startY: number;
    grabOffset: number;
    // A fullscreen program's rail scrolls while pulled from its resting place, by this much.
    programScrolls: boolean;
    displacement: number;
    pendingSteps: number;
    lastFrameTime: number;
    frame: number | null;
  } | null = null;
  private noticeTimer: number | null = null;
  private workspaceQuery = '';
  private workspaceFilter: WorkspaceFilter = 'all';
  private pushConfig: RemotePushConfig | null = null;
  private pushRequestId: string | null = null;
  private pushNote = '';
  private pushRefreshed = false;
  /** What the user just asked for, shown until the desktop confirms or refuses it. */
  private pushPending: { subscribed: boolean; notifyWhen: RemotePushNotifyWhen } | null = null;
  private pendingOpen: OpenTarget | null = takeOpenTargetFromUrl();
  private preferredHostChecked = false;
  private readonly collapsedSections = readCollapsedSections();
  private readonly mobileWorkspaceQuery = window.matchMedia(PHONE_LAYOUT_QUERY);

  private peer: Peer;
  private ws: WebSocket;
  private watchdog: ConnectionWatchdog | null = null;
  private readonly reconnectLoop = new ReconnectLoop({
    attempt: (signal) => this.reconnectInPlace(signal),
    reload: () => location.reload(),
    delayMs: (attempt) => reconnectDelayMs(attempt),
    isVisible: () => document.visibilityState === 'visible',
    reloadAfterAttempts: RECONNECT_ATTEMPTS_BEFORE_RELOAD,
    onWaiting: (delayMs) =>
      this.showRemoteNotice(`Connection lost. Reconnecting in ${formatSeconds(delayMs)}…`, 0),
  });

  constructor(
    connection: LiveConnection,
    private readonly endpoint: AppEndpoint,
    private readonly target: SessionTarget
  ) {
    this.peer = connection.peer;
    this.ws = connection.ws;
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.serializeAddon);
    this.mouseEncoding = trackMouseEncoding(this.term);
    this.term.open(this.els.terminalHost);
    this.configureMobileTerminalInput();
    this.bindTerminalSizeClaim();
    this.bindTerminalLinks();
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => {
        this.fitAndSync();
        this.syncMobileTouchScroller();
      });
      this.resizeObserver.observe(this.els.terminalHost);
    }
    this.term.onData((data) => {
      this.sendTerminalInput(this.applyLatchedModifiers(data));
    });
    this.term.onScroll(() => {
      if (this.isTerminalAtBottom()) this.els.terminalJumpLatest.hidden = true;
      this.syncMobileTouchScroller();
    });
    this.els.terminalTouchScroll.addEventListener('scroll', () => this.handleMobileTouchScroll());
    this.bindMobileTerminalTouch();
    this.bindTerminalSelection();
    this.bindScrollRail();
    this.els.terminalJumpLatest.addEventListener('click', () => {
      this.term.scrollToBottom();
      this.syncMobileTouchScroller();
      this.els.terminalJumpLatest.hidden = true;
      if (!this.mobileWorkspaceQuery.matches) this.term.focus();
    });
    this.bindMobileKeyboardBar();
    this.bindVoiceControls();
    this.bindVisualViewport();
    this.els.openCreateWorkspace.addEventListener('click', () => this.openCreateDialog());
    this.els.voiceCreateWorkspace.addEventListener('click', () => void this.startWorkspaceVoice());
    this.els.workspaceVoiceLaunch.addEventListener('click', () =>
      this.stopAndUseWorkspaceVoice('launch')
    );
    this.els.workspaceVoiceEdit.addEventListener('click', () =>
      this.stopAndUseWorkspaceVoice('edit')
    );
    this.els.workspaceVoiceCancel.addEventListener('click', () => this.cancelVoiceRecording());
    this.els.cancelCreateWorkspace.addEventListener('click', () => this.els.createDialog.close());
    this.bindLaunchPickers();
    this.els.projectSelect.addEventListener('change', () => this.persistLaunchPreferences());
    this.els.presetSelect.addEventListener('change', () => {
      this.renderLaunchModes(true);
      this.persistLaunchPreferences();
    });
    this.els.launchModeSelect.addEventListener('change', () => this.persistLaunchPreferences());
    this.els.environmentSelect.addEventListener('change', () => this.persistLaunchPreferences());
    this.els.promptVoice.addEventListener('click', () => {
      if (
        this.isRecordingVoice &&
        this.voiceTarget === 'workspace' &&
        this.workspaceVoiceEditsPrompt
      ) {
        this.stopAndUseWorkspaceVoice('edit');
      } else {
        void this.startWorkspaceVoice(true);
      }
    });
    this.els.createWorkspace.addEventListener('click', () => this.createWorkspace());
    this.els.backToWorkspacesHeader.addEventListener('click', () => this.showWorkspaceList());
    this.els.workspaceActionsTrigger.addEventListener('click', () =>
      this.openWorkspaceActionsMenu()
    );
    this.els.workspaceActionsMenu.addEventListener('click', (event) => {
      if (event.target === this.els.workspaceActionsMenu) {
        this.closeWorkspaceActionsMenu();
        return;
      }
      const button = (event.target as Element).closest<HTMLButtonElement>('button');
      const action = button?.dataset.workspaceAction;
      if (!action) return;
      if (action === 'actions') {
        this.showWorkspaceActionsSubmenu();
        return;
      }
      if (action === 'back') {
        this.showWorkspaceActionsRoot();
        return;
      }
      this.closeWorkspaceActionsMenu();
      if (action === 'shell') this.createShellTerminal();
      if (action === 'agent') this.openTerminalLaunchDialog();
      if (action === 'close') this.closeCurrentTerminal();
      if (action.startsWith('agent:')) this.launchAgent(action.slice(6));
      if (action.startsWith('configured:')) this.launchConfiguredAction(action.slice(11));
    });
    this.els.workspaceActionsMenu.addEventListener('close', () => this.showWorkspaceActionsRoot());
    this.els.workspaceRowSheet.addEventListener('click', (event) => {
      if (event.target === this.els.workspaceRowSheet) this.els.workspaceRowSheet.close();
    });
    this.els.workspaceSearch.addEventListener('input', () => {
      this.workspaceQuery = this.els.workspaceSearch.value;
      this.renderWorkspaces();
    });
    this.els.endpointSwitch.addEventListener('click', () => this.openEndpointSheet());
    this.els.endpointSheet.addEventListener('click', (event) => {
      if (event.target === this.els.endpointSheet) this.els.endpointSheet.close();
    });
    this.els.openSettings.addEventListener('click', () => this.openSettings());
    this.els.settingsSheet.addEventListener('click', (event) => {
      if (event.target === this.els.settingsSheet) this.els.settingsSheet.close();
    });
    this.els.pushToggle.addEventListener('change', () => {
      if (this.els.pushToggle.checked) void this.enablePush();
      else void this.disablePush();
    });
    this.els.pushWhen.addEventListener('change', () => void this.updatePushWhen());
    this.els.pushTest.addEventListener('click', () =>
      this.sendPushFrame({ type: 'app:push:test' })
    );
    document.addEventListener('visibilitychange', () => {
      this.sendVisibility();
      this.followPageVisibility();
    });
    navigator.serviceWorker?.addEventListener('message', (event: MessageEvent) => {
      const target = parseOpenTarget(event.data);
      if (!target) return;
      if (this.endpoint.host) {
        // Notifications come from the desktop, about its workspaces.
        const url = new URL(endpointHref(location.href, null));
        url.searchParams.set('workspace', target.workspaceId);
        if (target.terminalId) url.searchParams.set('terminal', target.terminalId);
        location.assign(url.href);
        return;
      }
      this.pendingOpen = target;
      this.openPendingTarget();
    });
    this.els.workspaceFilters.addEventListener('click', (event) => {
      const filter = (event.target as Element).closest<HTMLButtonElement>('button')?.dataset
        .workspaceFilter as WorkspaceFilter | undefined;
      if (!filter) return;
      this.workspaceFilter = filter;
      this.renderWorkspaces();
    });
    this.els.cancelTerminalLaunch.addEventListener('click', () =>
      this.els.terminalLaunchDialog.close()
    );
    this.els.terminalAgentPreset.addEventListener('change', () =>
      this.renderTerminalAgentLaunchModes()
    );
    this.els.createTerminal.addEventListener('click', () => this.createTerminalFromDialog());
    this.els.terminalTabs.addEventListener('click', (event) => {
      const tab = (event.target as Element).closest<HTMLButtonElement>('button');
      if (!tab) return;
      if (tab.dataset.tabAction === 'new') {
        this.openWorkspaceActionsMenu();
        return;
      }
      if (tab.dataset.tabAction === 'close') {
        if (tab.dataset.terminalId) this.closeTerminal(tab.dataset.terminalId);
        return;
      }
      const terminalId = tab.dataset.terminalId;
      if (this.selectedWorkspaceId && terminalId && terminalId !== this.attachedTerminalId) {
        this.attachWorkspace(this.selectedWorkspaceId, terminalId);
      }
    });
    this.mobileWorkspaceQuery.addEventListener('change', () => {
      this.term.options.fontSize = this.mobileWorkspaceQuery.matches
        ? PHONE_TERMINAL_FONT_SIZE
        : TERMINAL_FONT_SIZE;
      this.renderWorkspaces();
      this.fitAfterLayout();
    });
    window.addEventListener('resize', () => {
      this.fitAndSync();
      this.updateMobileKeysFade();
    });
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      if (this.disconnected) this.reconnectLoop.wake();
      else this.watchdog?.probe();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', (event) => {
      // Restored from the back-forward cache: this page's socket is long gone.
      if (event.persisted) this.connectionLost();
    });
    this.bindConnection(connection);
  }

  /** The socket stopped answering without closing, as a sleeping or roaming phone's can. */
  connectionLost(): void {
    this.markDisconnected();
  }

  /** A frame arrived on `ws`: if it is this page's connection, the link is alive. */
  noteInbound(ws: WebSocket): void {
    if (ws === this.ws) this.watchdog?.noteInbound();
  }

  private bindConnection({ ws, peer }: LiveConnection): void {
    this.ws = ws;
    this.peer = peer;
    peer.onMessage((msg) => {
      if (peer !== this.peer || this.disconnected) return;
      if (msg.kind === 'binary') {
        const frame = decodeBinaryAppFrame(msg.data);
        if (frame?.type === 'app:terminal:data') this.handleTerminalData(frame);
        return;
      }
      const frame = parseRemoteAppFrame(msg.data);
      if (!frame) return;
      this.handleFrame(frame);
    });
    peer.onClose((evt) => {
      if (peer === this.peer) this.markDisconnected(evt.code === SESSION_CLOSE.REPLACED.code);
    });
    this.watchdog?.stop();
    this.watchdog = new ConnectionWatchdog({
      sendPing: () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(RELAY_PING_FRAME);
      },
      onDead: () => {
        if (peer !== this.peer) return;
        this.connectionLost();
        ws.close(1000, 'liveness-timeout');
      },
    });
  }

  /** One attempt to sign this page in again with its resume grant, without a reload. */
  private async reconnectInPlace(signal: AbortSignal): Promise<ReconnectOutcome> {
    const result = await resumeSession(this.target, !this.endpoint.host, signal, (ws) =>
      this.noteInbound(ws)
    );
    if (typeof result === 'string') return result;
    this.bindConnection(result);
    this.disconnected = false;
    this.els.connectionPill.classList.remove('offline');
    this.els.connectionLabel.textContent = 'Connected';
    this.els.remoteNotice.hidden = true;
    resetPageReconnectAttempts();
    this.bootstrap();
    this.resumeTerminal();
    return 'connected';
  }

  start(label: string): void {
    this.els.pairCard.hidden = true;
    this.els.shell.hidden = false;
    document.body.classList.add('remote-active');
    document.title = `Remote control - ${label}`;
    resetPageReconnectAttempts();
    this.showWorkspaceList();
    this.renderEndpoint();
    this.els.settingsDeviceLabel.textContent = label;
    this.bootstrap();
    this.fitAfterLayout();
  }

  /** What a new connection asks for first. */
  private bootstrap(): void {
    if (!this.endpoint.host) {
      this.sendRemoteFrame({ type: 'app:hosts:list', requestId: this.requestId() });
    }
    this.getLaunchOptions();
    this.listWorkspaces();
    this.queryVoiceAvailability();
    this.sendVisibility();
    this.sendPushFrame({ type: 'app:push:config:get' });
  }

  /**
   * After a reconnect, picks the open terminal back up. The screen stays, and
   * the desktop sends only the output after what it shows, if it still has it.
   */
  private resumeTerminal(): void {
    const workspaceId = this.selectedWorkspaceId;
    // An attach the connection dropped mid-way is picked up too.
    const terminalId = this.attachedTerminalId ?? this.pendingAttach?.terminalId;
    // The workspace list attaches a selected workspace that had no terminal yet.
    if (!workspaceId || !terminalId) return;
    if (document.visibilityState === 'hidden') {
      // Reconnected while hidden: holding the terminal's size can wait until the page shows.
      this.detachedWhileHidden = true;
      return;
    }
    this.detachedWhileHidden = false;
    const resume = this.terminalStream.resumePoint();
    this.attachedTerminalId = null;
    if (!resume) {
      this.attachWorkspace(workspaceId, terminalId);
      return;
    }
    this.pendingAttachWorkspaceId = workspaceId;
    const requestId = this.requestId();
    this.pendingAttach = { requestId, terminalId };
    this.trackPendingRequest(requestId, workspaceId, 'Attach timed out. Tap to retry.');
    this.sizeOwner.forget();
    const dimensions = this.fitAndSync();
    this.sendRemoteFrame(
      {
        type: 'app:terminal:attach',
        requestId,
        workspaceId,
        terminalId,
        ...(dimensions ? { cols: dimensions.cols, rows: dimensions.rows } : {}),
        resume,
      },
      { requestId, workspaceId }
    );
  }

  private queryVoiceAvailability(): void {
    // getUserMedia needs a secure context (HTTPS, or localhost). Without one
    // the mic button would be dead, so never offer it.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.voiceAvailabilityKnown = true;
      this.voiceAvailable = false;
      this.updateVoiceUi();
      this.updateWorkspaceVoiceUi();
      return;
    }
    this.sendRemoteFrame({
      type: 'app:voice:status',
      requestId: this.requestId(),
    });
  }

  private requestId(): string {
    return `web-${this.nextRequestId++}`;
  }

  private hosts(): HostEndpoint[] {
    return rememberedHosts(localStorage, this.endpoint.desktopFingerprint);
  }

  private renderEndpoint(): void {
    this.els.endpointName.textContent = this.endpoint.host?.name ?? 'Komla';
    this.els.endpointSwitch.disabled = this.hosts().length === 0;
  }

  /** The desktop offers no local environment once "Allow access to this computer" is off. */
  private desktopWithheld(): boolean {
    return (
      !this.endpoint.host &&
      this.launchOptionsLoaded &&
      !this.environments.some((environment) => environment.kind === 'local')
    );
  }

  /** Until the desktop is picked, a host is where the app opens, as soon as one is reachable. */
  /**
   * Until the phone picks where to open, a launch opens the first host. Only at the first host
   * list of a page load, so a later change doesn't pull the phone off this computer's list, and
   * never past a notification's workspace link.
   */
  private openPreferredHost(): void {
    if (this.preferredHostChecked) return;
    this.preferredHostChecked = true;
    if (hasLastEndpoint(localStorage) || this.selectedWorkspaceId || this.pendingOpen) return;
    const hostId = startingHostId(localStorage, this.endpoint.desktopFingerprint);
    if (hostId) location.assign(endpointHref(location.href, hostId));
  }

  private openEndpointSheet(): void {
    const item = (label: string, hostId: string | null) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = label;
      const current = (this.endpoint.host?.id ?? null) === hostId;
      if (current) button.setAttribute('aria-current', 'true');
      button.addEventListener('click', () => {
        this.els.endpointSheet.close();
        if (current) return;
        rememberLastEndpoint(localStorage, hostId);
        location.assign(endpointHref(location.href, hostId));
      });
      return button;
    };
    this.els.endpointList.replaceChildren(
      ...this.hosts().map((host) => item(host.name, host.id)),
      item('This computer', null)
    );
    if (!this.els.endpointSheet.open) this.els.endpointSheet.showModal();
  }

  private listWorkspaces(): void {
    this.sendRemoteFrame({
      type: 'app:workspaces:list',
      requestId: this.requestId(),
    });
  }

  private getLaunchOptions(): void {
    this.sendRemoteFrame({
      type: 'app:launch-options:get',
      requestId: this.requestId(),
    });
  }

  private createWorkspace(promptOverride?: string): void {
    if (!this.ensureConnected()) return;
    this.renderLaunchOptions();
    const projectId = this.els.projectSelect.value;
    if (!projectId) {
      return;
    }
    const initialPrompt = (promptOverride ?? this.els.initialPrompt.value.trim()) || undefined;
    this.els.createWorkspaceError.hidden = true;
    const selectedEnvironment = parseEnvironmentValue(this.els.environmentSelect.value);
    this.setCreateWorkspacePending(true);
    const requestId = this.requestId();
    const project = this.projects.find((candidate) => candidate.id === projectId);
    this.pendingCreateRequestId = requestId;
    this.pendingCreateWorkspace = {
      id: `pending-${requestId}`,
      name: 'New workspace',
      workingDirectory: '',
      projectId,
      ...(project?.name ? { projectName: project.name } : {}),
      ...(project?.color ? { projectColor: project.color } : {}),
      status: 'active',
      provisioning: true,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      terminals: [],
    };
    this.renderWorkspaces();
    this.trackPendingRequest(requestId, this.pendingCreateWorkspace.id, 'Launch timed out.');
    this.sendRemoteFrame(
      {
        type: 'app:workspace:create',
        requestId,
        projectId,
        presetId: this.els.presetSelect.value || undefined,
        launchModeId: this.els.launchModeSelect.value || undefined,
        initialPrompt,
        environment: selectedEnvironment,
      },
      {
        requestId,
      }
    );
  }

  private handleFrame(frame: RemoteAppFrame): void {
    if (this.disconnected) return;
    switch (frame.type) {
      case 'app:hosts':
        if (!this.endpoint.host) {
          rememberHosts(localStorage, this.endpoint.desktopFingerprint, frame.hosts);
          this.renderEndpoint();
          this.openPreferredHost();
        }
        return;
      case 'app:workspaces': {
        const workspaces = this.workspacePages.add(frame);
        if (!workspaces) return;
        this.workspaces = this.withPendingCreate(workspaces);
        if (
          this.selectedWorkspaceId &&
          !this.workspaces.some((workspace) => workspace.id === this.selectedWorkspaceId)
        ) {
          // Gone, or no longer shared with devices: back to the list, not a frozen screen.
          this.showWorkspaceList();
        }
        this.renderWorkspaces();
        this.renderTerminalToolbar();
        if (this.pendingOpen) {
          this.openPendingTarget();
          return;
        }
        if (this.selectedWorkspaceId && !this.attachedTerminalId) {
          const selected = this.workspaces.find(
            (workspace) => workspace.id === this.selectedWorkspaceId
          );
          if (
            selected &&
            this.terminalIdForWorkspace(selected) &&
            this.pendingAttachWorkspaceId !== selected.id
          ) {
            this.attachWorkspace(selected.id);
          } else if (selected?.provisioning || selected?.terminals.length === 0) {
            this.waitForWorkspace(selected.id);
          }
        }
        return;
      }
      case 'app:launch-options':
        this.projects = frame.projects;
        this.presets = frame.presets;
        this.defaultLaunchModeId = frame.defaultLaunchModeId;
        this.environments = frame.environments ?? [{ kind: 'local', name: 'This computer' }];
        this.launchOptionsLoaded = true;
        // Nowhere to create one: this computer isn't shared and it knows no SSH host, or this
        // host has no project Komla set up here.
        this.els.openCreateWorkspace.hidden = this.environments.length === 0;
        this.renderWorkspaces();
        this.actions = frame.actions ?? [];
        this.renderLaunchOptions();
        this.renderWorkspaceActions();
        this.renderNewTabAgents();
        return;
      case 'app:workspace:created':
        this.setCreateWorkspacePending(false);
        this.clearPendingRequest(frame.requestId);
        this.pendingCreateRequestId = null;
        this.pendingCreateWorkspace = null;
        this.els.initialPrompt.value = '';
        this.els.createDialog.close();
        this.workspaces = sortWorkspaces([
          frame.workspace,
          ...this.workspaces.filter((w) => w.id !== frame.workspace.id),
        ]);
        this.renderWorkspaces();
        return;
      case 'app:workspace:started':
        this.clearPendingRequest(frame.requestId);
        this.workspaces = sortWorkspaces([
          frame.workspace,
          ...this.workspaces.filter((w) => w.id !== frame.workspace.id),
        ]);
        this.renderWorkspaces();
        this.renderTerminalToolbar();
        if (this.selectedWorkspaceId === frame.workspace.id) {
          this.attachOrWaitForWorkspace(frame.workspace.id);
        }
        return;
      case 'app:workspace:stopped':
        this.clearPendingRequest(frame.requestId);
        if (this.selectedWorkspaceId === frame.workspace.id) {
          this.selectedWorkspaceId = null;
          this.pendingAttachWorkspaceId = null;
          this.attachedTerminalId = null;
          this.clearTerminalLoading();
          this.showWorkspaceList();
        }
        this.workspaces = sortWorkspaces([
          frame.workspace,
          ...this.workspaces.filter((w) => w.id !== frame.workspace.id),
        ]);
        this.renderWorkspaces();
        this.renderTerminalToolbar();
        return;
      case 'app:workspace:title:regenerated':
        this.clearPendingRequest(frame.requestId);
        this.workspaces = sortWorkspaces([
          frame.workspace,
          ...this.workspaces.filter((w) => w.id !== frame.workspace.id),
        ]);
        this.renderWorkspaces();
        return;
      case 'app:terminal:attached':
        if (
          frame.requestId !== this.pendingAttach?.requestId ||
          frame.snapshot.workspaceId !== this.selectedWorkspaceId ||
          frame.snapshot.workspaceId !== this.pendingAttachWorkspaceId
        ) {
          return;
        }
        if (frame.resumed) {
          // The screen stays; a resize follows if the phone's fitted size differs.
          this.lastSentTerminalSize = this.sizeKey(frame.snapshot);
          this.enqueueTerminalAction(() => {
            this.term.resize(frame.snapshot.cols, frame.snapshot.rows);
          });
        }
        // A snapshot replaces the screen once all of it is in, so a cached or stale screen stays
        // up meanwhile.
        this.pendingTerminalSnapshot = {
          requestId: frame.requestId,
          ...frame.snapshot,
          chunks: [],
          resumed: frame.resumed === true,
        };
        if (frame.snapshot.chunkCount === 0) {
          this.finishTerminalSnapshot();
          return;
        }
        if (!this.paintedFromCache) this.setTerminalLoading('Restoring terminal...');
        return;
      case 'app:terminal:created':
        this.workspaces = sortWorkspaces([
          frame.workspace,
          ...this.workspaces.filter((workspace) => workspace.id !== frame.workspace.id),
        ]);
        this.renderWorkspaces();
        this.attachWorkspace(frame.workspace.id, frame.terminalId);
        return;
      case 'app:terminal:closed': {
        this.workspaces = sortWorkspaces([
          frame.workspace,
          ...this.workspaces.filter((workspace) => workspace.id !== frame.workspace.id),
        ]);
        this.terminalScreens.delete(frame.terminalId);
        if (this.attachedTerminalId === frame.terminalId) {
          this.attachedTerminalId = null;
          this.pendingAttachWorkspaceId = null;
          const nextTerminal = this.terminalIdForWorkspace(frame.workspace);
          if (nextTerminal) this.attachWorkspace(frame.workspace.id, nextTerminal);
          else this.showWorkspaceList();
        }
        this.renderWorkspaces();
        this.renderTerminalToolbar();
        return;
      }
      case 'app:terminal:snapshot-chunk': {
        const pending = this.pendingTerminalSnapshot;
        if (
          !pending ||
          frame.requestId !== pending.requestId ||
          frame.terminalId !== pending.terminalId ||
          frame.generation !== pending.generation ||
          frame.index !== pending.chunks.length
        ) {
          return;
        }
        pending.chunks.push(frame.data);
        if (pending.chunks.length === pending.chunkCount) this.finishTerminalSnapshot();
        return;
      }
      case 'app:terminal:data':
        this.handleTerminalData(frame);
        return;
      case 'app:terminal:reset':
        if (frame.terminalId !== this.attachedTerminalId) {
          if (frame.terminalId !== this.stoppedTerminalId) return;
          this.attachedTerminalId = frame.terminalId;
          this.renderTerminalToolbar();
          this.updateVoiceUi();
        }
        this.stoppedTerminalId = null;
        this.pendingTerminalSnapshot = null;
        this.terminalStream.reset(frame.generation, frame.seq);
        this.enqueueTerminalAction(() => {
          this.resetTerminal();
          this.term.resize(frame.cols, frame.rows);
          this.els.terminalJumpLatest.hidden = true;
        });
        return;
      case 'app:terminal:size':
        this.followTerminalSize(frame);
        return;
      case 'app:terminal:status':
        this.updateTerminalStatus(frame.workspaceId, frame.terminalId, frame.status);
        return;
      case 'app:voice:availability':
        this.voiceAvailabilityKnown = true;
        this.voiceAvailable = frame.available;
        this.updateVoiceUi();
        this.updateWorkspaceVoiceUi();
        // The bar appearing/disappearing changes the terminal's height.
        if (this.attachedTerminalId) this.fitAndSync();
        return;
      case 'app:voice:transcribed':
        this.handleVoiceTranscript(frame.requestId, frame.text);
        return;
      case 'app:push:config':
        if (frame.requestId === this.pushRequestId) {
          this.pushRequestId = null;
          this.pushPending = null;
        }
        this.pushConfig = frame;
        this.renderPushSettings();
        void this.refreshBrowserSubscription();
        return;
      case 'app:push:tested':
        if (frame.requestId === this.pushRequestId) this.pushRequestId = null;
        this.pushNote = pushTestNote(frame.outcome);
        this.renderPushSettings();
        return;
      case 'app:error': {
        if (frame.requestId && frame.requestId === this.pushRequestId) {
          this.pushRequestId = null;
          this.pushPending = null;
          this.pushNote = frame.message;
          this.renderPushSettings();
        }
        this.setCreateWorkspacePending(false);
        // Desktop errors can lead with a code, as in "WORKSPACE_LIMIT:Free plan is…".
        const message = frame.message.replace(/^[A-Z_]+:/, '');
        let shownInSheet = false;
        if (frame.requestId === this.pendingCreateRequestId) {
          this.pendingCreateRequestId = null;
          this.pendingCreateWorkspace = null;
          shownInSheet = this.els.createDialog.open;
          this.els.createWorkspaceError.textContent = message;
          this.els.createWorkspaceError.hidden = false;
        }
        if (frame.requestId && frame.requestId === this.pendingVoiceRequestId) {
          this.pendingVoiceRequestId = null;
          this.pendingVoiceSubmit = false;
          this.pendingWorkspaceVoiceAction = null;
          this.setVoiceStatus('Dictation failed', 2500);
          this.setWorkspaceVoiceStatus('Dictation failed');
          this.updateVoiceUi();
          this.updateWorkspaceVoiceUi();
        }
        this.clearPendingRequest(frame.requestId);
        this.pendingAttachWorkspaceId = null;
        this.clearTerminalLoading();
        this.renderWorkspaces();
        this.renderTerminalToolbar();
        if (!shownInSheet) this.showRemoteNotice(message);
        console.warn(frame.message);
        return;
      }
      default:
        return;
    }
  }

  /** Output for the attached terminal, from a JSON or a binary frame. */
  private handleTerminalData(frame: {
    terminalId: string;
    generation: number;
    seq: number;
    data: string;
    more?: true;
  }): void {
    if (frame.terminalId === this.attachedTerminalId && this.terminalStream.accept(frame)) {
      this.writeTerminalOutput(frame.data);
    }
  }

  private finishTerminalSnapshot(): void {
    const pending = this.pendingTerminalSnapshot;
    if (!pending) return;
    this.pendingTerminalSnapshot = null;
    this.pendingAttach = null;
    this.attachedTerminalId = pending.terminalId;
    this.pendingAttachWorkspaceId = null;
    this.pendingWorkspaceMessages.delete(pending.workspaceId);
    this.clearPendingRequest(pending.requestId);
    this.selectedWorkspaceId = pending.workspaceId;
    this.terminalStream.reset(pending.generation, pending.seq);
    this.clearTerminalLoading();
    this.renderWorkspaces();
    this.renderTerminalToolbar();
    this.updateVoiceUi();
    this.paintedFromCache = false;
    if (!pending.resumed) {
      this.enqueueTerminalAction(() => {
        this.resetTerminal();
        this.term.resize(pending.cols, pending.rows);
      });
    }
    this.enqueueTerminalWrite(pending.chunks.join(''), () => {
      this.fitAndSync();
      this.term.scrollToBottom();
      this.syncMobileTouchScroller();
      this.els.terminalJumpLatest.hidden = true;
      if (!this.mobileWorkspaceQuery.matches) this.term.focus();
    });
    const held = this.heldInput;
    this.heldInput = null;
    if (held?.terminalId === pending.terminalId) this.sendTerminalInput(held.data);
    // Hidden while the attach was under way: let go now that there is a terminal to let go of.
    if (document.visibilityState === 'hidden') this.followPageVisibility();
  }

  private writeTerminalOutput(data: string): void {
    const follow = this.isTerminalAtBottom();
    this.enqueueTerminalWrite(data, () => {
      if (follow) {
        this.term.scrollToBottom();
        this.els.terminalJumpLatest.hidden = true;
      } else {
        this.els.terminalJumpLatest.hidden = false;
      }
      this.syncMobileTouchScroller();
    });
  }

  private handleMobileTouchScroll(): void {
    if (!this.mobileWorkspaceQuery.matches) return;
    const rowHeight = this.mobileTerminalRowHeight();
    if (rowHeight <= 0) return;
    const now = performance.now();
    if (this.mobileTerminalTouch || now < this.mobileUserScrollUntil) {
      this.mobileUserScrollUntil = now + USER_SCROLL_SETTLE_MS;
    }
    this.mobileTouchScrollDriving = true;
    this.term.scrollToLine(Math.round(this.els.terminalTouchScroll.scrollTop / rowHeight));
    this.mobileTouchScrollDriving = false;
    this.els.terminalJumpLatest.hidden = this.isTerminalAtBottom();
  }

  private syncMobileTouchScroller(): void {
    if (!this.mobileWorkspaceQuery.matches) return;
    const rowHeight = this.mobileTerminalRowHeight();
    if (rowHeight <= 0) return;
    const buffer = this.term.buffer.active;
    const totalRows = buffer.baseY + this.term.rows;
    this.els.terminalTouchScrollSpacer.style.height = `${Math.max(
      this.els.terminalTouchScroll.clientHeight + 1,
      totalRows * rowHeight
    )}px`;
    // Snapping the scroller to a row while a finger or its momentum moves it would fight it.
    const userScrolling =
      this.mobileTerminalTouch !== null || performance.now() < this.mobileUserScrollUntil;
    if (!this.mobileTouchScrollDriving && !userScrolling) {
      this.els.terminalTouchScroll.scrollTop = buffer.viewportY * rowHeight;
    }
    const rail = this.els.terminalScrollIndicator;
    const programScrolls = this.terminalProgramScrolls();
    const maxViewportY = buffer.baseY;
    if (!programScrolls && maxViewportY <= 0) {
      rail.hidden = true;
      return;
    }
    rail.hidden = false;
    rail.classList.toggle('program-scrolls', programScrolls);
    const trackHeight = rail.clientHeight;
    let thumbHeight: number;
    let thumbTop: number;
    if (programScrolls) {
      const drag = this.scrollRailDrag;
      thumbHeight = Math.min(RAIL_HANDLE_PX, trackHeight);
      thumbTop = (trackHeight - thumbHeight) / 2 + (drag?.programScrolls ? drag.displacement : 0);
    } else {
      thumbHeight = Math.max(MIN_SCROLL_THUMB_PX, (this.term.rows / totalRows) * trackHeight);
      thumbTop = (buffer.viewportY / maxViewportY) * Math.max(0, trackHeight - thumbHeight);
    }
    this.els.terminalScrollThumb.style.height = `${thumbHeight}px`;
    this.els.terminalScrollThumb.style.transform = `translateY(${thumbTop}px)`;
  }

  private mobileTerminalRowHeight(): number {
    if (this.term.rows <= 0) return 0;
    return this.els.terminalTouchScroll.clientHeight / this.term.rows;
  }

  private enqueueTerminalAction(action: () => void): void {
    this.terminalMutations.enqueue((done) => {
      action();
      done();
    });
  }

  private enqueueTerminalWrite(data: string, callback?: () => void): void {
    this.terminalMutations.enqueue((done) => {
      this.term.write(data, () => {
        callback?.();
        done();
      });
    });
  }

  private enqueueTerminalLine(data: string): void {
    this.terminalMutations.enqueue((done) => this.term.writeln(data, done));
  }

  private isTerminalAtBottom(): boolean {
    const buffer = this.term.buffer.active;
    return isTerminalViewportAtBottom(buffer.viewportY, buffer.baseY);
  }

  private showRemoteNotice(message: string, timeoutMs = 5000): void {
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.els.remoteNotice.textContent = message;
    this.els.remoteNotice.hidden = false;
    this.noticeTimer =
      timeoutMs > 0
        ? window.setTimeout(() => {
            this.els.remoteNotice.hidden = true;
            this.noticeTimer = null;
          }, timeoutMs)
        : null;
  }

  private openWorkspace(workspaceId: string): void {
    if (!this.ensureConnected()) return;
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    this.clearWorkspaceAttentionLocal(workspaceId);
    this.showTerminal();
    if (this.selectedWorkspaceId === workspaceId && this.attachedTerminalId) {
      if (!this.mobileWorkspaceQuery.matches) this.term.focus();
      return;
    }
    if (this.pendingAttachWorkspaceId === workspaceId) {
      return;
    }
    if (workspace.provisioning) {
      this.waitForWorkspace(workspaceId);
      return;
    }
    if (this.terminalIdForWorkspace(workspace)) {
      this.attachWorkspace(workspaceId);
      return;
    }
    this.startWorkspace(workspaceId);
  }

  private attachOrWaitForWorkspace(workspaceId: string): void {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    if (this.terminalIdForWorkspace(workspace)) {
      this.attachWorkspace(workspaceId);
    } else {
      this.waitForWorkspace(workspaceId);
    }
  }

  private startWorkspace(workspaceId: string): void {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    this.selectedWorkspaceId = workspaceId;
    this.attachedTerminalId = null;
    this.lastSentTerminalSize = null;
    this.pendingAttachWorkspaceId = null;
    this.prepareTerminalTransition('Starting workspace...');
    this.renderWorkspaces();
    this.renderTerminalToolbar();
    const requestId = this.requestId();
    this.trackPendingRequest(requestId, workspaceId, 'Start timed out. Tap to retry.');
    this.sendRemoteFrame(
      {
        type: 'app:workspace:start',
        requestId,
        workspaceId,
      },
      { requestId, workspaceId }
    );
  }

  private restartWorkspace(workspaceId: string): void {
    if (!this.ensureConnected()) return;
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace || workspace.provisioning) return;
    this.selectedWorkspaceId = workspaceId;
    this.attachedTerminalId = null;
    this.lastSentTerminalSize = null;
    this.pendingAttachWorkspaceId = null;
    this.prepareTerminalTransition('Restarting workspace...');
    this.showTerminal();
    this.renderWorkspaces();
    this.renderTerminalToolbar();
    const requestId = this.requestId();
    this.trackPendingRequest(requestId, workspaceId, 'Restart timed out. Tap to retry.');
    this.sendRemoteFrame(
      {
        type: 'app:workspace:start',
        requestId,
        workspaceId,
      },
      { requestId, workspaceId }
    );
  }

  private stopWorkspace(workspaceId: string): void {
    if (!this.ensureConnected()) return;
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace || workspace.provisioning || !this.terminalIdForWorkspace(workspace)) return;
    if (this.selectedWorkspaceId === workspaceId) {
      this.pendingAttachWorkspaceId = null;
      this.clearTerminalLoading();
      this.showWorkspaceList();
    }
    this.pendingWorkspaceMessages.set(workspaceId, 'Stopping workspace...');
    this.renderWorkspaces();
    const requestId = this.requestId();
    this.trackPendingRequest(requestId, workspaceId, 'Stop timed out. Try again.');
    this.sendRemoteFrame(
      {
        type: 'app:workspace:stop',
        requestId,
        workspaceId,
      },
      { requestId, workspaceId }
    );
  }

  private openWorkspaceActionsMenu(): void {
    if (!this.selectedWorkspaceId || this.els.workspaceActionsMenu.open) return;
    if (this.presets.length === 0) this.getLaunchOptions();
    this.renderNewTabAgents();
    this.showWorkspaceActionsRoot();
    this.els.workspaceActionsMenu.showModal();
  }

  private closeWorkspaceActionsMenu(): void {
    if (this.els.workspaceActionsMenu.open) this.els.workspaceActionsMenu.close();
    this.showWorkspaceActionsRoot();
  }

  private showWorkspaceActionsRoot(): void {
    this.els.workspaceActionsRoot.hidden = false;
    this.els.workspaceActionsSubmenu.hidden = true;
  }

  private showWorkspaceActionsSubmenu(): void {
    if (this.els.workspaceActionsOpen.disabled) return;
    this.els.workspaceActionsRoot.hidden = true;
    this.els.workspaceActionsSubmenu.hidden = false;
    this.els.workspaceActionsSubmenu.querySelector<HTMLButtonElement>('button')?.focus();
  }

  private renderWorkspaceActions(): void {
    const workspace = this.selectedWorkspaceId
      ? this.workspaces.find((candidate) => candidate.id === this.selectedWorkspaceId)
      : undefined;
    const actions = workspace
      ? this.actions.filter(
          (action) =>
            !action.projectIds?.length ||
            (workspace.projectId !== null &&
              workspace.projectId !== undefined &&
              action.projectIds.includes(workspace.projectId))
        )
      : [];
    const renderActionGroup = (label: string, groupedActions: RemoteActionSummary[]) => {
      const group = document.createElement('div');
      group.className = 'workspace-action-group';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      const heading = document.createElement('div');
      heading.className = 'workspace-action-group-label';
      heading.textContent = label;
      const buttons = groupedActions.map((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.dataset.workspaceAction = `configured:${action.id}`;
        button.textContent = action.title;
        return button;
      });
      group.append(heading, ...buttons);
      return group;
    };
    const groups = [
      { label: 'Saved prompts', actions: actions.filter((action) => action.type === 'prompt') },
      { label: 'Terminal commands', actions: actions.filter((action) => action.type === 'command') },
    ].filter((group) => group.actions.length > 0);
    this.els.workspaceActionItems.replaceChildren(
      ...groups.map((group) => renderActionGroup(group.label, group.actions))
    );
    this.els.workspaceActionsOpen.disabled = actions.length === 0;
    this.els.workspaceActionsOpen.title = actions.length ? '' : 'No quick commands configured';
  }

  private createShellTerminal(): void {
    this.sendCreateTerminal({ kind: 'shell' });
  }

  /** One row per agent preset in the New tab sheet; a tap launches it in its preferred mode. */
  private renderNewTabAgents(): void {
    if (this.presets.length === 0) {
      const loading = document.createElement('button');
      loading.type = 'button';
      loading.disabled = true;
      loading.setAttribute('role', 'menuitem');
      loading.innerHTML = `${agentIconSvg('')}<span>Loading agents…</span>`;
      this.els.newTabAgents.replaceChildren(loading);
      return;
    }
    this.els.newTabAgents.replaceChildren(
      ...this.presets.map((preset) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.dataset.workspaceAction = `agent:${preset.id}`;
        const modeId = this.resolvePreferredLaunchModeId(preset);
        const mode = preset.launchModes.find((candidate) => candidate.id === modeId);
        button.innerHTML = `${agentIconSvg(preset.name)}<span class="sheet-row-text"><span></span>${
          mode ? '<small></small>' : ''
        }</span>`;
        button.querySelector('.sheet-row-text > span')!.textContent = preset.name;
        if (mode) button.querySelector('small')!.textContent = mode.name;
        return button;
      })
    );
  }

  private launchAgent(presetId: string): void {
    const preset = this.presets.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    this.sendCreateTerminal({
      kind: 'agent',
      presetId,
      launchModeId: this.resolvePreferredLaunchModeId(preset) ?? undefined,
    });
  }

  private openTerminalLaunchDialog(actionId?: string): void {
    this.pendingTerminalActionId = actionId ?? null;
    const action = actionId
      ? this.actions.find((candidate) => candidate.id === actionId)
      : undefined;
    const isAction = Boolean(action);
    this.els.terminalLaunchTitle.textContent = action?.title ?? 'New agent';
    this.els.terminalLaunchDescription.textContent = action
      ? 'Run this quick command in a new terminal.'
      : 'Launch another agent in this workspace.';
    this.els.terminalAgentPresetField.hidden = isAction;
    this.els.terminalAgentLaunchModeField.hidden = isAction;
    this.els.terminalLaunchInputField.hidden = Boolean(action && !action.requiresInput);
    this.els.terminalLaunchInputLabel.textContent = action ? 'Quick command input' : 'Prompt (optional)';
    this.els.terminalLaunchInput.placeholder = action
      ? 'Add the details this quick command needs'
      : 'Describe what the agent should do';
    this.els.terminalLaunchInput.value = '';
    this.els.createTerminal.textContent = action ? 'Run quick command' : 'Launch agent';
    if (!action) {
      const selectedPresetId =
        this.validPresetId(this.launchPreferences.presetId) ?? this.presets[0]?.id ?? '';
      this.els.terminalAgentPreset.replaceChildren(
        ...this.presets.map((preset) => option(preset.id, preset.name, selectedPresetId))
      );
      this.renderTerminalAgentLaunchModes();
    }
    this.els.terminalLaunchDialog.showModal();
    if (action?.requiresInput) this.els.terminalLaunchInput.focus();
  }

  private renderTerminalAgentLaunchModes(): void {
    const preset = this.presets.find(
      (candidate) => candidate.id === this.els.terminalAgentPreset.value
    );
    const selectedModeId = this.resolvePreferredLaunchModeId(preset) ?? '';
    this.els.terminalAgentLaunchMode.replaceChildren(
      option('', 'Default', selectedModeId),
      ...(preset?.launchModes.map((mode, index) =>
        option(mode.id, mode.name, selectedModeId, launchModeColor(mode.color, index))
      ) ?? [])
    );
  }

  private launchConfiguredAction(actionId: string): void {
    const action = this.actions.find((candidate) => candidate.id === actionId);
    if (!action) return;
    if (action.requiresInput) {
      this.openTerminalLaunchDialog(action.id);
      return;
    }
    this.sendCreateTerminal({ kind: 'action', actionId: action.id });
  }

  private createTerminalFromDialog(): void {
    if (this.pendingTerminalActionId) {
      this.sendCreateTerminal({
        kind: 'action',
        actionId: this.pendingTerminalActionId,
        userInput: this.els.terminalLaunchInput.value.trim() || undefined,
      });
    } else {
      const presetId = this.els.terminalAgentPreset.value;
      if (!presetId) return;
      this.sendCreateTerminal({
        kind: 'agent',
        presetId,
        launchModeId: this.els.terminalAgentLaunchMode.value || undefined,
        prompt: this.els.terminalLaunchInput.value.trim() || undefined,
      });
    }
    this.els.terminalLaunchDialog.close();
  }

  private sendCreateTerminal(
    source: Extract<RemoteAppFrame, { type: 'app:terminal:create' }>['source']
  ): void {
    if (!this.ensureConnected() || !this.selectedWorkspaceId) return;
    this.sendRemoteFrame({
      type: 'app:terminal:create',
      requestId: this.requestId(),
      workspaceId: this.selectedWorkspaceId,
      source,
    });
  }

  private closeCurrentTerminal(): void {
    if (this.attachedTerminalId) this.closeTerminal(this.attachedTerminalId);
  }

  /** Closes a tab at once, unless an agent is still working in it. */
  private closeTerminal(terminalId: string): void {
    if (!this.ensureConnected() || !this.selectedWorkspaceId) return;
    const workspaceId = this.selectedWorkspaceId;
    const terminal = this.workspaces
      .find((workspace) => workspace.id === workspaceId)
      ?.terminals.find((candidate) => candidate.id === terminalId);
    if (
      terminal?.agentActive &&
      !window.confirm('An agent is still working in this tab. Close it and stop the agent?')
    ) {
      return;
    }
    this.sendRemoteFrame({
      type: 'app:terminal:close',
      requestId: this.requestId(),
      workspaceId,
      terminalId,
    });
  }

  private regenerateWorkspaceTitle(workspaceId: string): void {
    if (!this.ensureConnected()) return;
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace || workspace.provisioning) return;
    this.pendingWorkspaceMessages.set(workspaceId, 'Regenerating title...');
    this.renderWorkspaces();
    const requestId = this.requestId();
    this.trackPendingRequest(requestId, workspaceId, 'Title regenerate timed out. Try again.');
    this.sendRemoteFrame(
      {
        type: 'app:workspace:title:regenerate',
        requestId,
        workspaceId,
      },
      { requestId, workspaceId }
    );
  }

  private attachWorkspace(workspaceId: string, requestedTerminalId?: string): void {
    this.exitTerminalSelection();
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace || workspace.provisioning) return;
    const terminalId = requestedTerminalId ?? this.terminalIdForWorkspace(workspace);
    if (!terminalId) {
      this.waitForWorkspace(workspaceId);
      return;
    }
    if (
      this.selectedWorkspaceId === workspaceId &&
      this.attachedTerminalId === terminalId &&
      this.pendingAttachWorkspaceId === null
    ) {
      this.showTerminal();
      if (!this.mobileWorkspaceQuery.matches) this.term.focus();
      return;
    }
    this.clearWorkspaceRefreshTimer();
    this.clearWorkspaceAttentionLocal(workspaceId, terminalId);
    this.selectedWorkspaceId = workspaceId;
    this.pendingAttachWorkspaceId = workspaceId;
    if (this.heldInput?.terminalId !== terminalId) this.heldInput = null;
    if (this.attachedTerminalId !== terminalId) this.rememberTerminalScreen();
    const resume = this.prepareTerminalTransition(
      'Attaching terminal...',
      this.terminalScreens.read(terminalId)
    );
    this.renderWorkspaces();
    this.renderTerminalToolbar();
    const requestId = this.requestId();
    this.pendingAttach = { requestId, terminalId };
    this.trackPendingRequest(requestId, workspaceId, 'Attach timed out. Tap to retry.');
    this.sizeOwner.forget();
    const dimensions = this.fitAndSync();
    if (dimensions) {
      this.lastSentTerminalSize = this.sizeKey(dimensions);
    }
    this.sendRemoteFrame(
      {
        type: 'app:terminal:attach',
        requestId,
        workspaceId,
        terminalId,
        ...(dimensions ? { cols: dimensions.cols, rows: dimensions.rows } : {}),
        ...(resume ? { resume } : {}),
      },
      { requestId, workspaceId }
    );
  }

  /**
   * Keeps what the attached terminal shows, with the stream position it reflects, for a quick
   * switch back to it.
   */
  private rememberTerminalScreen(): void {
    const terminalId = this.attachedTerminalId;
    const position = this.terminalStream.resumePoint();
    if (!terminalId || !position || this.pendingTerminalSnapshot) return;
    const { cols, rows } = this.term;
    // Output already accepted may still be on its way into xterm: the queue runs this once it is
    // all written, so the screen and the position match.
    this.enqueueTerminalAction(() => {
      // A fit for the next terminal got there first; this screen no longer has its own layout.
      if (this.term.cols !== cols || this.term.rows !== rows) return;
      this.terminalScreens.remember(terminalId, {
        data:
          this.serializeAddon.serialize({ scrollback: CACHED_SCROLLBACK_ROWS }) +
          this.mouseEncoding.restoreSequence(),
        ...position,
        cols,
        rows,
      });
    });
  }

  /**
   * A hidden page lets go of its terminal, so the desktop gets the terminal's size back at once
   * instead of when a pocketed phone's connection times out, and picks it up again from where
   * its screen stopped when shown.
   */
  private followPageVisibility(): void {
    if (document.visibilityState === 'hidden') {
      const terminalId = this.attachedTerminalId;
      if (!terminalId || this.detachedWhileHidden || this.disconnected || this.pendingAttach) {
        return;
      }
      this.detachedWhileHidden = true;
      this.sendRemoteFrame({ type: 'app:terminal:detach', terminalId });
      return;
    }
    // Disconnected: the reconnect picks the terminal up instead.
    if (this.detachedWhileHidden && !this.disconnected) this.resumeTerminal();
  }

  private renderWorkspaces(): void {
    this.renderWorkspaceFilters();
    const searching = this.workspaceQuery.trim().length > 0;
    const sections = buildWorkspaceSections(this.workspaces, {
      query: this.workspaceQuery,
      filter: this.workspaceFilter,
    });
    const nodes: HTMLElement[] = sections.map((section) =>
      this.renderWorkspaceGroup(
        section.id,
        section.label,
        section.workspaces,
        !searching && this.collapsedSections.has(section.id)
      )
    );
    if (nodes.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'workspace-empty';
      empty.textContent =
        this.workspaces.length > 0
          ? 'No matches.'
          : this.desktopWithheld()
            ? this.hosts().length > 0
              ? "This computer isn't shared with your devices. Open an SSH host from the menu above."
              : "This computer isn't shared with your devices, and no SSH host is set up for them yet."
            : 'No workspaces yet.';
      nodes.push(empty);
    }
    this.els.workspaceList.replaceChildren(...nodes);
  }

  private renderWorkspaceFilters(): void {
    const counts = workspaceSectionCounts(this.workspaces);
    const filters: Array<{ id: WorkspaceFilter; label: string; count: number }> = [
      { id: 'all', label: 'All', count: this.workspaces.length },
      { id: 'needs-you', label: 'Needs you', count: counts['needs-you'] },
      { id: 'working', label: 'Working', count: counts.working },
    ];
    // A filter whose last workspace was dealt with falls back to All instead of an empty list.
    if (filters.find((filter) => filter.id === this.workspaceFilter)?.count === 0) {
      this.workspaceFilter = 'all';
    }
    const visible = filters.filter((filter) => filter.id === 'all' || filter.count > 0);
    this.els.workspaceFilters.hidden = visible.length < 2;
    this.els.workspaceFilters.replaceChildren(
      ...visible.map((filter) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.workspaceFilter = filter.id;
        button.setAttribute('aria-pressed', String(filter.id === this.workspaceFilter));
        button.innerHTML = `${escapeHtml(filter.label)} <b>${filter.count}</b>`;
        return button;
      })
    );
  }

  private renderWorkspaceGroup(
    id: WorkspaceSectionId,
    label: string,
    workspaces: RemoteWorkspaceSummary[],
    collapsed: boolean
  ): HTMLElement {
    const group = document.createElement('section');
    group.className = 'workspace-group';
    const heading = document.createElement('h2');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'workspace-group-toggle';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>${escapeHtml(label)} <span>${workspaces.length}</span>`;
    toggle.addEventListener('click', () => {
      if (this.collapsedSections.has(id)) this.collapsedSections.delete(id);
      else this.collapsedSections.add(id);
      writeCollapsedSections(this.collapsedSections);
      this.renderWorkspaces();
    });
    heading.append(toggle);
    group.append(heading);
    if (!collapsed) {
      group.append(...workspaces.map((workspace) => this.renderWorkspaceCard(workspace)));
    }
    return group;
  }

  private renderWorkspaceCard(workspace: RemoteWorkspaceSummary): HTMLElement {
    const row = document.createElement('article');
    const isSelected =
      workspace.id === this.selectedWorkspaceId &&
      (this.attachedTerminalId !== null || this.pendingAttachWorkspaceId === workspace.id);
    const isRunnable = Boolean(this.terminalIdForWorkspace(workspace));
    const isStopped = !isRunnable && !workspace.provisioning;
    const pendingMessage = this.pendingMessageForWorkspace(workspace);
    row.className = [
      'workspace',
      isSelected ? 'active' : '',
      isRunnable ? 'running' : 'stopped',
      pendingMessage ? 'pending' : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (workspace.projectColor) {
      row.style.setProperty('--workspace-accent', workspace.projectColor);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-open';
    button.disabled = workspace.id === this.pendingCreateWorkspace?.id;
    const attentionTooltip = this.workspaceAttentionTooltip(workspace);
    button.title = attentionTooltip || (isStopped ? 'Tap to start this workspace' : '');
    const activity = workspace.lastActivityAt ? formatRelativeTime(workspace.lastActivityAt) : '';
    button.innerHTML = `<span class="workspace-status">${this.renderWorkspaceStatus(workspace, Boolean(pendingMessage))}</span><span class="workspace-title"><span class="workspace-name">${escapeHtml(workspace.name)}</span>${this.renderWorkspaceEnvironment(workspace)}${this.renderWorkspaceAdornment(workspace)}</span><small class="workspace-time">${escapeHtml(activity)}</small><span class="workspace-meta">${this.renderWorkspaceMeta(workspace)}</span>${this.renderWorkspacePreview(workspace, pendingMessage)}`;

    let suppressNextClick = false;
    let longPressTimer: number | null = null;
    const clearLongPress = () => {
      if (longPressTimer) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };
    button.addEventListener('click', (event) => {
      if (suppressNextClick) {
        event.preventDefault();
        suppressNextClick = false;
        return;
      }
      this.openWorkspace(workspace.id);
    });
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.openWorkspaceRowSheet(workspace, isRunnable);
    });
    row.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse') return;
      clearLongPress();
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        suppressNextClick = true;
        this.openWorkspaceRowSheet(workspace, isRunnable);
      }, 520);
    });
    row.addEventListener('pointerup', clearLongPress);
    row.addEventListener('pointerleave', clearLongPress);
    row.addEventListener('pointercancel', clearLongPress);

    const menuButton = document.createElement('button');
    menuButton.type = 'button';
    menuButton.className = 'workspace-menu-trigger';
    menuButton.setAttribute('aria-label', `${workspace.name} actions`);
    menuButton.setAttribute('aria-haspopup', 'dialog');
    menuButton.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>';
    menuButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openWorkspaceRowSheet(workspace, isRunnable);
    });
    // A host can only restart or stop a workspace, so a stopped one there has nothing to offer.
    menuButton.hidden = Boolean(this.endpoint.host) && !isRunnable;
    row.append(button, menuButton);
    return row;
  }

  private openWorkspaceRowSheet(workspace: RemoteWorkspaceSummary, isRunnable: boolean): void {
    if (this.endpoint.host && !isRunnable) return;
    const action = (label: string, run: () => void, options: { danger?: boolean } = {}) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.textContent = label;
      button.disabled = workspace.provisioning;
      if (options.danger) button.className = 'danger';
      button.addEventListener('click', () => {
        this.els.workspaceRowSheet.close();
        run();
      });
      return button;
    };
    this.els.workspaceRowTitle.textContent = workspace.name;
    this.els.workspaceRowActions.replaceChildren(
      ...(isRunnable
        ? [
            action('Restart', () => this.restartWorkspace(workspace.id)),
            action('Stop', () => this.stopWorkspace(workspace.id), { danger: true }),
          ]
        : []),
      // Titles come from the desktop's naming model.
      ...(this.endpoint.host
        ? []
        : [action('Regenerate title', () => this.regenerateWorkspaceTitle(workspace.id))])
    );
    if (!this.els.workspaceRowSheet.open) this.els.workspaceRowSheet.showModal();
  }

  private renderWorkspaceStatus(workspace: RemoteWorkspaceSummary, pending: boolean): string {
    if (workspace.attention) {
      return `<i class="workspace-dot ${attentionClassName(workspace.attention.kind)}" aria-hidden="true"></i>`;
    }
    if (workspace.agentActive || workspace.provisioning || pending) {
      return '<i class="workspace-spinner" aria-label="Agent processing"></i>';
    }
    return '<i class="workspace-dot" aria-hidden="true"></i>';
  }

  private renderWorkspaceMeta(workspace: RemoteWorkspaceSummary): string {
    const project = workspace.projectName
      ? `<span class="workspace-project"><i aria-hidden="true"></i>${escapeHtml(workspace.projectName)}</span>`
      : '';
    const place =
      workspace.branchName ?? workspace.workingDirectory.split(/[\\/]/).pop() ?? 'Provisioning';
    return `${project}<span class="workspace-branch">${escapeHtml(place)}</span>${this.renderWorkspaceStats(workspace)}`;
  }

  private renderWorkspaceStats(workspace: RemoteWorkspaceSummary): string {
    const git = workspace.git;
    const badges: string[] = [];
    if (git?.additions) badges.push(`<b class="git-add">+${git.additions}</b>`);
    if (git?.deletions) badges.push(`<b class="git-del">−${git.deletions}</b>`);
    if (git?.aheadTargetBranch) {
      badges.push(`<b class="git-ahead">↑${git.aheadTargetBranch}</b>`);
    }
    if (git?.behindTargetBranch) {
      badges.push(`<b class="git-behind">↓${git.behindTargetBranch}</b>`);
    }
    return badges.length ? `<small class="workspace-stats">${badges.join('')}</small>` : '';
  }

  private renderWorkspacePreview(
    workspace: RemoteWorkspaceSummary,
    pendingMessage: string
  ): string {
    if (pendingMessage) {
      return `<small class="workspace-preview"><span class="workspace-notice"><i aria-hidden="true"></i>${escapeHtml(pendingMessage)}</span></small>`;
    }
    const message = workspace.attention?.message?.trim();
    if (workspace.attention && message && !attentionMessageIsLabel(workspace.attention)) {
      return `<small class="workspace-preview attention">${escapeHtml(message)}</small>`;
    }
    if (!hasLiveTerminal(workspace)) return '';
    const terminals = this.attachableTerminals(workspace);
    const names = terminals.map((terminal, index) => terminal.name || `Terminal ${index + 1}`);
    const count = terminals.length === 1 ? '1 terminal' : `${terminals.length} terminals`;
    return `<small class="workspace-preview">${escapeHtml([count, names.join(', ')].join(' · '))}</small>`;
  }

  private renderWorkspaceAdornment(workspace: RemoteWorkspaceSummary): string {
    if (!workspace.attention) return '';
    const label = attentionLabel(workspace.attention);
    return `<b class="workspace-badge ${attentionClassName(workspace.attention.kind)}">${escapeHtml(label)}</b>`;
  }

  private renderWorkspaceEnvironment(workspace: RemoteWorkspaceSummary): string {
    const terminalId = this.terminalIdForWorkspace(workspace);
    const environment = workspace.terminals.find(
      (terminal) => terminal.id === terminalId
    )?.environment;
    if (!environment) return '';
    return `<b class="workspace-environment ${environment.kind}">${escapeHtml(environment.name)}</b>`;
  }

  private workspaceAttentionTooltip(workspace: RemoteWorkspaceSummary): string {
    if (!workspace.attention) return '';
    const label = attentionLabel(workspace.attention);
    const message = workspace.attention.message?.trim();
    const usesMessageAsLabel = attentionMessageIsLabel(workspace.attention);
    return message && !usesMessageAsLabel ? `${label}: ${message}` : label;
  }

  // ── Settings and notifications ──────────────────────────────────────

  private openSettings(): void {
    this.renderPushSettings();
    if (!this.els.settingsSheet.open) this.els.settingsSheet.showModal();
  }

  private sendVisibility(): void {
    if (this.disconnected || this.peer.state !== 'established') return;
    void this.peer
      .sendEncryptedJson({
        type: 'app:client:visibility',
        visible: document.visibilityState === 'visible',
      })
      .catch(() => {});
  }

  private sendPushFrame(
    frame:
      | { type: 'app:push:config:get' }
      | { type: 'app:push:unsubscribe' }
      | { type: 'app:push:test' }
      | Omit<Extract<RemoteAppFrame, { type: 'app:push:subscribe' }>, 'requestId'>
  ): void {
    const requestId = this.requestId();
    this.pushRequestId = requestId;
    this.pushNote = '';
    if (!this.sendRemoteFrame({ ...frame, requestId } as RemoteAppFrame)) this.pushRequestId = null;
    this.renderPushSettings();
  }

  private selectedPushWhen(): RemotePushNotifyWhen {
    const checked = this.els.pushWhen.querySelector<HTMLInputElement>('input:checked');
    return checked?.value === 'always' ? 'always' : 'away';
  }

  private renderPushSettings(): void {
    const support = pushSupport(currentPushEnvironment());
    const config = this.pushConfig;
    const busy = this.pushRequestId !== null;
    const subscribed = this.pushPending?.subscribed ?? Boolean(config?.subscribed);
    const notifyWhen = this.pushPending?.notifyWhen ?? config?.notifyWhen ?? 'away';
    const permission = 'Notification' in window ? Notification.permission : 'default';
    this.els.pushToggle.checked = subscribed;
    this.els.pushToggle.disabled =
      busy || support !== 'supported' || !config?.available || !config.vapidPublicKey;
    for (const radio of this.els.pushWhen.querySelectorAll<HTMLInputElement>('input')) {
      radio.checked = radio.value === notifyWhen;
    }
    this.els.pushWhen.disabled = !subscribed || busy;
    this.els.pushWhen.hidden = !subscribed;
    this.els.pushTest.hidden = !subscribed;
    this.els.pushTest.disabled = busy;
    this.els.pushStatus.textContent = busy
      ? 'Updating…'
      : subscribed
        ? 'On for this device'
        : 'When an agent needs you, finishes or fails';
    const hint =
      support === 'needs-home-screen'
        ? 'On iPhone and iPad, tap Share → Add to Home Screen, then open Komla from your Home Screen to turn on notifications.'
        : support === 'unsupported'
          ? "This browser can't receive notifications."
          : support === 'insecure'
            ? 'Notifications need the HTTPS address that Tailscale Serve gives this computer.'
            : config && !config.available
              ? this.endpoint.host
                ? 'Notifications come from Komla on your computer. Turn them on while connected to it.'
                : 'Notifications need access to the OS keychain on the computer running Komla.'
              : permission === 'denied'
                ? "Notifications are blocked. Allow them for this app in your phone's settings."
                : this.pushNote;
    this.els.pushHint.textContent = hint;
    this.els.pushHint.hidden = !hint;
  }

  private async enablePush(): Promise<void> {
    const vapidPublicKey = this.pushConfig?.vapidPublicKey;
    this.pushPending = { subscribed: true, notifyWhen: this.selectedPushWhen() };
    // Ask before anything else: iOS only shows the prompt inside the tap that asked for it.
    let permission: NotificationPermission;
    try {
      permission = await Notification.requestPermission();
    } catch {
      permission = 'denied';
    }
    if (permission !== 'granted' || !vapidPublicKey) {
      this.pushPending = null;
      this.renderPushSettings();
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await subscribeBrowser(registration, base64UrlToBytes(vapidPublicKey));
      if (!subscription) throw new Error('the browser returned an incomplete subscription');
      this.pushPending = { subscribed: true, notifyWhen: this.selectedPushWhen() };
      this.sendPushFrame({
        type: 'app:push:subscribe',
        subscription,
        notifyWhen: this.selectedPushWhen(),
      });
    } catch (err) {
      this.pushPending = null;
      this.pushNote = `Couldn't turn on notifications: ${err instanceof Error ? err.message : String(err)}`;
      this.renderPushSettings();
    }
  }

  private async disablePush(): Promise<void> {
    this.pushPending = { subscribed: false, notifyWhen: this.selectedPushWhen() };
    this.sendPushFrame({ type: 'app:push:unsubscribe' });
    try {
      await unsubscribeBrowser(await navigator.serviceWorker.ready);
    } catch {
      // The desktop already forgot it; a stale browser subscription only costs a 410.
    }
  }

  private async updatePushWhen(): Promise<void> {
    if (!this.pushConfig?.subscribed) return;
    const notifyWhen = this.selectedPushWhen();
    this.pushPending = { subscribed: true, notifyWhen };
    this.renderPushSettings();
    const registration = await navigator.serviceWorker.ready;
    const current = await registration.pushManager.getSubscription();
    const subscription = current ? toPushFrameSubscription(current.toJSON()) : null;
    if (!subscription) {
      this.pushPending = null;
      this.pushNote = 'Turn notifications off and on again to finish setting them up.';
      this.renderPushSettings();
      return;
    }
    this.sendPushFrame({ type: 'app:push:subscribe', subscription, notifyWhen });
  }

  /** Once per connection, re-send the browser's subscription; push services rotate endpoints. */
  private async refreshBrowserSubscription(): Promise<void> {
    const config = this.pushConfig;
    if (this.pushRefreshed || !config?.subscribed || !config.vapidPublicKey) return;
    this.pushRefreshed = true;
    if (pushSupport(currentPushEnvironment()) !== 'supported') return;
    if (Notification.permission !== 'granted') return;
    try {
      const subscription = await subscribeBrowser(
        await navigator.serviceWorker.ready,
        base64UrlToBytes(config.vapidPublicKey)
      );
      if (subscription) {
        this.sendPushFrame({
          type: 'app:push:subscribe',
          subscription,
          notifyWhen: config.notifyWhen,
        });
      }
    } catch (err) {
      console.warn('Push subscription refresh failed', err);
    }
  }

  /** Opens the workspace a tapped notification points at, once the list has it. */
  private openPendingTarget(): void {
    const target = this.pendingOpen;
    if (!target || this.workspaces.length === 0) return;
    this.pendingOpen = null;
    const workspace = this.workspaces.find((candidate) => candidate.id === target.workspaceId);
    if (!workspace) return;
    this.els.settingsSheet.close();
    const terminalId = this.attachableTerminals(workspace).some(
      (terminal) => terminal.id === target.terminalId
    )
      ? target.terminalId
      : undefined;
    if (!terminalId) {
      this.openWorkspace(workspace.id);
      return;
    }
    this.showTerminal();
    this.attachWorkspace(workspace.id, terminalId);
  }

  private bindLaunchPickers(): void {
    const sheet = this.els.pickerSheet;
    const agentMark = (option: HTMLOptionElement) => agentIconSvg(option.textContent ?? '');
    bindSelectPicker(this.els.projectSelect, sheet, { label: 'Project', mark: colorDotMark });
    bindSelectPicker(this.els.presetSelect, sheet, { label: 'Agent', mark: agentMark });
    bindSelectPicker(this.els.launchModeSelect, sheet, {
      label: 'Mode',
      mark: colorDotMark,
      hideWhenSingle: true,
    });
    bindSelectPicker(this.els.environmentSelect, sheet, { label: 'Run on' });
    bindSelectPicker(this.els.terminalAgentPreset, sheet, { label: 'Agent', mark: agentMark });
    bindSelectPicker(this.els.terminalAgentLaunchMode, sheet, {
      label: 'Mode',
      mark: colorDotMark,
      hideWhenSingle: true,
    });
    for (const dialog of [sheet, this.els.createDialog, this.els.terminalLaunchDialog]) {
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
    }
  }

  private openCreateDialog(): void {
    if (this.projects.length === 0 || this.presets.length === 0) {
      this.getLaunchOptions();
    }
    this.renderLaunchOptions();
    this.els.createWorkspaceError.hidden = true;
    this.els.createDialog.showModal();
  }

  private renderLaunchOptions(): void {
    const currentProjectId = this.validProjectId(this.els.projectSelect.value);
    const storedProjectId = this.validProjectId(this.launchPreferences.projectId);
    const selectedWorkspaceProjectId = this.validProjectId(
      this.workspaces.find((workspace) => workspace.id === this.selectedWorkspaceId)?.projectId
    );
    const selectedProjectId =
      currentProjectId ||
      storedProjectId ||
      selectedWorkspaceProjectId ||
      this.projects[0]?.id ||
      '';
    this.els.projectSelect.replaceChildren(
      ...this.projects.map((project) =>
        option(project.id, project.name, selectedProjectId, project.color)
      )
    );

    const selectedPresetId =
      this.validPresetId(this.els.presetSelect.value) ||
      this.validPresetId(this.launchPreferences.presetId) ||
      this.presets[0]?.id ||
      '';
    this.els.presetSelect.replaceChildren(
      ...this.presets.map((preset) => option(preset.id, preset.name, selectedPresetId))
    );
    this.renderLaunchModes();
    this.renderEnvironments();
    this.persistLaunchPreferences();
  }

  private renderLaunchModes(resetToPreferred = false): void {
    const preset = this.presets.find((candidate) => candidate.id === this.els.presetSelect.value);
    const currentModeId = resetToPreferred
      ? undefined
      : this.validLaunchModeId(preset, selectValueToLaunchModeId(this.els.launchModeSelect.value));
    const storedModeId = resetToPreferred
      ? undefined
      : this.validLaunchModeId(preset, this.launchPreferences.launchModeId);
    const selectedModeId =
      launchModeIdToSelectValue(
        currentModeId ?? storedModeId ?? this.resolvePreferredLaunchModeId(preset)
      ) || '';
    this.els.launchModeSelect.replaceChildren(
      option('', 'Default', selectedModeId),
      ...(preset?.launchModes.map((mode, index) =>
        option(mode.id, mode.name, selectedModeId, launchModeColor(mode.color, index))
      ) ?? [])
    );
  }

  private renderEnvironments(): void {
    const selectedValue = defaultEnvironmentValue(
      this.environments,
      this.els.environmentSelect.value || this.launchPreferences.environment
    );
    this.els.environmentField.hidden = this.environments.length < 2;
    this.els.environmentSelect.replaceChildren(
      ...this.environments.map((environment) =>
        option(environmentValue(environment), environment.name, selectedValue)
      )
    );
  }

  private resolvePreferredLaunchModeId(
    preset: RemoteAgentPresetSummary | undefined
  ): string | null {
    if (!preset) return null;
    if (preset.lastLaunchModeId !== undefined) {
      return this.validLaunchModeId(preset, preset.lastLaunchModeId) ?? null;
    }
    return this.validLaunchModeId(preset, this.defaultLaunchModeId) ?? null;
  }

  private validProjectId(projectId: string | null | undefined): string | undefined {
    return projectId && this.projects.some((project) => project.id === projectId)
      ? projectId
      : undefined;
  }

  private validPresetId(presetId: string | null | undefined): string | undefined {
    return presetId && this.presets.some((preset) => preset.id === presetId) ? presetId : undefined;
  }

  private validLaunchModeId(
    preset: RemoteAgentPresetSummary | undefined,
    launchModeId: string | null | undefined
  ): string | null | undefined {
    if (launchModeId === null) return null;
    if (!preset || !launchModeId) return undefined;
    return preset.launchModes.some((mode) => mode.id === launchModeId) ? launchModeId : undefined;
  }

  private persistLaunchPreferences(): void {
    const prefs: LaunchPreferences = {
      ...(this.els.projectSelect.value ? { projectId: this.els.projectSelect.value } : {}),
      ...(this.els.presetSelect.value ? { presetId: this.els.presetSelect.value } : {}),
      launchModeId: selectValueToLaunchModeId(this.els.launchModeSelect.value),
      ...(this.els.environmentSelect.value
        ? { environment: this.els.environmentSelect.value }
        : this.launchPreferences.environment
          ? { environment: this.launchPreferences.environment }
          : {}),
    };
    this.launchPreferences = prefs;
    writeLaunchPreferences(prefs);
  }

  private setCreateWorkspacePending(pending: boolean): void {
    this.els.createWorkspace.disabled = pending;
    this.els.createWorkspace.classList.toggle('pending', pending);
    this.els.createWorkspace.textContent = pending ? 'Launching...' : 'Launch workspace';
  }

  private terminalIdForWorkspace(workspace: RemoteWorkspaceSummary): string | undefined {
    const primary = workspace.primaryTerminalId
      ? workspace.terminals.find((terminal) => terminal.id === workspace.primaryTerminalId)
      : undefined;
    if (primary && primary.status !== 'stopped') return primary.id;
    return (
      workspace.terminals.find((terminal) => terminal.status === 'running')?.id ??
      workspace.terminals.find((terminal) => terminal.status === 'starting')?.id
    );
  }

  private attachableTerminals(workspace: RemoteWorkspaceSummary): RemoteTerminalSummary[] {
    return workspace.terminals.filter((terminal) => terminal.status !== 'stopped');
  }

  private renderTerminalToolbar(): void {
    const workspace = this.selectedWorkspaceId
      ? this.workspaces.find((candidate) => candidate.id === this.selectedWorkspaceId)
      : undefined;
    const terminals = workspace ? this.attachableTerminals(workspace) : [];
    const selectedTerminalId = workspace
      ? (this.attachedTerminalId ?? this.terminalIdForWorkspace(workspace))
      : undefined;
    this.els.terminalToolbar.hidden = !workspace;
    this.els.terminalPanel.classList.toggle('has-terminal-toolbar', Boolean(workspace));
    this.renderWorkspaceActions();
    if (!workspace) {
      this.closeWorkspaceActionsMenu();
      this.els.terminalWorkspaceName.textContent = '';
      this.els.terminalEnvironment.hidden = true;
      this.els.terminalEnvironment.textContent = '';
      this.els.terminalWorkspaceStatus.replaceChildren();
      this.els.terminalTabs.replaceChildren();
      return;
    }
    this.els.terminalWorkspaceName.textContent = workspace.name;
    const selectedTerminal = terminals.find((terminal) => terminal.id === selectedTerminalId);
    const environment = selectedTerminal?.environment;
    this.els.terminalEnvironment.hidden = !environment;
    this.els.terminalEnvironment.textContent = environment?.name ?? '';
    this.els.terminalEnvironment.className = `terminal-environment ${environment?.kind ?? ''}`;
    this.els.terminalWorkspaceStatus.innerHTML = this.renderSessionStatus(workspace, terminals);
    const switching = Boolean(this.pendingAttachWorkspaceId);
    const tabs = terminals.flatMap((terminal, index) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'terminal-tab';
      tab.setAttribute('role', 'tab');
      tab.dataset.terminalId = terminal.id;
      tab.setAttribute('aria-selected', String(terminal.id === selectedTerminalId));
      tab.disabled = switching && terminal.id !== selectedTerminalId;
      const marker = terminal.attention
        ? attentionClassName(terminal.attention.kind)
        : terminal.agentActive
          ? 'working'
          : '';
      const label = this.terminalLabel(terminal, index);
      tab.innerHTML = `${marker ? `<i class="${marker}" aria-hidden="true"></i>` : ''}<span>${escapeHtml(label)}</span>`;
      if (terminal.id !== selectedTerminalId) return [tab];
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'terminal-tab-close';
      close.dataset.tabAction = 'close';
      close.dataset.terminalId = terminal.id;
      close.disabled = switching;
      close.setAttribute('aria-label', `Close ${label}`);
      close.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>';
      return [tab, close];
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'terminal-tab-add';
    add.dataset.tabAction = 'new';
    add.setAttribute('aria-label', 'New terminal or agent');
    add.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>';
    this.els.terminalTabs.setAttribute('role', 'tablist');
    this.els.terminalTabs.replaceChildren(...tabs, add);
  }

  private renderSessionStatus(
    workspace: RemoteWorkspaceSummary,
    terminals: RemoteTerminalSummary[]
  ): string {
    const count =
      terminals.length === 0
        ? workspace.provisioning
          ? 'Preparing'
          : 'No running terminals'
        : terminals.length === 1
          ? '1 terminal'
          : `${terminals.length} terminals`;
    if (workspace.attention) {
      return `<i class="${attentionClassName(workspace.attention.kind)}" aria-hidden="true"></i>${escapeHtml(
        `${attentionLabel(workspace.attention)} · ${count}`
      )}`;
    }
    if (workspace.agentActive) {
      return `<i class="working" aria-hidden="true"></i>${escapeHtml(`Working · ${count}`)}`;
    }
    return `<i aria-hidden="true"></i>${escapeHtml(count)}`;
  }

  private terminalLabel(terminal: RemoteTerminalSummary, index: number): string {
    const status = terminal.status === 'running' ? '' : ` (${terminal.status})`;
    return `${terminal.name || `Terminal ${index + 1}`}${status}`;
  }

  private waitForWorkspace(workspaceId: string): void {
    const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId);
    if (!workspace) return;
    this.selectedWorkspaceId = workspaceId;
    this.attachedTerminalId = null;
    this.pendingAttachWorkspaceId = null;
    const status = workspace.provisioning ? 'Preparing workspace...' : 'Waiting for terminal...';
    this.prepareTerminalTransition(status);
    this.renderWorkspaces();
    this.renderTerminalToolbar();
    this.scheduleWorkspaceRefresh();
  }

  /**
   * Clears the screen for another terminal, or paints `screen`, that terminal's cached copy, if
   * it was laid out for this size; returns the position to resume it from then.
   */
  private prepareTerminalTransition(
    status: string,
    screen?: CachedTerminalScreen | null
  ): { generation: number; seq: number } | undefined {
    this.cancelVoiceRecording();
    this.pendingAttach = null;
    this.pendingTerminalSnapshot = null;
    this.stoppedTerminalId = null;
    this.attachedTerminalId = null;
    this.lastSentTerminalSize = null;
    this.detachedWhileHidden = false;
    this.paintedFromCache = false;
    this.terminalStream.clear();
    this.enqueueTerminalAction(() => this.resetTerminal());
    this.fitAndSync();
    if (screen && screen.cols === this.term.cols && screen.rows === this.term.rows) {
      this.paintedFromCache = true;
      this.terminalStream.reset(screen.generation, screen.seq);
      this.clearTerminalLoading();
      this.enqueueTerminalWrite(screen.data, () => {
        this.term.scrollToBottom();
        this.syncMobileTouchScroller();
      });
      return { generation: screen.generation, seq: screen.seq };
    }
    this.setTerminalLoading(status);
    return undefined;
  }

  /** Clears the screen, and the mouse encoding tracked for it, for another terminal's output. */
  private resetTerminal(): void {
    this.term.reset();
    this.mouseEncoding.forget();
  }

  private setTerminalLoading(status: string): void {
    this.els.terminalStatusText.textContent = status;
    this.els.terminalStatusOverlay.hidden = false;
    this.els.terminalPanel.classList.add('terminal-loading');
  }

  private clearTerminalLoading(): void {
    this.els.terminalStatusOverlay.hidden = true;
    this.els.terminalPanel.classList.remove('terminal-loading');
  }

  private scheduleWorkspaceRefresh(): void {
    if (this.workspaceRefreshTimer !== null) return;
    this.workspaceRefreshTimer = window.setTimeout(() => {
      this.workspaceRefreshTimer = null;
      this.listWorkspaces();
    }, 1000);
  }

  private clearWorkspaceRefreshTimer(): void {
    if (this.workspaceRefreshTimer === null) return;
    window.clearTimeout(this.workspaceRefreshTimer);
    this.workspaceRefreshTimer = null;
  }

  private withPendingCreate(workspaces: RemoteWorkspaceSummary[]): RemoteWorkspaceSummary[] {
    const remoteWorkspaces = sortWorkspaces(workspaces);
    if (!this.pendingCreateWorkspace) return remoteWorkspaces;
    if (remoteWorkspaces.some((workspace) => workspace.id === this.pendingCreateWorkspace?.id)) {
      return remoteWorkspaces;
    }
    return sortWorkspaces([this.pendingCreateWorkspace, ...remoteWorkspaces]);
  }

  private pendingMessageForWorkspace(workspace: RemoteWorkspaceSummary): string {
    if (workspace.id === this.pendingCreateWorkspace?.id) return 'Launching workspace...';
    const explicit = this.pendingWorkspaceMessages.get(workspace.id);
    if (explicit) return explicit;
    if (workspace.provisioning) return 'Preparing workspace...';
    return '';
  }

  private clearWorkspaceAttentionLocal(workspaceId: string, terminalId?: string): void {
    this.workspaces = this.workspaces.map((workspace) => {
      if (workspace.id !== workspaceId) return workspace;
      const terminals = terminalId
        ? workspace.terminals.map((terminal) => {
            if (terminal.id !== terminalId) return terminal;
            const { attention: _attention, ...rest } = terminal;
            return rest;
          })
        : workspace.terminals.map((terminal) => {
            const { attention: _attention, ...rest } = terminal;
            return rest;
          });
      const { attention: _attention, needsAttention: _needsAttention, ...rest } = workspace;
      return {
        ...rest,
        needsAttention: false,
        terminals,
      };
    });
  }

  private updateTerminalStatus(
    workspaceId: string | undefined,
    terminalId: string,
    status: RemoteWorkspaceSummary['terminals'][number]['status']
  ): void {
    this.workspaces = this.workspaces.map((workspace) =>
      (
        workspaceId
          ? workspace.id === workspaceId
          : workspace.terminals.some((terminal) => terminal.id === terminalId)
      )
        ? {
            ...workspace,
            terminals: workspace.terminals.map((terminal) =>
              terminal.id === terminalId ? { ...terminal, status } : terminal
            ),
          }
        : workspace
    );
    if (terminalId !== this.attachedTerminalId || status !== 'stopped') {
      this.renderWorkspaces();
      this.renderTerminalToolbar();
      return;
    }
    this.cancelVoiceRecording();
    this.stoppedTerminalId = terminalId;
    this.attachedTerminalId = null;
    this.pendingAttachWorkspaceId = null;
    this.clearTerminalLoading();
    this.enqueueTerminalLine('\r\n\r\nTerminal stopped.');
    this.renderWorkspaces();
    this.renderTerminalToolbar();
    this.updateVoiceUi();
  }

  private clearPendingRequest(requestId: string | undefined): void {
    if (!requestId) return;
    const timer = this.pendingRequestTimers.get(requestId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.pendingRequestTimers.delete(requestId);
    }
    const workspaceId = this.pendingRequestWorkspaces.get(requestId);
    if (!workspaceId) return;
    this.pendingRequestWorkspaces.delete(requestId);
    this.pendingWorkspaceMessages.delete(workspaceId);
  }

  private trackPendingRequest(
    requestId: string,
    workspaceId: string,
    timeoutMessage: string
  ): void {
    this.pendingRequestWorkspaces.set(requestId, workspaceId);
    const timer = window.setTimeout(() => {
      this.pendingRequestTimers.delete(requestId);
      if (this.pendingRequestWorkspaces.get(requestId) !== workspaceId) return;
      this.pendingRequestWorkspaces.delete(requestId);
      if (this.pendingCreateRequestId === requestId) {
        this.pendingCreateRequestId = null;
        this.pendingCreateWorkspace = null;
        this.els.createWorkspaceError.textContent = timeoutMessage;
        this.els.createWorkspaceError.hidden = false;
      }
      this.pendingWorkspaceMessages.set(workspaceId, timeoutMessage);
      if (this.pendingAttachWorkspaceId === workspaceId) {
        this.pendingAttachWorkspaceId = null;
        this.setTerminalLoading(timeoutMessage);
      }
      this.setCreateWorkspacePending(false);
      this.renderWorkspaces();
      this.renderTerminalToolbar();
    }, REMOTE_REQUEST_TIMEOUT_MS);
    this.pendingRequestTimers.set(requestId, timer);
  }

  private fitAfterLayout(): void {
    requestAnimationFrame(() => {
      this.fitAndSync();
      requestAnimationFrame(() => this.fitAndSync());
    });
  }

  private showWorkspaceList(): void {
    this.cancelVoiceRecording();
    this.exitTerminalSelection();
    this.stoppedTerminalId = null;
    this.heldInput = null;
    const inFlight = this.pendingAttach;
    if (inFlight) {
      // Leaving mid-attach: the desktop would otherwise finish it and keep
      // this phone's size lease on the terminal.
      this.sendRemoteFrame({ type: 'app:terminal:detach', terminalId: inFlight.terminalId });
      this.clearPendingRequest(inFlight.requestId);
      this.pendingAttach = null;
      this.pendingTerminalSnapshot = null;
      this.pendingAttachWorkspaceId = null;
      this.clearTerminalLoading();
    }
    if (this.attachedTerminalId) {
      this.rememberTerminalScreen();
      this.sendRemoteFrame({
        type: 'app:terminal:detach',
        terminalId: this.attachedTerminalId,
      });
      this.detachedWhileHidden = false;
      this.attachedTerminalId = null;
      this.terminalStream.clear();
      this.lastSentTerminalSize = null;
      this.pendingTerminalSnapshot = null;
      this.els.terminalJumpLatest.hidden = true;
    }
    // Leaving the session ends it: otherwise the next workspace list would attach it again
    // in the background, with a hidden terminal's size.
    this.selectedWorkspaceId = null;
    this.pendingAttachWorkspaceId = null;
    this.updateVoiceUi();
    this.renderTerminalToolbar();
    this.els.shell.classList.add('workspace-view');
    this.els.shell.classList.remove('terminal-view');
  }

  private showTerminal(): void {
    this.els.shell.classList.add('terminal-view');
    this.els.shell.classList.remove('workspace-view');
    this.updateVoiceUi();
    this.updateVisualViewportSize();
    this.fitAfterLayout();
  }

  private fitAndSync(): { cols: number; rows: number } | undefined {
    this.applyTerminalScale();
    // The terminal keeps the desktop's size while the desktop has it.
    if (this.sizeOwner.desktopSize(this.attachedTerminalId)) return undefined;
    try {
      this.fitAddon.fit();
      const dimensions = this.fitAddon.proposeDimensions();
      // A hidden terminal measures as NaN, which the desktop rightly refuses.
      if (!dimensions || !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) {
        return undefined;
      }
      const sizeKey = this.sizeKey(dimensions);
      if (
        this.attachedTerminalId &&
        !this.detachedWhileHidden &&
        sizeKey !== this.lastSentTerminalSize
      ) {
        this.lastSentTerminalSize = sizeKey;
        this.sendRemoteFrame({
          type: 'app:terminal:resize',
          terminalId: this.attachedTerminalId,
          cols: dimensions.cols,
          rows: dimensions.rows,
        });
      }
      this.syncMobileTouchScroller();
      return dimensions;
    } catch {
      // xterm can reject fit while hidden during startup.
      return undefined;
    }
  }

  /**
   * Touching or typing in the terminal, its keys or its composer takes the terminal's size back
   * from the desktop. The toolbar only moves between terminals.
   */
  private bindTerminalSizeClaim(): void {
    const claim = (event: Event) => {
      if (event.target instanceof Node && this.els.terminalToolbar.contains(event.target)) return;
      if (event instanceof KeyboardEvent && MODIFIER_KEYS.has(event.key)) return;
      this.claimTerminalSize();
    };
    this.els.terminalPanel.addEventListener('pointerdown', claim, { capture: true });
    this.els.terminalPanel.addEventListener('keydown', claim, { capture: true });
  }

  private claimTerminalSize(): void {
    const terminalId = this.attachedTerminalId;
    const given = this.sizeOwner.claim(terminalId);
    if (!terminalId || !given) return;
    this.lastSentTerminalSize = null;
    this.fitAndSync();
    // Still hidden or not laid out: no resize went, so the desktop keeps the size.
    if (this.lastSentTerminalSize === null) {
      this.sizeOwner.unclaim(terminalId, given);
      this.term.resize(given.cols, given.rows);
      this.applyTerminalScaleAfterRender();
    }
  }

  /** The desktop says whose size the attached terminal follows. */
  private followTerminalSize(frame: TerminalSizeWord): void {
    const change = this.sizeOwner.follow(frame, this.attachedTerminalId);
    if (change === 'desktop') {
      this.enqueueTerminalAction(() => {
        // The phone took the size back meanwhile.
        if (!this.sizeOwner.desktopSize(frame.terminalId)) return;
        this.term.resize(frame.cols, frame.rows);
        this.applyTerminalScaleAfterRender();
      });
      this.applyTerminalScale();
    } else if (change === 'remote') {
      // A resize this phone sent anyway took the size back, at the size it asked for.
      this.lastSentTerminalSize = this.sizeKey(frame);
      this.fitAndSync();
    }
  }

  /**
   * A terminal at the desktop's size keeps the desktop's columns and rows, scaled down to fit
   * this screen; otherwise it is drawn at its own size.
   */
  private applyTerminalScale(): void {
    const desktopSized = this.sizeOwner.desktopSize(this.attachedTerminalId) !== null;
    this.els.terminalDesktopSize.hidden = !desktopSized;
    this.els.terminalHost.classList.toggle('desktop-sized', desktopSized);
    const element = this.term.element;
    if (!element) return;
    if (!desktopSized) {
      element.style.removeProperty('transform');
      return;
    }
    const screen = element.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || screen.offsetWidth <= 0 || screen.offsetHeight <= 0) return;
    const host = this.els.terminalHost;
    const style = getComputedStyle(host);
    const width = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height =
      host.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    const scale = Math.min(1, width / screen.offsetWidth, height / screen.offsetHeight);
    element.style.transform = `scale(${scale})`;
  }

  /** xterm lays out a resize when it next renders. */
  private applyTerminalScaleAfterRender(): void {
    requestAnimationFrame(() => this.applyTerminalScale());
  }

  private sizeKey(dimensions: { cols: number; rows: number }): string {
    return `${dimensions.cols}x${dimensions.rows}`;
  }

  private sendTerminalInput(data: string): void {
    const terminalId = this.attachedTerminalId;
    if (!terminalId) {
      const pendingId = this.pendingAttach?.terminalId;
      if (!pendingId) return;
      const earlier = this.heldInput?.terminalId === pendingId ? this.heldInput.data : '';
      this.heldInput = { terminalId: pendingId, data: earlier + data };
      return;
    }
    // A large paste goes out in pieces; the PTY receives them as one stream.
    for (const piece of splitTerminalInput(terminalId, data, this.peer.maxBodyBytes())) {
      if (!this.peer.usesBinaryFrames()) {
        this.sendRemoteFrame({ type: 'app:terminal:input', terminalId, data: piece });
      } else if (this.ensureConnected()) {
        void this.peer
          .sendEncryptedBinary(encodeBinaryTerminalInput({ terminalId, data: piece }))
          .catch((err) => this.sendFailed(err));
      }
    }
  }

  // ── Voice dictation ─────────────────────────────────────────────────
  // Records mic audio in the browser, ships 16 kHz Int16 PCM to the desktop,
  // and inserts the locally transcribed text, optionally submitting it.

  private bindVoiceControls(): void {
    this.els.terminalComposer.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      this.submitTerminalComposer();
    });
    this.els.terminalSend.addEventListener('click', () => this.submitTerminalComposer());
    this.els.terminalKeysToggle.addEventListener('click', () => this.toggleTerminalKeys());
    this.els.voiceRecord.addEventListener('click', () => void this.startVoiceRecording());
    this.els.voiceAbort.addEventListener('click', () => this.cancelVoiceRecording());
    this.els.voiceUse.addEventListener('click', () => this.stopAndTranscribeVoice(false));
    this.els.voiceSend.addEventListener('click', () => this.stopAndTranscribeVoice(true));
  }

  private submitTerminalComposer(): void {
    const input = this.els.terminalComposer.value;
    if (!input) return;
    this.submitTerminalText(input);
    this.els.terminalComposer.value = '';
    this.els.terminalComposer.focus();
  }

  private submitTerminalText(input: string): void {
    // A terminal still attaching holds what is typed until it is attached.
    const inputTerminalId = () => this.attachedTerminalId ?? this.pendingAttach?.terminalId;
    const terminalId = inputTerminalId();
    if (!terminalId) return;
    this.term.paste(input);
    window.setTimeout(() => {
      if (inputTerminalId() === terminalId) this.term.input(TERMINAL_ENTER);
    }, 50);
  }

  private toggleTerminalKeys(): void {
    this.terminalKeysOpen = !this.terminalKeysOpen;
    this.updateVoiceUi();
    this.fitAfterLayout();
  }

  private get isRecordingVoice(): boolean {
    return this.voiceCapture !== null;
  }

  private async startVoiceRecording(): Promise<void> {
    if (this.voiceStarting || this.isRecordingVoice) return;
    if (!this.voiceAvailable) {
      this.setVoiceStatus(
        'Voice unavailable. Install a model in Komla under Settings → General → Voice Input.',
        4000
      );
      return;
    }
    if (!this.attachedTerminalId) {
      this.setVoiceStatus('Open a terminal first', 2500);
      return;
    }
    this.voiceTarget = 'terminal';
    this.voiceStarting = true;
    this.updateVoiceUi();
    this.queryVoiceAvailability();
    try {
      this.voiceCapture = await startAudioCapture();
    } catch (err) {
      console.warn('Mic capture failed', err);
      const detail = err instanceof Error && err.name ? err.name : 'unavailable';
      this.setVoiceStatus(`Mic ${detail}`, 4000);
      this.voiceStarting = false;
      this.voiceTarget = null;
      this.updateVoiceUi();
      this.updateWorkspaceVoiceUi();
      return;
    }
    this.voiceStarting = false;
    this.setVoiceStatus('', 0);
    this.voiceLevelTimer = window.setInterval(() => {
      const level = this.voiceCapture?.getLevel() ?? 0;
      const text = `● ${'▁▂▃▄▅▆▇█'[Math.min(7, Math.round(level * 14))]}`;
      this.els.voiceMeter.textContent = text;
      this.els.workspaceVoiceMeter.textContent = text;
    }, 100);
    this.updateVoiceUi();
    this.updateWorkspaceVoiceUi();
  }

  private async startWorkspaceVoice(editPrompt = false): Promise<void> {
    if (!this.voiceAvailable || this.voiceStarting || this.isRecordingVoice) return;
    this.workspaceVoiceEditsPrompt = editPrompt;
    if (this.projects.length === 0 || this.presets.length === 0) this.getLaunchOptions();
    this.voiceTarget = 'workspace';
    this.voiceStarting = true;
    this.setWorkspaceVoiceStatus('Starting mic');
    this.updateWorkspaceVoiceUi();
    this.queryVoiceAvailability();
    try {
      this.voiceCapture = await startAudioCapture();
    } catch (err) {
      console.warn('Mic capture failed', err);
      const detail = err instanceof Error && err.name ? err.name : 'unavailable';
      this.setWorkspaceVoiceStatus(`Mic ${detail}`);
      this.voiceStarting = false;
      this.voiceTarget = null;
      this.workspaceVoiceEditsPrompt = false;
      this.updateWorkspaceVoiceUi();
      return;
    }
    this.voiceStarting = false;
    this.setWorkspaceVoiceStatus('Recording');
    this.voiceLevelTimer = window.setInterval(() => {
      const level = this.voiceCapture?.getLevel() ?? 0;
      const text = `● ${'▁▂▃▄▅▆▇█'[Math.min(7, Math.round(level * 14))]}`;
      this.els.voiceMeter.textContent = text;
      this.els.workspaceVoiceMeter.textContent = text;
    }, 100);
    this.updateWorkspaceVoiceUi();
  }

  private stopAndTranscribeVoice(submit: boolean): void {
    const capture = this.voiceCapture;
    this.clearVoiceLevelTimer();
    this.voiceCapture = null;
    this.voiceTarget = null;
    if (!capture) {
      this.updateVoiceUi();
      return;
    }
    const samples = capture.stop();
    if (!this.attachedTerminalId || samples.length === 0) {
      this.setVoiceStatus('No audio', 2000);
      this.updateVoiceUi();
      return;
    }
    const requestId = this.requestId();
    this.pendingVoiceRequestId = requestId;
    this.pendingVoiceSubmit = submit;
    this.setVoiceStatus('Transcribing…');
    this.updateVoiceUi();
    const sent = this.sendVoiceChunks(requestId, undefined, floatToPcm16(samples), false, 'prompt');
    if (!sent) {
      this.pendingVoiceRequestId = null;
      this.pendingVoiceSubmit = false;
      this.setVoiceStatus('', 0);
      this.updateVoiceUi();
    } else {
      window.setTimeout(() => {
        if (this.pendingVoiceRequestId === requestId) {
          this.pendingVoiceRequestId = null;
          this.pendingVoiceSubmit = false;
          this.setVoiceStatus('Transcription timed out', 2500);
          this.updateVoiceUi();
        }
      }, 30_000);
    }
  }

  private stopAndUseWorkspaceVoice(action: 'launch' | 'edit'): void {
    const capture = this.voiceCapture;
    this.clearVoiceLevelTimer();
    this.voiceCapture = null;
    this.voiceTarget = null;
    if (!capture) {
      this.updateWorkspaceVoiceUi();
      return;
    }
    const samples = capture.stop();
    if (samples.length === 0) {
      this.setWorkspaceVoiceStatus('No audio');
      this.updateWorkspaceVoiceUi();
      return;
    }
    const requestId = this.requestId();
    this.pendingVoiceRequestId = requestId;
    this.pendingWorkspaceVoiceAction = action;
    this.setWorkspaceVoiceStatus(
      action === 'edit' ? 'Transcribing for edit...' : 'Transcribing...'
    );
    this.updateWorkspaceVoiceUi();
    const sent = this.sendVoiceChunks(requestId, undefined, floatToPcm16(samples), false, 'prompt');
    if (!sent) {
      this.pendingVoiceRequestId = null;
      this.pendingWorkspaceVoiceAction = null;
      this.setWorkspaceVoiceStatus('');
      this.updateWorkspaceVoiceUi();
    }
  }

  private handleWorkspaceVoiceTranscript(requestId: string, text: string): void {
    if (requestId !== this.pendingVoiceRequestId || !this.pendingWorkspaceVoiceAction) return;
    const action = this.pendingWorkspaceVoiceAction;
    this.pendingVoiceRequestId = null;
    this.pendingWorkspaceVoiceAction = null;
    this.workspaceVoiceEditsPrompt = false;
    this.setWorkspaceVoiceStatus('');
    this.updateWorkspaceVoiceUi();
    const prompt = text.trim();
    if (action === 'edit' || !prompt) {
      this.openCreateDialog();
      const existingPrompt = this.els.initialPrompt.value.trim();
      this.els.initialPrompt.value = [existingPrompt, prompt].filter(Boolean).join(' ');
      this.els.initialPrompt.focus();
      return;
    }
    this.createWorkspace(prompt);
  }

  private handleVoiceTranscript(requestId: string, text: string): void {
    if (requestId !== this.pendingVoiceRequestId) return;
    if (this.pendingWorkspaceVoiceAction) {
      this.handleWorkspaceVoiceTranscript(requestId, text);
      return;
    }
    this.pendingVoiceRequestId = null;
    this.setVoiceStatus('', 0);
    const transcript = text.trim();
    if (transcript) {
      if (this.pendingVoiceSubmit) {
        this.submitTerminalText(transcript);
      } else {
        this.els.terminalComposer.value = transcript;
        this.els.terminalComposer.focus();
      }
    }
    this.pendingVoiceSubmit = false;
    this.updateVoiceUi();
  }

  // Split the PCM into ordered chunks small enough to clear the transport's ~1 MiB
  // WebSocket message cap, then send them as one reassembled recording. 192 KiB
  // of PCM base64-encodes to ~256 KiB. Boundaries stay 2-byte (Int16) aligned.
  private sendVoiceChunks(
    requestId: string,
    terminalId: string | undefined,
    pcm: Uint8Array,
    enter: boolean,
    purpose: 'terminal' | 'prompt' = 'terminal'
  ): boolean {
    // Each chunk is base64'd into the `audio` field, then the whole app frame
    // is JSON-encoded, encrypted, and base64'd again into the `e2e:enc`
    // envelope. The receiving Peer rejects any wire frame over MAX_FRAME_CHARS
    // (64 KiB), so the chunk must be small enough that the doubly-base64'd
    // envelope stays under that. 32 KiB of PCM lands the envelope around
    // 58 KiB, leaving headroom; 192 KiB blew straight past the cap and made
    // every recording disconnect.
    const CHUNK_BYTES = 32 * 1024;
    const chunkCount = Math.max(1, Math.ceil(pcm.length / CHUNK_BYTES));
    for (let seq = 0; seq < chunkCount; seq++) {
      const start = seq * CHUNK_BYTES;
      const slice = pcm.subarray(start, Math.min(start + CHUNK_BYTES, pcm.length));
      const sent = this.sendRemoteFrame({
        type: 'app:voice:transcribe',
        requestId,
        ...(terminalId ? { terminalId } : {}),
        ...(purpose === 'prompt' ? { purpose } : {}),
        audio: encodeBase64(slice),
        seq,
        final: seq === chunkCount - 1,
        enter,
      });
      if (!sent) return false;
    }
    return true;
  }

  private cancelVoiceRecording(): void {
    this.clearVoiceLevelTimer();
    this.voiceCapture?.cancel();
    this.voiceCapture = null;
    this.voiceTarget = null;
    this.pendingVoiceRequestId = null;
    this.pendingVoiceSubmit = false;
    this.pendingWorkspaceVoiceAction = null;
    this.workspaceVoiceEditsPrompt = false;
    this.setVoiceStatus('', 0);
    this.setWorkspaceVoiceStatus('');
    this.updateVoiceUi();
    this.updateWorkspaceVoiceUi();
  }

  private clearVoiceLevelTimer(): void {
    if (this.voiceLevelTimer !== null) {
      window.clearInterval(this.voiceLevelTimer);
      this.voiceLevelTimer = null;
    }
  }

  private setVoiceStatus(text: string, clearAfterMs = 0): void {
    if (this.voiceStatusTimer !== null) {
      window.clearTimeout(this.voiceStatusTimer);
      this.voiceStatusTimer = null;
    }
    this.els.voiceStatus.textContent = text;
    this.els.voiceStatus.hidden = text.length === 0;
    if (text.length > 0 && clearAfterMs > 0) {
      this.voiceStatusTimer = window.setTimeout(() => {
        this.voiceStatusTimer = null;
        this.els.voiceStatus.textContent = '';
        this.els.voiceStatus.hidden = true;
      }, clearAfterMs);
    }
  }

  private updateVoiceUi(): void {
    const hasTerminal = this.attachedTerminalId !== null;
    const voiceReady = this.voiceAvailable && hasTerminal;
    const terminalRecording = this.isRecordingVoice && this.voiceTarget === 'terminal';
    const panel = this.els.terminalPanel.classList;
    panel.toggle('bar-controls', hasTerminal);
    panel.toggle('bar-keys', hasTerminal && this.terminalKeysOpen && !terminalRecording);
    this.updateMobileKeysFade();
    this.els.voiceBar.hidden = !hasTerminal;
    if (!hasTerminal) return;
    this.els.voiceIdle.hidden = terminalRecording;
    this.els.voiceLive.hidden = !terminalRecording;
    this.els.terminalKeysToggle.setAttribute('aria-pressed', String(this.terminalKeysOpen));
    this.els.terminalKeysToggle.setAttribute(
      'aria-label',
      this.terminalKeysOpen ? 'Hide terminal keys' : 'Show terminal keys'
    );
    const voiceLabel = this.voiceAvailable
      ? 'Start voice dictation'
      : 'Voice dictation requires HTTPS and a downloaded voice model';
    this.els.voiceRecord.disabled =
      !hasTerminal || this.voiceStarting || this.pendingVoiceRequestId !== null;
    this.els.voiceRecord.classList.toggle('available', voiceReady);
    this.els.voiceRecord.title = voiceLabel;
    this.els.voiceRecord.setAttribute('aria-label', voiceLabel);
  }

  private setWorkspaceVoiceStatus(text: string): void {
    this.els.workspaceVoiceStatus.textContent = text;
  }

  private updateWorkspaceVoiceUi(): void {
    const recording = this.isRecordingVoice && this.voiceTarget === 'workspace';
    const pending = this.pendingWorkspaceVoiceAction !== null;
    this.els.voiceCreateWorkspace.hidden = !this.voiceAvailable;
    this.els.promptVoice.hidden = !this.voiceAvailable;
    // A host has no voice model to set up; dictation there needs this computer.
    this.els.promptVoiceUnavailable.hidden =
      !this.voiceAvailabilityKnown || this.voiceAvailable || Boolean(this.endpoint.host);
    const promptRecording = recording && this.workspaceVoiceEditsPrompt;
    this.els.promptVoice.disabled =
      this.voiceStarting || pending || (this.isRecordingVoice && !promptRecording);
    this.els.promptVoice.classList.toggle('recording', promptRecording);
    this.els.promptVoice.setAttribute(
      'aria-label',
      promptRecording ? 'Stop dictation' : 'Dictate workspace prompt'
    );
    this.els.promptVoice.title = promptRecording ? 'Stop dictation' : 'Dictate workspace prompt';
    this.els.voiceCreateWorkspace.disabled = this.voiceStarting || this.isRecordingVoice || pending;
    this.els.workspaceVoice.hidden = !(recording || pending);
    this.els.workspaceVoice.classList.toggle('pending', pending);
    this.els.workspaceVoiceLaunch.disabled = pending;
    this.els.workspaceVoiceLaunch.hidden = this.workspaceVoiceEditsPrompt;
    this.els.workspaceVoiceEdit.disabled = pending;
    this.els.workspaceVoiceEdit.textContent = this.workspaceVoiceEditsPrompt
      ? 'Use transcript'
      : 'Edit';
    this.els.workspaceVoiceCancel.disabled = pending;
    if (!recording && !pending) {
      this.els.workspaceVoiceMeter.textContent = '●';
    } else if (pending) {
      this.els.workspaceVoiceMeter.textContent = '';
    }
  }

  private configureMobileTerminalInput(): void {
    const textarea = this.term.textarea;
    if (!textarea) return;
    textarea.autocomplete = 'off';
    textarea.autocapitalize = 'off';
    textarea.spellcheck = false;
    textarea.inputMode = 'text';
    textarea.enterKeyHint = 'enter';
    textarea.setAttribute('autocorrect', 'off');
  }

  private bindMobileTerminalTouch(): void {
    const scroller = this.els.terminalTouchScroll;
    scroller.addEventListener(
      'touchstart',
      (event) => {
        this.clearTerminalLongPress();
        if (event.touches.length !== 1) {
          this.mobileTerminalTouch = null;
          return;
        }
        const touch = event.touches.item(0);
        if (!touch) return;
        this.stopTerminalFling();
        this.terminalLongPressTimer = window.setTimeout(() => {
          this.terminalLongPressTimer = null;
          const gesture = this.mobileTerminalTouch;
          if (!gesture || gesture.maxMovement > TAP_SLOP_PX) return;
          if (Math.abs(scroller.scrollTop - gesture.startScrollTop) > 1) return;
          this.mobileTerminalTouch = null;
          this.enterTerminalSelection(gesture.startX, gesture.startY);
        }, LONG_PRESS_MS);
        this.mobileTerminalTouch = {
          identifier: touch.identifier,
          startX: touch.clientX,
          startY: touch.clientY,
          startScrollTop: scroller.scrollTop,
          maxMovement: 0,
          wheelY: terminalProgramScrolls(
            this.term.buffer.active.type,
            this.term.modes.mouseTrackingMode
          )
            ? touch.clientY
            : null,
          samples: [{ y: touch.clientY, time: event.timeStamp }],
        };
      },
      { passive: true }
    );
    scroller.addEventListener(
      'touchmove',
      (event) => {
        const gesture = this.mobileTerminalTouch;
        if (!gesture) return;
        const touch = Array.from(event.touches).find(
          (candidate) => candidate.identifier === gesture.identifier
        );
        if (!touch) return;
        gesture.maxMovement = Math.max(
          gesture.maxMovement,
          Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY)
        );
        if (gesture.maxMovement > TAP_SLOP_PX) this.clearTerminalLongPress();
        if (gesture.wheelY !== null) {
          event.preventDefault();
          this.sendTerminalWheel(gesture.wheelY - touch.clientY, touch.clientX, touch.clientY);
          gesture.wheelY = touch.clientY;
          gesture.samples.push({ y: touch.clientY, time: event.timeStamp });
          while (
            gesture.samples.length > 2 &&
            event.timeStamp - gesture.samples[0]!.time > FLING_SAMPLE_MS
          ) {
            gesture.samples.shift();
          }
        }
      },
      { passive: false }
    );
    scroller.addEventListener(
      'touchend',
      (event) => {
        this.clearTerminalLongPress();
        const gesture = this.mobileTerminalTouch;
        this.mobileTerminalTouch = null;
        if (!gesture) return;
        this.mobileUserScrollUntil = performance.now() + USER_SCROLL_SETTLE_MS;
        const touch = Array.from(event.changedTouches).find(
          (candidate) => candidate.identifier === gesture.identifier
        );
        if (!touch) return;
        const movement = Math.max(
          gesture.maxMovement,
          Math.hypot(touch.clientX - gesture.startX, touch.clientY - gesture.startY)
        );
        if (isTerminalTapGesture(movement, scroller.scrollTop - gesture.startScrollTop)) {
          // The click the browser would follow the tap with lands on this overlay and takes
          // focus back off the terminal.
          event.preventDefault();
          this.handleTerminalTap(touch.clientX, touch.clientY);
          return;
        }
        const first = gesture.samples[0];
        const elapsed = first ? event.timeStamp - first.time : 0;
        if (gesture.wheelY !== null && first && elapsed > 0 && elapsed <= FLING_SAMPLE_MS * 2) {
          const velocity = (touch.clientY - first.y) / elapsed;
          if (Math.abs(velocity) >= FLING_START_VELOCITY) {
            this.startTerminalFling(velocity, touch.clientX, touch.clientY);
          }
        }
      },
      { passive: false }
    );
    scroller.addEventListener('touchcancel', () => {
      this.clearTerminalLongPress();
      this.mobileTerminalTouch = null;
    });
  }

  private clearTerminalLongPress(): void {
    if (this.terminalLongPressTimer === null) return;
    window.clearTimeout(this.terminalLongPressTimer);
    this.terminalLongPressTimer = null;
  }

  /**
   * A tap opens the link under it. Otherwise it closes the keyboard when one is up, or opens it
   * for typing straight into the terminal.
   */
  private handleTerminalTap(clientX: number, clientY: number): void {
    if (this.openTerminalLinkAt(clientX, clientY)) return;
    if (this.closeTerminalKeyboard()) return;
    this.term.focus();
  }

  /** Blurs whichever of the terminal and the composer has the keyboard up; false when neither. */
  private closeTerminalKeyboard(): boolean {
    for (const field of [this.term.textarea, this.els.terminalComposer]) {
      if (field && document.activeElement === field) {
        field.blur();
        return true;
      }
    }
    return false;
  }

  /** Plain web addresses become links, as on the desktop, and so do OSC 8 hyperlinks. */
  private bindTerminalLinks(): void {
    this.term.options.linkHandler = {
      activate: (_event, uri) => this.openTerminalUrl(uri),
    };
    this.term.registerLinkProvider({
      provideLinks: (y, callback) => {
        const line = readTerminalLogicalLine(this.term.buffer.active, y);
        const links = terminalUrls(line.text).flatMap(({ index, url }) => {
          const start = line.cells[index];
          const end = line.cells[index + url.length - 1];
          if (!start || !end) return [];
          return [{ text: url, range: { start, end }, activate: () => this.openTerminalUrl(url) }];
        });
        callback(links.length > 0 ? links : undefined);
      },
    });
  }

  private openTerminalUrl(url: string): void {
    if (!/^https?:\/\//i.test(url)) return;
    this.terminalLinkOpened = true;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  /**
   * Opens the link at a tapped point. xterm finds links from mouse hovers and opens one on a
   * click, and a touch gives it neither, so the tap replays them on the screen element alone:
   * without bubbling, they reach neither xterm's selection nor a program's mouse reports.
   */
  private openTerminalLinkAt(clientX: number, clientY: number): boolean {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen || this.term.rows <= 0) return false;
    const rect = screen.getBoundingClientRect();
    if (
      clientX < rect.left ||
      clientX >= rect.right ||
      clientY < rect.top ||
      clientY >= rect.bottom
    )
      return false;
    const rowHeight = rect.height / this.term.rows;
    // xterm ignores a hover that stays in the cell it last asked about, so hover the next row first.
    const primeY = clientY - rect.top >= rowHeight ? clientY - rowHeight : clientY + rowHeight;
    const mouse = (type: string, y: number) =>
      screen.dispatchEvent(
        new MouseEvent(type, { clientX, clientY: y, button: 0, bubbles: false, cancelable: true })
      );
    this.terminalLinkOpened = false;
    mouse('mousemove', primeY);
    mouse('mousemove', clientY);
    mouse('mousedown', clientY);
    mouse('mouseup', clientY);
    mouse('mouseleave', clientY);
    return this.terminalLinkOpened;
  }

  private bindTerminalSelection(): void {
    document.addEventListener('selectionchange', () => {
      if (!this.terminalSelection) return;
      const text = this.selectedTerminalText();
      if (this.terminalSelectionEmptyTimer !== null) {
        window.clearTimeout(this.terminalSelectionEmptyTimer);
        this.terminalSelectionEmptyTimer = null;
      }
      if (text) {
        this.terminalSelectedText = text;
        return;
      }
      // Select mode lasts as long as a selection does.
      this.terminalSelectionEmptyTimer = window.setTimeout(() => {
        this.terminalSelectionEmptyTimer = null;
        if (!this.selectedTerminalText()) this.exitTerminalSelection();
      }, SELECTION_EMPTY_EXIT_MS);
    });
    // The browser's own Copy, from its menu: wrapped rows go to the clipboard as one line.
    document.addEventListener('copy', (event) => {
      if (!this.terminalSelection) return;
      const text = this.selectedTerminalText();
      if (!text || !event.clipboardData) return;
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      window.setTimeout(() => this.exitTerminalSelection(), 0);
    });
    for (const button of [this.els.terminalCopy, this.els.terminalSelectDone]) {
      // Keeps the selection while the button is pressed.
      button.addEventListener('pointerdown', (event) => event.preventDefault());
    }
    this.els.terminalCopy.addEventListener('click', () => void this.copyTerminalSelection());
    this.els.terminalSelectDone.addEventListener('click', () => this.exitTerminalSelection());
  }

  /**
   * Freezes the buffer into plain text laid exactly over the terminal and selects the word under
   * the finger, so the browser's own selection (handles, loupe, menu) takes it from there: xterm
   * has no touch selection, and rebuilds its rows on every write.
   */
  private enterTerminalSelection(clientX: number, clientY: number): void {
    const screen = this.term.element?.querySelector<HTMLElement>('.xterm-screen');
    const rows = this.term.element?.querySelector<HTMLElement>('.xterm-rows');
    if (!screen || !rows || this.term.rows <= 0 || this.term.cols <= 0) return;
    this.closeTerminalKeyboard();
    const screenRect = screen.getBoundingClientRect();
    const hostRect = this.els.terminalHost.getBoundingClientRect();
    const rowHeight = screenRect.height / this.term.rows;
    const cellWidth = screenRect.width / this.term.cols;
    const style = getComputedStyle(rows);
    const text = this.els.terminalSelectText;
    text.style.fontFamily = style.fontFamily;
    text.style.fontSize = style.fontSize;
    text.style.fontWeight = style.fontWeight;
    text.style.lineHeight = `${rowHeight}px`;
    text.style.letterSpacing = `${cellWidth - monospaceAdvance(style)}px`;
    text.style.padding = `${screenRect.top - hostRect.top}px 0 ${rowHeight}px ${
      screenRect.left - hostRect.left
    }px`;
    const selection = terminalSelectionText(this.term.buffer.active);
    text.textContent = selection.text;
    this.terminalSelection = selection;
    this.terminalSelectedText = '';
    this.els.terminalSelect.hidden = false;
    this.els.terminalSelect.scrollTop = this.term.buffer.active.viewportY * rowHeight;
    if (!this.selectTerminalWordAt(clientX, clientY)) {
      // Nothing under the finger: no select mode without a selection.
      this.exitTerminalSelection();
      return;
    }
    this.els.terminalPanel.classList.add('selecting');
  }

  private selectTerminalWordAt(clientX: number, clientY: number): boolean {
    const node = this.els.terminalSelectText.firstChild;
    const info = this.terminalSelection;
    if (!(node instanceof Text) || !info) return false;
    const caret = caretAtPoint(clientX, clientY);
    if (!caret || caret.node !== node) return false;
    // A caret lands between characters (after one when past its middle) or at the end of the
    // nearest row, so take the character actually under the finger, if any.
    const under = [caret.offset, caret.offset - 1].find((offset) => {
      if (offset < 0 || offset >= node.length) return false;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const rect = range.getBoundingClientRect();
      return clientX >= rect.left && clientX < rect.right;
    });
    const word = under === undefined ? undefined : terminalWordAt(node.data, under, info.softWraps);
    if (!word) return false;
    const range = document.createRange();
    range.setStart(node, word.start);
    range.setEnd(node, word.end);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    this.terminalSelectedText = joinSoftWraps(
      node.data.slice(word.start, word.end),
      word.start,
      info.softWraps
    );
    return true;
  }

  /** What is selected in the frozen text, with wrapped rows joined back into their lines. */
  private selectedTerminalText(): string {
    const info = this.terminalSelection;
    const node = this.els.terminalSelectText.firstChild;
    const selection = window.getSelection();
    if (!info || !(node instanceof Text) || !selection || selection.isCollapsed) return '';
    if (selection.rangeCount === 0) return '';
    const range = selection.getRangeAt(0);
    if (!range.intersectsNode(node)) return '';
    const start = range.startContainer === node ? range.startOffset : 0;
    const end = range.endContainer === node ? range.endOffset : node.length;
    return joinSoftWraps(node.data.slice(start, end), start, info.softWraps);
  }

  private async copyTerminalSelection(): Promise<void> {
    const text = this.selectedTerminalText() || this.terminalSelectedText;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.showRemoteNotice('Copied', 1500);
    } catch {
      this.showRemoteNotice('Could not copy. Use the Copy in the selection menu instead.');
      return;
    }
    this.exitTerminalSelection();
  }

  private exitTerminalSelection(): void {
    if (this.terminalSelectionEmptyTimer !== null) {
      window.clearTimeout(this.terminalSelectionEmptyTimer);
      this.terminalSelectionEmptyTimer = null;
    }
    if (!this.terminalSelection) return;
    this.terminalSelection = null;
    this.terminalSelectedText = '';
    const selection = window.getSelection();
    if (selection?.anchorNode && this.els.terminalSelect.contains(selection.anchorNode)) {
      selection.removeAllRanges();
    }
    this.els.terminalSelect.hidden = true;
    this.els.terminalSelectText.textContent = '';
    this.els.terminalPanel.classList.remove('selecting');
  }

  /**
   * Hands a drag to xterm's own wheel handling, as a trackpad's pixel deltas, so the program gets
   * what a desktop wheel would send it: mouse reports in its encoding, or arrow keys on the
   * alternate screen.
   */
  private sendTerminalWheel(
    deltaY: number,
    clientX: number,
    clientY: number,
    deltaMode: number = WheelEvent.DOM_DELTA_PIXEL
  ): void {
    if (deltaY === 0) return;
    this.term.element?.querySelector('.xterm-screen')?.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY,
        deltaMode,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
      })
    );
  }

  /** Keeps a flick on a fullscreen program going after the finger lifts, slowing to a stop. */
  private startTerminalFling(velocity: number, clientX: number, clientY: number): void {
    this.stopTerminalFling();
    let current = velocity;
    let lastTime = 0;
    const frame = (time: number) => {
      const elapsed = lastTime ? Math.min(time - lastTime, 50) : 16;
      lastTime = time;
      const step = flingStep(current, elapsed);
      this.sendTerminalWheel(-step.distance, clientX, clientY);
      current = step.velocity;
      this.terminalFlingFrame = current === 0 ? null : requestAnimationFrame(frame);
    };
    this.terminalFlingFrame = requestAnimationFrame(frame);
  }

  private stopTerminalFling(): void {
    if (this.terminalFlingFrame !== null) cancelAnimationFrame(this.terminalFlingFrame);
    this.terminalFlingFrame = null;
  }

  private terminalProgramScrolls(): boolean {
    return terminalProgramScrolls(this.term.buffer.active.type, this.term.modes.mouseTrackingMode);
  }

  /**
   * The rail on the terminal's right edge. Over scrollback its thumb drags to a position, and a
   * tap on the track jumps there. A fullscreen program keeps its own position, so its thumb rests
   * mid-rail and scrolls it while pulled up or down, faster the further it goes.
   */
  private bindScrollRail(): void {
    const rail = this.els.terminalScrollIndicator;
    rail.addEventListener('pointerdown', (event) => {
      if (this.scrollRailDrag || !event.isPrimary) return;
      event.preventDefault();
      this.stopTerminalFling();
      rail.setPointerCapture(event.pointerId);
      const thumb = this.els.terminalScrollThumb.getBoundingClientRect();
      const onThumb = event.clientY >= thumb.top && event.clientY <= thumb.bottom;
      this.scrollRailDrag = {
        pointerId: event.pointerId,
        startY: event.clientY,
        grabOffset: onThumb ? event.clientY - thumb.top : thumb.height / 2,
        programScrolls: this.terminalProgramScrolls(),
        displacement: 0,
        pendingSteps: 0,
        lastFrameTime: 0,
        frame: null,
      };
      rail.classList.add('dragging');
      if (!this.scrollRailDrag.programScrolls) this.dragScrollRailTo(event.clientY);
    });
    rail.addEventListener('pointermove', (event) => {
      const drag = this.scrollRailDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.programScrolls) {
        this.dragScrollRailTo(event.clientY);
        return;
      }
      const reach = Math.max(
        0,
        (rail.clientHeight - this.els.terminalScrollThumb.offsetHeight) / 2
      );
      drag.displacement = Math.max(-reach, Math.min(reach, event.clientY - drag.startY));
      if (drag.frame === null && railWheelRate(drag.displacement) !== 0) {
        drag.frame = requestAnimationFrame(this.runScrollRail);
      }
      this.syncMobileTouchScroller();
    });
    const end = (event: PointerEvent) => {
      const drag = this.scrollRailDrag;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.frame !== null) cancelAnimationFrame(drag.frame);
      this.scrollRailDrag = null;
      rail.classList.remove('dragging');
      this.syncMobileTouchScroller();
    };
    rail.addEventListener('pointerup', end);
    rail.addEventListener('pointercancel', end);
    rail.addEventListener('lostpointercapture', end);
  }

  private dragScrollRailTo(clientY: number): void {
    const drag = this.scrollRailDrag;
    if (!drag) return;
    const rail = this.els.terminalScrollIndicator.getBoundingClientRect();
    this.term.scrollToLine(
      scrollThumbLine(
        clientY - rail.top,
        drag.grabOffset,
        rail.height,
        this.els.terminalScrollThumb.offsetHeight,
        this.term.buffer.active.baseY
      )
    );
    this.els.terminalJumpLatest.hidden = this.isTerminalAtBottom();
  }

  /** Sends a pulled rail's wheel steps, one notch at a time, at the pace the pull sets. */
  private readonly runScrollRail = (time: number): void => {
    const drag = this.scrollRailDrag;
    if (!drag) return;
    const rate = railWheelRate(drag.displacement);
    const elapsed = drag.lastFrameTime ? Math.min(time - drag.lastFrameTime, 100) : 16;
    drag.lastFrameTime = time;
    drag.pendingSteps += (rate * elapsed) / 1000;
    const steps = Math.trunc(drag.pendingSteps);
    drag.pendingSteps -= steps;
    const screen = this.term.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
    if (screen) {
      for (let i = 0; i < Math.abs(steps); i++) {
        this.sendTerminalWheel(
          Math.sign(steps),
          screen.left + screen.width / 2,
          screen.top + screen.height / 2,
          WheelEvent.DOM_DELTA_LINE
        );
      }
    }
    if (rate === 0) {
      drag.frame = null;
      drag.lastFrameTime = 0;
      drag.pendingSteps = 0;
    } else {
      drag.frame = requestAnimationFrame(this.runScrollRail);
    }
  };

  private bindMobileKeyboardBar(): void {
    for (const button of this.els.mobileKeyboardBar.querySelectorAll<HTMLButtonElement>(
      'button[data-terminal-key]'
    )) {
      const data = MOBILE_TERMINAL_KEYS[button.dataset.terminalKey ?? ''] ?? '';
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        this.sendTerminalInput(data);
      });
      button.addEventListener('click', (event) => event.preventDefault());
    }
    for (const button of this.els.mobileKeyboardBar.querySelectorAll<HTMLButtonElement>(
      'button[data-terminal-modifier]'
    )) {
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        const modifier = button.dataset.terminalModifier;
        if (modifier === 'ctrl') this.ctrlLatched = !this.ctrlLatched;
        if (modifier === 'alt') this.altLatched = !this.altLatched;
        this.updateModifierButtons();
      });
      button.addEventListener('click', (event) => event.preventDefault());
    }
    this.els.mobileKeys.addEventListener('scroll', () => this.updateMobileKeysFade(), {
      passive: true,
    });
    this.updateMobileKeysFade();
  }

  /** Fades the keys out at an edge only while more of them sit past it. */
  private updateMobileKeysFade(): void {
    const keys = this.els.mobileKeys;
    const slack = 4;
    keys.classList.toggle('more-before', keys.scrollLeft > slack);
    keys.classList.toggle(
      'more-after',
      keys.scrollLeft < keys.scrollWidth - keys.clientWidth - slack
    );
  }

  private applyLatchedModifiers(data: string): string {
    if (!this.ctrlLatched && !this.altLatched) return data;
    const modified = applyTerminalModifiers(data, this.ctrlLatched, this.altLatched);
    this.ctrlLatched = false;
    this.altLatched = false;
    this.updateModifierButtons();
    return modified;
  }

  private updateModifierButtons(): void {
    for (const button of this.els.mobileKeyboardBar.querySelectorAll<HTMLButtonElement>(
      'button[data-terminal-modifier]'
    )) {
      const pressed =
        button.dataset.terminalModifier === 'ctrl' ? this.ctrlLatched : this.altLatched;
      button.setAttribute('aria-pressed', String(pressed));
    }
  }

  private bindVisualViewport(): void {
    this.updateVisualViewportSize();
    window.visualViewport?.addEventListener('resize', () => this.updateVisualViewportSize());
    window.visualViewport?.addEventListener('scroll', () => this.updateVisualViewportSize());
    window.addEventListener('orientationchange', () => this.fitAfterLayout());
  }

  private updateVisualViewportSize(): void {
    const viewport = window.visualViewport;
    const height = viewport?.height ?? window.innerHeight;
    const offsetTop = viewport?.offsetTop ?? 0;
    document.documentElement.style.setProperty('--remote-viewport-height', `${height}px`);
    document.documentElement.style.setProperty('--remote-viewport-top', `${offsetTop}px`);
    this.fitAfterLayout();
  }

  private ensureConnected(): boolean {
    if (!this.disconnected && this.peer.state === 'established') return true;
    this.markDisconnected();
    return false;
  }

  private sendRemoteFrame(
    frame: RemoteAppFrame,
    pending?: { requestId?: string; workspaceId?: string }
  ): boolean {
    if (!this.ensureConnected()) {
      this.clearFailedSend(pending);
      return false;
    }
    void this.peer.sendEncryptedJson(frame).catch((err) => this.sendFailed(err, pending));
    return true;
  }

  private sendFailed(err: unknown, pending?: { requestId?: string; workspaceId?: string }): void {
    console.warn('Remote send failed', err);
    this.clearFailedSend(pending);
    // Refused before sending: only this request failed, the connection is fine.
    if (err instanceof FrameTooLargeError) {
      this.showRemoteNotice('That is too long to send from this phone.');
      return;
    }
    this.markDisconnected();
  }

  private clearFailedSend(pending?: { requestId?: string; workspaceId?: string }): void {
    if (pending?.requestId) {
      const timer = this.pendingRequestTimers.get(pending.requestId);
      if (timer !== undefined) window.clearTimeout(timer);
      this.pendingRequestTimers.delete(pending.requestId);
      this.pendingRequestWorkspaces.delete(pending.requestId);
    }
    if (pending?.requestId === this.pendingCreateRequestId) {
      this.pendingCreateRequestId = null;
      this.pendingCreateWorkspace = null;
    }
    if (pending?.workspaceId) this.pendingWorkspaceMessages.delete(pending.workspaceId);
    this.pendingAttachWorkspaceId = null;
    this.setCreateWorkspacePending(false);
    this.clearTerminalLoading();
    this.renderWorkspaces();
    this.renderTerminalToolbar();
  }

  /** `replaced`: a newer sign-in took the session, so this page must not reconnect. */
  private markDisconnected(replaced = false): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.watchdog?.stop();
    this.els.connectionPill.classList.add('offline');
    this.els.connectionLabel.textContent = replaced ? 'Open elsewhere' : 'Reconnecting';
    this.cancelVoiceRecording();
    this.clearWorkspaceRefreshTimer();
    this.pendingAttachWorkspaceId = null;
    this.pendingTerminalSnapshot = null;
    this.pendingCreateRequestId = null;
    this.pendingCreateWorkspace = null;
    for (const timer of this.pendingRequestTimers.values()) {
      window.clearTimeout(timer);
    }
    this.pendingRequestTimers.clear();
    this.pendingRequestWorkspaces.clear();
    this.pendingWorkspaceMessages.clear();
    this.workspacePages.clear();
    this.setCreateWorkspacePending(false);
    this.clearTerminalLoading();
    this.renderWorkspaces();
    this.renderTerminalToolbar();
    if (replaced) {
      this.showRemoteNotice(REPLACED_MESSAGE, 0);
      return;
    }
    // The terminal keeps its screen, so a reconnect can continue it where it stopped.
    this.reconnectLoop.start();
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function option(
  value: string,
  label: string,
  selectedValue: string,
  color?: string
): HTMLOptionElement {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  el.selected = value === selectedValue;
  if (color) el.dataset.color = color;
  return el;
}

function selectValueToLaunchModeId(value: string): string | null {
  return value ? value : null;
}

function launchModeIdToSelectValue(value: string | null | undefined): string {
  return value ?? '';
}

interface OpenTarget {
  workspaceId: string;
  terminalId?: string;
}

const OPEN_TARGET_ID = /^[A-Za-z0-9_-]{1,128}$/;

function parseOpenTarget(value: unknown): OpenTarget | null {
  if (!value || typeof value !== 'object') return null;
  const { type, workspaceId, terminalId } = value as Record<string, unknown>;
  if (type !== undefined && type !== 'komla:open-workspace') return null;
  if (typeof workspaceId !== 'string' || !OPEN_TARGET_ID.test(workspaceId)) return null;
  return {
    workspaceId,
    ...(typeof terminalId === 'string' && OPEN_TARGET_ID.test(terminalId) ? { terminalId } : {}),
  };
}

/** A notification opens `/remote/?workspace=…&terminal=…`; take the target and tidy the URL. */
function takeOpenTargetFromUrl(): OpenTarget | null {
  const params = new URLSearchParams(location.search);
  const target = parseOpenTarget({
    workspaceId: params.get('workspace') ?? undefined,
    terminalId: params.get('terminal') ?? undefined,
  });
  if (params.has('workspace') || params.has('terminal')) {
    history.replaceState(null, '', location.pathname);
  }
  return target;
}

function pushTestNote(outcome: 'delivered' | 'gone' | 'failed' | 'not-subscribed'): string {
  switch (outcome) {
    case 'delivered':
      return 'Test sent. It should arrive in a moment.';
    case 'gone':
      return 'This browser dropped its subscription. Turn notifications on again.';
    case 'not-subscribed':
      return 'Notifications are off for this device.';
    default:
      return "The push service didn't accept the test. Check this computer's internet connection.";
  }
}

function readCollapsedSections(): Set<WorkspaceSectionId> {
  try {
    return parseCollapsedSections(
      localStorage.getItem(REMOTE_COLLAPSED_SECTIONS_KEY),
      localStorage.getItem(REMOTE_LEGACY_COLLAPSED_SECTIONS_KEY)
    );
  } catch {
    // Unreadable storage falls back to the default.
    return parseCollapsedSections(null, null);
  }
}

function writeCollapsedSections(sections: Set<WorkspaceSectionId>): void {
  try {
    localStorage.setItem(REMOTE_COLLAPSED_SECTIONS_KEY, JSON.stringify([...sections]));
  } catch {
    // best-effort
  }
}

function readLaunchPreferences(): LaunchPreferences {
  try {
    const raw = localStorage.getItem(REMOTE_LAUNCH_PREFERENCES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<LaunchPreferences>;
    return {
      ...(typeof parsed.projectId === 'string' ? { projectId: parsed.projectId } : {}),
      ...(typeof parsed.presetId === 'string' ? { presetId: parsed.presetId } : {}),
      ...(typeof parsed.launchModeId === 'string' || parsed.launchModeId === null
        ? { launchModeId: parsed.launchModeId }
        : {}),
      ...(typeof parsed.environment === 'string' ? { environment: parsed.environment } : {}),
    };
  } catch {
    return {};
  }
}

function writeLaunchPreferences(preferences: LaunchPreferences): void {
  try {
    localStorage.setItem(REMOTE_LAUNCH_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // best-effort
  }
}

/**
 * One grant per endpoint, so switching between the desktop and a host keeps both. Kept in
 * localStorage so a Home Screen app the system closed comes back without its passkey; the grant
 * is useless without this browser's installation key.
 */
function resumeGrantKey(fingerprint: string): string {
  return `${REMOTE_RESUME_GRANT_KEY}.${fingerprint}`;
}

function readResumeGrant(fingerprint: string, deviceId: string): StoredResumeGrant | null {
  try {
    const raw = localStorage.getItem(resumeGrantKey(fingerprint));
    if (!raw) return null;
    const grant = JSON.parse(raw) as Partial<StoredResumeGrant>;
    if (
      grant.fingerprint !== fingerprint ||
      grant.deviceId !== deviceId ||
      typeof grant.token !== 'string' ||
      typeof grant.expiresAt !== 'number' ||
      grant.expiresAt <= Date.now()
    ) {
      localStorage.removeItem(resumeGrantKey(fingerprint));
      return null;
    }
    return grant as StoredResumeGrant;
  } catch {
    return null;
  }
}

function writeResumeGrant(grant: StoredResumeGrant): void {
  try {
    localStorage.setItem(resumeGrantKey(grant.fingerprint), JSON.stringify(grant));
  } catch {
    // A missing resumption grant falls back to the full passkey ceremony.
  }
}

function clearResumeGrant(fingerprint: string): void {
  try {
    localStorage.removeItem(resumeGrantKey(fingerprint));
  } catch {
    // best-effort
  }
}

function sortWorkspaces(workspaces: RemoteWorkspaceSummary[]): RemoteWorkspaceSummary[] {
  return [...workspaces].sort(
    (a, b) => (b.lastActivityAt ?? b.createdAt ?? 0) - (a.lastActivityAt ?? a.createdAt ?? 0)
  );
}

function resetPageReconnectAttempts(): void {
  try {
    sessionStorage.removeItem(REMOTE_RECONNECT_ATTEMPT_KEY);
  } catch {
    // best-effort
  }
}

function nextPageReconnectDelay(): number {
  try {
    const attempt = Number.parseInt(
      sessionStorage.getItem(REMOTE_RECONNECT_ATTEMPT_KEY) ?? '0',
      10
    );
    const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? attempt : 0;
    sessionStorage.setItem(REMOTE_RECONNECT_ATTEMPT_KEY, String(safeAttempt + 1));
    return reconnectDelayMs(safeAttempt);
  } catch {
    return reconnectDelayMs(0);
  }
}

function formatSeconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function scheduleAuthReconnect(els: UI, message = 'Reconnecting'): void {
  const reconnectDelay = nextPageReconnectDelay();
  setStatus(els.status, 'connecting', `${message} in ${formatSeconds(reconnectDelay)}…`);
  scheduleReconnect(reconnectDelay);
}

function formatRelativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'now';
  if (diff < hour) return `${Math.floor(diff / minute)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  return `${Math.floor(diff / day)}d`;
}

type RemoteWorkspaceAttention = NonNullable<RemoteWorkspaceSummary['attention']>;

function attentionClassName(kind: RemoteWorkspaceAttention['kind']): string {
  switch (kind) {
    case 'input-required':
      return 'attention-input';
    case 'turn-complete':
      return 'attention-done';
    case 'error':
      return 'attention-error';
    case 'idle':
      return 'attention-idle';
    default:
      return 'attention-generic';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Entry — dispatch on URL fragment.
// ────────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  const els = ui();
  registerServiceWorker();
  await loadDirectRemoteConfig();
  const hostId = selectedHostId(location.href);
  // A plain launch reopens the SSH host this app last used; links and pairing keep their endpoint.
  if (!hostId && !location.search && !location.hash) {
    const lastHostId = startingHostId(
      localStorage,
      readDirectRemoteConfig()?.fingerprint ?? rememberedDesktopFingerprint(localStorage)
    );
    if (lastHostId) {
      location.replace(endpointHref(location.href, lastHostId));
      return;
    }
  }
  if (hostId) {
    // An SSH host works without the desktop, so it doesn't wait for /remote/config.
    await runAuthFlow(els, hostId);
    return;
  }
  if (directRemoteUnreachable) {
    els.title.textContent = 'Komla';
    els.subtitle.textContent =
      "Can't reach your Komla desktop. Check that Komla is open and this phone is on your tailnet.";
    showOfflineHosts(els);
    scheduleAuthReconnect(els, 'Retrying');
    return;
  }
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  const hasFragment = hash.length > 0;
  if (hasFragment) {
    await runRegisterFlow(els);
    return;
  }
  await runAuthFlow(els);
}

// ────────────────────────────────────────────────────────────────────────
// Registration flow (URL has `#fp=…`)
// ────────────────────────────────────────────────────────────────────────

async function runRegisterFlow(els: UI): Promise<void> {
  els.title.textContent = 'Pair a new device';
  els.subtitle.textContent =
    'Trust this browser for this Komla desktop. The one-time QR secret, this browser key, and your passkey are all required.';
  els.fingerprintRow.hidden = false;
  els.label.value = deriveDefaultDeviceLabel(navigator.userAgent);

  let parsed: ReturnType<typeof parsePairUrl>;
  try {
    parsed = parsePairUrl(location.href);
  } catch (err) {
    if (err instanceof PairUrlError) {
      setStatus(els.status, 'error', 'Bad pair URL');
      showError(els, err.message);
    } else {
      setStatus(els.status, 'error', 'Bad URL');
      showError(els, (err as Error).message);
    }
    return;
  }

  els.fingerprint.textContent = shortFp(parsed.fingerprint);
  els.fingerprint.title = parsed.fingerprint;
  const direct = readDirectRemoteConfig();
  if (!direct || direct.fingerprint !== parsed.fingerprint) {
    setStatus(els.status, 'error', 'Direct remote unavailable');
    showError(els, 'Open the one-time QR URL served by your Komla desktop.');
    return;
  }
  offerHomeScreenHandoff(els);
  let pendingDevice: PendingDeviceIdentity;
  let previousDeviceIdentity: StoredDeviceIdentity | null = null;
  try {
    const enrollmentDevice = await loadOrCreateEnrollmentDeviceIdentity(parsed.fingerprint);
    pendingDevice = enrollmentDevice.identity;
    previousDeviceIdentity = enrollmentDevice.previousIdentity;
  } catch (err) {
    setStatus(els.status, 'error', 'Could not create device identity');
    showError(els, (err as Error).message);
    return;
  }
  setStatus(els.status, 'connecting', 'Connecting to desktop…');

  const ws = new WebSocket(socketUrlForFingerprint(parsed.fingerprint));

  const peer = new Peer({
    role: 'client',
    expectedFingerprint: parsed.fingerprint,
    transport: {
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
    },
  });

  let pendingChallenge: PairRegistrationChallenge | null = null;
  let stagedIdentity: StoredDeviceIdentity | null = null;
  let terminalFrameProcessed = false;

  peer.onMessage((msg) => {
    if (msg.kind !== 'json') {
      showError(els, 'Desktop sent an unexpected binary frame.');
      return;
    }
    const frame = parsePairFrame(msg.data);
    if (!frame) {
      if (!terminalFrameProcessed) showError(els, 'Desktop sent an unrecognised frame.');
      return;
    }
    void handleFrame(frame);
  });

  async function handleFrame(frame: PairFrame): Promise<void> {
    if (frame.type === 'pair:registration-challenge') {
      pendingChallenge = frame;
      try {
        await runRegistration(peer, frame, els, pendingDevice, (identity) => {
          stagedIdentity = identity;
        });
      } catch (err) {
        showError(els, (err as Error).message);
        setStatus(els.status, 'error', 'Pair failed');
        ws.close(1000, 'browser-aborted');
      }
      return;
    }
    if (frame.type === 'pair:registered') {
      terminalFrameProcessed = true;
      if (frame.deviceId !== pendingDevice.deviceId) {
        showError(els, 'Desktop registered a different browser installation key.');
        ws.close(1000, 'device-id-mismatch');
        return;
      }
      if (!stagedIdentity || frame.credentialId !== stagedIdentity.credentialId) {
        showError(els, 'Desktop registered a different passkey credential.');
        ws.close(1000, 'credential-id-mismatch');
        return;
      }
      setStatus(els.status, 'registered', 'Paired');
      els.form.hidden = true;
      els.register.hidden = true;
      showSuccess(
        els,
        `${frame.label} is paired. Continue with your passkey to open Komla Remote.`
      );
      ws.close(1000, 'ceremony-complete');
      location.assign(`${location.origin}/remote/`);
      return;
    }
    if (frame.type === 'pair:rejected') {
      terminalFrameProcessed = true;
      await discardRejectedEnrollmentIdentity(stagedIdentity, previousDeviceIdentity);
      setStatus(els.status, 'error', `Pair rejected (${frame.reason})`);
      showError(els, frame.message);
      ws.close(1000, 'ceremony-complete');
      return;
    }
    showError(els, `Unexpected frame from desktop: ${frame.type}`);
  }

  ws.addEventListener('message', (evt) => {
    handleSocketMessage(evt, ws, peer);
  });

  ws.addEventListener('close', (evt) => {
    const wasReady = peer.state === 'established';
    afterPeerClosed(peer, evt, () => {
      const reason = evt.reason ?? '';
      if (terminalFrameProcessed || reason === 'browser-aborted') return;
      if (wasReady && (evt.code === 1000 || evt.code === 1001)) {
        setStatus(els.status, 'idle', 'Disconnected');
      } else {
        setStatus(els.status, 'error', 'Disconnected');
        showError(els, reason ? `Closed: ${evt.code} ${reason}` : `Closed: ${evt.code}`);
      }
      els.register.disabled = true;
    });
  });

  ws.addEventListener('error', () => {
    peer.handleError(new Error('socket error'));
  });

  peer.onEstablished(() => {
    setStatus(els.status, 'ready', 'Ready to pair');
    els.form.hidden = false;
    els.register.hidden = false;
    els.register.disabled = false;
    els.label.focus();
  });

  ws.addEventListener('open', () => {
    void peer.connect().catch((err) => {
      setStatus(els.status, 'error', 'Handshake failed');
      showError(els, (err as Error).message);
    });
  });

  els.register.addEventListener('click', () => {
    if (peer.state !== 'established') return;
    if (pendingChallenge) return; // double-click
    const labelText = els.label.value.trim();
    if (labelText.length === 0) {
      showError(els, 'Device name is required.');
      els.label.focus();
      return;
    }
    els.register.disabled = true;
    els.error.hidden = true;
    setStatus(els.status, 'verifying', 'Sending pair request…');
    void peer
      .sendEncryptedJson({
        type: 'pair:hello',
        protocolVersion: PAIR_PROTOCOL_VERSION,
        mode: 'register',
        pairingSecret: parsed.pairingSecret,
        proposedLabel: labelText,
        devicePublicKey: pendingDevice.devicePublicKey,
      })
      .catch((err) => {
        showError(els, `Send failed: ${(err as Error).message}`);
        els.register.disabled = false;
      });
  });
}

async function runRegistration(
  peer: Peer,
  challenge: PairRegistrationChallenge,
  els: UI,
  pendingDevice: PendingDeviceIdentity,
  onIdentityStaged: (identity: StoredDeviceIdentity) => void
): Promise<void> {
  if (typeof window.PublicKeyCredential === 'undefined' || !navigator.credentials?.create) {
    throw new Error("This browser doesn't support WebAuthn passkeys.");
  }
  if (challenge.origin !== location.origin) {
    throw new Error(
      `Pair URL origin mismatch (page is ${location.origin}, desktop expected ${challenge.origin}).`
    );
  }
  // The passkey account handle is the browser-installation id, not the stable
  // desktop fingerprint. Keep the passkey and device key bound to the same
  // trusted remote device.
  const userIdBytes = base64UrlToBytes(challenge.user.id);
  const deviceIdInChallenge = userHandleToFingerprint(userIdBytes);
  if (deviceIdInChallenge !== pendingDevice.deviceId) {
    throw new Error('Desktop sent a registration challenge for a different browser installation.');
  }
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: base64UrlToBytes(challenge.challenge),
    rp: { id: challenge.rpId, name: challenge.rpName },
    user: {
      id: userIdBytes,
      name: challenge.user.name,
      displayName: challenge.user.displayName,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'required',
    },
    attestation: 'none',
    excludeCredentials: challenge.excludeCredentialIds.map((id) => ({
      type: 'public-key',
      id: base64UrlToBytes(id),
    })),
    timeout: 60_000,
  };
  setStatus(els.status, 'verifying', 'Waiting for biometric…');
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error('Authenticator returned no credential.');
  const deviceSignature = await signDeviceProof(
    pendingDevice.privateKey,
    buildDeviceProof('register', challenge.challenge, peer.getChannelBinding())
  );
  // Stage the non-exportable key and its passkey id before the desktop can
  // commit registration. If the success acknowledgement is lost, reconnect
  // can still use the exact credentials the desktop persisted.
  await stageEnrollmentDeviceIdentity(pendingDevice, cred.id, onIdentityStaged);
  await peer.sendEncryptedJson({
    type: 'pair:registration-response',
    attestationResponse: attestationToJSON(cred),
    deviceSignature: encodeBase64(deviceSignature),
  });
  setStatus(els.status, 'verifying', 'Verifying with desktop…');
}

// ────────────────────────────────────────────────────────────────────────
// Authenticated reconnect flow (URL has no fragment)
// ────────────────────────────────────────────────────────────────────────

/**
 * Offers the other endpoints this phone can open: the SSH hosts while the desktop is unreachable,
 * and the desktop and other hosts while `currentHostId` is connecting.
 */
function showOfflineHosts(els: UI, currentHostId: string | null = null): void {
  const desktopFingerprint = rememberedDesktopFingerprint(localStorage);
  const hosts = desktopFingerprint ? rememberedHosts(localStorage, desktopFingerprint) : [];
  const choice = (label: string, hostId: string | null) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      rememberLastEndpoint(localStorage, hostId);
      location.assign(endpointHref(location.href, hostId));
    });
    return button;
  };
  const choices = [
    ...hosts
      .filter((host) => host.id !== currentHostId)
      .map((host) => choice(`Open ${host.name}`, host.id)),
    ...(currentHostId ? [choice('Open this computer', null)] : []),
  ];
  if (choices.length === 0) return;
  els.offlineHosts.replaceChildren(...choices);
  els.offlineHosts.hidden = false;
}

/** Shows the sign-in card's one button. `onTap` runs inside the tap, as a passkey request must. */
function offerButton(els: UI, label: string, message: string | null, onTap: () => void): void {
  els.unlock.textContent = label;
  els.unlock.onclick = () => {
    els.unlock.hidden = true;
    els.error.hidden = true;
    onTap();
  };
  els.unlock.hidden = false;
  if (message) showError(els, message);
  else els.error.hidden = true;
}

function promptEnvironment(): PromptEnvironment {
  return {
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    userActivationActive: (navigator as { userActivation?: { isActive: boolean } }).userActivation
      ?.isActive,
  };
}

async function runAuthFlow(els: UI, hostId: string | null = null): Promise<void> {
  els.title.textContent = 'Komla';
  els.subtitle.textContent = 'Signing in…';
  els.fingerprintRow.hidden = true;
  els.register.hidden = true;
  els.form.hidden = true;
  els.unlock.hidden = true;
  els.error.hidden = true;

  if (typeof window.PublicKeyCredential === 'undefined' || !navigator.credentials?.get) {
    setStatus(els.status, 'error', 'WebAuthn not available');
    showError(els, "This browser doesn't support WebAuthn passkeys.");
    return;
  }

  setStatus(els.status, 'connecting', 'Looking up paired install…');
  const direct = readDirectRemoteConfig();
  // The device key belongs to the desktop that paired this phone, whichever endpoint it opens.
  const pairedDesktop =
    direct?.fingerprint ?? (hostId ? rememberedDesktopFingerprint(localStorage) : null);
  if (!pairedDesktop) {
    setStatus(els.status, 'error', 'Direct remote unavailable');
    showError(els, 'This client must be served directly by a Komla desktop.');
    return;
  }
  const desktopFingerprint: string = pairedDesktop;
  const host = hostId
    ? (rememberedHosts(localStorage, desktopFingerprint).find((item) => item.id === hostId) ?? null)
    : null;
  if (hostId && !host) {
    setStatus(els.status, 'error', 'Host unavailable');
    showError(els, 'This phone can no longer open that host. Open Komla on your computer first.');
    return;
  }
  if (host) showOfflineHosts(els, host.id);
  // The endpoint's own key, pinned like the desktop's.
  const fingerprint = host?.fingerprint ?? desktopFingerprint;
  let device: StoredDeviceIdentity | null;
  try {
    device = await loadDeviceIdentity(desktopFingerprint);
  } catch (err) {
    setStatus(els.status, 'error', 'Could not open device key store');
    showError(els, (err as Error).message);
    return;
  }
  if (!device) {
    const app = currentPushEnvironment().standalone;
    setStatus(els.status, 'error', app ? 'This app is not paired' : 'This browser is not paired');
    els.title.textContent = app ? 'Komla — pair this app' : 'Komla — pair this browser';
    els.fingerprintRow.hidden = true;
    els.subtitle.textContent = app
      ? 'This Home Screen app keeps its own keys, separate from the browser, so it pairs from a pasted link.'
      : 'Scan the pairing code in Komla › Settings › Remote with this device, or paste the pairing link.';
    showPairLinkForm(els);
    return;
  }
  const trustedDevice = device;
  const resumeGrant = readResumeGrant(fingerprint, trustedDevice.deviceId);

  els.fingerprint.textContent = shortFp(fingerprint);
  els.fingerprint.title = fingerprint;
  setStatus(
    els.status,
    'connecting',
    host ? `Connecting to ${host.name}…` : 'Connecting to desktop…'
  );

  const target: SessionTarget = {
    url: host ? host.url : socketUrlForFingerprint(fingerprint),
    fingerprint,
    device: trustedDevice,
  };
  const { ws, peer } = openPeerSocket(target.url, fingerprint);

  let terminalFrameProcessed = false;
  let client: RemoteAppClient | null = null;
  // This attempt was given up for a new one on the same page.
  let abandoned = false;
  // The desktop asked for the passkey, so a lost connection offers another try, not a reload.
  let passkeyRequested = false;

  /** Starts over on this page, so the tap that asked for it can still open the passkey sheet. */
  const restart = () => {
    abandoned = true;
    ws.close(1000, 'browser-aborted');
    void runAuthFlow(els, hostId);
  };
  const offerRetry = (message: string) => {
    setStatus(els.status, 'error', 'Not signed in');
    offerButton(els, 'Try again', message, restart);
  };
  const usePasskey = (challenge: PairAuthChallenge) => {
    respondToAuthChallenge(peer, challenge, els, trustedDevice).catch((err: unknown) => {
      if (abandoned || terminalFrameProcessed) return;
      if (peer.state !== 'established') {
        offerRetry(passkeyErrorMessage(err));
        return;
      }
      // The desktop still waits, so the same challenge can be answered again.
      setStatus(els.status, 'idle', 'Locked');
      offerButton(els, 'Try again', passkeyErrorMessage(err), () => usePasskey(challenge));
    });
  };
  const offerPasskey = (challenge: PairAuthChallenge) => {
    passkeyRequested = true;
    if (mayPromptWithoutTap(promptEnvironment())) {
      usePasskey(challenge);
      return;
    }
    setStatus(els.status, 'idle', 'Locked');
    els.subtitle.textContent = host
      ? `Unlock to open ${host.name}.`
      : 'Unlock to open your workspaces.';
    offerButton(els, 'Unlock with passkey', null, () => usePasskey(challenge));
  };

  peer.onMessage((msg) => {
    // After sign-in, app frames (binary ones too) are the client's to handle.
    if (terminalFrameProcessed) return;
    if (msg.kind !== 'json') {
      showError(els, 'Desktop sent an unexpected binary frame.');
      return;
    }
    const frame = parsePairFrame(msg.data);
    if (!frame) {
      showError(els, 'Desktop sent an unrecognised frame.');
      return;
    }
    void handleAuthFrame(frame);
  });

  async function handleAuthFrame(frame: PairFrame): Promise<void> {
    if (frame.type === 'pair:resume-challenge') {
      try {
        await respondToResumeChallenge(peer, frame, trustedDevice);
      } catch {
        // Sign in with the passkey instead.
        clearResumeGrant(fingerprint);
        restart();
      }
      return;
    }
    if (frame.type === 'pair:auth-challenge') {
      offerPasskey(frame);
      return;
    }
    if (frame.type === 'pair:authenticated') {
      terminalFrameProcessed = true;
      if (frame.deviceId !== trustedDevice.deviceId) {
        showError(els, 'Desktop authenticated a different browser installation.');
        ws.close(1000, 'device-id-mismatch');
        return;
      }
      if (frame.resumeToken && frame.resumeExpiresAt) {
        writeResumeGrant({
          fingerprint,
          deviceId: trustedDevice.deviceId,
          token: frame.resumeToken,
          expiresAt: frame.resumeExpiresAt,
        });
      } else {
        clearResumeGrant(fingerprint);
      }
      if (!adoptAuthenticated(peer, frame, !host)) {
        ws.close(1000, 'reloading-for-update');
        location.reload();
        return;
      }
      setStatus(els.status, 'authenticated', 'Connected');
      // The desktop is remembered only once picked, so a host can still become where the app opens.
      if (host) rememberLastEndpoint(localStorage, host.id);
      client = new RemoteAppClient({ ws, peer }, { desktopFingerprint, host }, target);
      client.start(frame.label);
      return;
    }
    if (frame.type === 'pair:rejected') {
      terminalFrameProcessed = true;
      if (resumeGrant && frame.reason === 'resume-invalid') {
        // Without a reload, which would lose the passkey sheet on Safari.
        clearResumeGrant(fingerprint);
        restart();
        return;
      }
      const failure = signInRejection(frame.reason, frame.message);
      // A host that turns this phone away stops being where the app opens.
      if (host) rememberLastEndpoint(localStorage, null);
      ws.close(1000, 'ceremony-complete');
      if (failure.retry) {
        offerRetry(failure.message);
        return;
      }
      setStatus(els.status, 'error', 'Not signed in');
      showError(els, failure.message);
      // Only the desktop decides that this phone is no longer paired; a host may just be out of date.
      if (!host) {
        await removeDeviceIdentity(desktopFingerprint);
        await runAuthFlow(els);
        showError(els, `${failure.message} Pair it again to use Komla here.`);
      }
      return;
    }
    showError(els, `Unexpected frame from desktop: ${frame.type}`);
  }

  ws.addEventListener('message', (evt) => {
    handleSocketMessage(evt, ws, peer, () => client?.noteInbound(ws));
  });

  ws.addEventListener('close', (evt) => {
    const wasReady = peer.state === 'established';
    afterPeerClosed(peer, evt, () => {
      const reason = evt.reason ?? '';
      if (abandoned || terminalFrameProcessed || reason === 'browser-aborted') return;
      if (evt.code === SESSION_CLOSE.REPLACED.code) {
        showReplaced(els);
      } else if (passkeyRequested) {
        offerRetry('Lost the connection to Komla.');
      } else if (wasReady && (evt.code === 1000 || evt.code === 1001)) {
        setStatus(els.status, 'idle', 'Disconnected');
      } else {
        scheduleAuthReconnect(els);
      }
    });
  });

  ws.addEventListener('error', () => {
    peer.handleError(new Error('socket error'));
  });

  peer.onEstablished(() => {
    setStatus(els.status, 'verifying', 'Signing in…');
    void peer
      .sendEncryptedJson({
        type: 'pair:hello',
        protocolVersion: PAIR_PROTOCOL_VERSION,
        ...(resumeGrant
          ? { mode: 'resume' as const, resumeToken: resumeGrant.token }
          : { mode: 'authenticate' as const }),
        deviceId: trustedDevice.deviceId,
        capabilities: PAGE_CAPABILITIES,
      })
      .catch((err) => {
        showError(els, `Send failed: ${(err as Error).message}`);
      });
  });

  ws.addEventListener('open', () => {
    void peer.connect().catch((err) => {
      setStatus(els.status, 'error', 'Handshake failed');
      showError(els, (err as Error).message);
    });
  });
}

/**
 * Signs this page in again with its resume grant and a fresh installation-key proof, over a new
 * connection, without a passkey or a reload. 'reload' when only the passkey can sign it in.
 */
function resumeSession(
  target: SessionTarget,
  fromDesktop: boolean,
  signal: AbortSignal,
  onInbound: (ws: WebSocket) => void
): Promise<LiveConnection | 'retry' | 'reload'> {
  const grant = readResumeGrant(target.fingerprint, target.device.deviceId);
  if (!grant) return Promise.resolve('reload');
  return new Promise((resolve) => {
    const { ws, peer } = openPeerSocket(target.url, target.fingerprint);
    let settled = false;
    const finish = (outcome: LiveConnection | 'retry' | 'reload') => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener('abort', abandon);
      if (typeof outcome === 'string') ws.close(1000, 'reconnect-abandoned');
      resolve(outcome);
    };
    const abandon = () => finish('retry');
    const timer = window.setTimeout(abandon, RECONNECT_ATTEMPT_TIMEOUT_MS);
    signal.addEventListener('abort', abandon);

    peer.onMessage((msg) => {
      if (settled || msg.kind !== 'json') return;
      const frame = parsePairFrame(msg.data);
      if (frame?.type === 'pair:resume-challenge') {
        respondToResumeChallenge(peer, frame, target.device).catch(() => finish('reload'));
      } else if (frame?.type === 'pair:authenticated') {
        if (frame.deviceId !== target.device.deviceId) {
          finish('reload');
          return;
        }
        if (frame.resumeToken && frame.resumeExpiresAt) {
          writeResumeGrant({
            fingerprint: target.fingerprint,
            deviceId: target.device.deviceId,
            token: frame.resumeToken,
            expiresAt: frame.resumeExpiresAt,
          });
        } else {
          clearResumeGrant(target.fingerprint);
        }
        finish(adoptAuthenticated(peer, frame, fromDesktop) ? { ws, peer } : 'reload');
      } else if (frame?.type === 'pair:rejected') {
        if (frame.reason === 'resume-invalid') clearResumeGrant(target.fingerprint);
        finish('reload');
      }
    });
    peer.onEstablished(() => {
      peer
        .sendEncryptedJson({
          type: 'pair:hello',
          protocolVersion: PAIR_PROTOCOL_VERSION,
          mode: 'resume',
          resumeToken: grant.token,
          deviceId: target.device.deviceId,
          capabilities: PAGE_CAPABILITIES,
        })
        .catch(() => finish('retry'));
    });
    ws.addEventListener('message', (evt) =>
      handleSocketMessage(evt, ws, peer, () => onInbound(ws))
    );
    ws.addEventListener('close', (evt) => afterPeerClosed(peer, evt, () => finish('retry')));
    ws.addEventListener('error', () => peer.handleError(new Error('socket error')));
    ws.addEventListener('open', () => {
      peer.connect().catch(() => finish('retry'));
    });
  });
}

async function respondToAuthChallenge(
  peer: Peer,
  challenge: PairAuthChallenge,
  els: UI,
  device: StoredDeviceIdentity
): Promise<void> {
  if (challenge.origin !== location.origin) {
    throw new Error(
      `Reconnect URL origin mismatch (page is ${location.origin}, desktop expected ${challenge.origin}).`
    );
  }
  // Called inside the Unlock tap, with nothing awaited before this request.
  setStatus(els.status, 'verifying', 'Waiting for your passkey…');
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: base64UrlToBytes(challenge.challenge),
      rpId: challenge.rpId,
      allowCredentials: [
        {
          type: 'public-key',
          id: base64UrlToBytes(challenge.credentialId),
        },
      ],
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('Authenticator returned no credential.');
  if (cred.id !== challenge.credentialId || cred.id !== device.credentialId) {
    throw new Error('Authenticator returned a passkey for a different trusted device.');
  }
  const deviceSignature = await signDeviceProof(
    device.privateKey,
    buildDeviceProof('authenticate', challenge.challenge, peer.getChannelBinding())
  );
  await peer.sendEncryptedJson({
    type: 'pair:auth-response',
    authenticationResponse: assertionToJSON(cred),
    deviceSignature: encodeBase64(deviceSignature),
  });
  setStatus(els.status, 'verifying', 'Checking…');
}

async function respondToResumeChallenge(
  peer: Peer,
  challenge: PairResumeChallenge,
  device: StoredDeviceIdentity
): Promise<void> {
  const deviceSignature = await signDeviceProof(
    device.privateKey,
    buildDeviceProof('resume', challenge.challenge, peer.getChannelBinding())
  );
  await peer.sendEncryptedJson({
    type: 'pair:resume-response',
    deviceSignature: encodeBase64(deviceSignature),
  });
}

// `bytesToBase64Url` is imported for use in the auth path's JSON shaping;
// re-export the registration helper inline so build noise stays low.
export { bytesToBase64Url };

void start();
