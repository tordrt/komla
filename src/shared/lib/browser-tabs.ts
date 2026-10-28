import type { TerminalExecutionLocation } from '../types/terminal';
import type { WorkspaceBrowserPane, WorkspaceBrowserTab } from '../types/workspace';

export const MAX_BROWSER_TABS = 30;
/** The browser panes a workspace saves. */
export const MAX_BROWSER_PANES = 12;
export const MAX_BROWSER_URL_LENGTH = 2048;
export const MAX_BROWSER_TAB_TITLE_LENGTH = 300;
const MAX_BROWSER_TAB_ID_LENGTH = 256;

export type BrowserTabsSource =
  | { browserTabs?: WorkspaceBrowserTab[]; activeBrowserTabId?: string }
  | undefined;

/** The workspace fields that hold its browser tabs, as passed to a workspace update. */
export interface BrowserTabsState {
  browserTabs: WorkspaceBrowserTab[];
  activeBrowserTabId: string | undefined;
}

export function parseBrowserUrl(input: string): URL | null {
  if (input.length > MAX_BROWSER_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

export function isBrowserUrl(input: string): boolean {
  return parseBrowserUrl(input) !== null;
}

/** Whether two URLs are the same address, such as `http://localhost:3000` and its `/` form. */
export function isSameBrowserUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/**
 * Turns what was typed in an address field into an http(s) URL: localhost and
 * IP addresses get http://, other hosts https://. Returns null for text that
 * isn't a web address.
 */
export function toBrowserUrl(input: string): string | null {
  const typed = input.trim();
  if (!typed || /\s/.test(typed)) return null;
  if (isBrowserUrl(typed)) return typed;
  // Another scheme, such as file:// or ftp://.
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(typed)) return null;
  const url = parseBrowserUrl(`http://${typed}`);
  if (!url) return null;
  const isLocal =
    url.hostname === 'localhost' ||
    url.hostname.startsWith('[') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname);
  if (!isLocal && !url.hostname.includes('.')) return null;
  return `${isLocal ? 'http' : 'https'}://${typed}`;
}

/**
 * Whether a page is served from this computer: localhost and *.localhost,
 * 127.x.x.x, [::1] and 0.0.0.0. Only these pages reload on their own when the
 * workspace's files change.
 */
export function isLocalPageUrl(input: string): boolean {
  const hostname = parseBrowserUrl(input)?.hostname;
  if (!hostname) return false;
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    hostname === '0.0.0.0' ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

// The first label of a sign-in service's host, as in accounts.google.com or login.microsoftonline.com.
const SIGN_IN_HOST_LABELS = new Set(['accounts', 'auth', 'id', 'login', 'oauth', 'signin', 'sso']);
// Query parameters of OAuth authorization and device-code requests.
const SIGN_IN_QUERY_PARAMS = ['code_challenge', 'redirect_uri', 'response_type', 'user_code'];
// Words of sign-in paths, as in /login/device, /oauth/authorize, /devicelogin or /sign-in.
const SIGN_IN_PATH_WORDS = new Set([
  'auth',
  'authorize',
  'device',
  'devicelogin',
  'login',
  'logon',
  'oauth',
  'oauth2',
  'signin',
  'sso',
]);
// Sign-in pages sit near the root of a site; deeper paths are more often code or docs.
const SIGN_IN_PATH_DEPTH = 3;

function isSignInPathSegment(segment: string): boolean {
  const words = segment
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/);
  return (
    words.some((word) => SIGN_IN_PATH_WORDS.has(word)) || SIGN_IN_PATH_WORDS.has(words.join(''))
  );
}

/**
 * Whether a page looks like one a CLI sends you to to sign in, such as an OAuth or
 * device-code page. You're signed in to those services in your own browser, and some,
 * like Google, refuse to sign in inside an embedded browser. A page on this computer
 * is your own app's, so it never counts.
 */
export function isSignInPageUrl(input: string): boolean {
  const url = parseBrowserUrl(input);
  if (!url || isLocalPageUrl(input)) return false;
  return (
    SIGN_IN_HOST_LABELS.has(url.hostname.split('.')[0]) ||
    SIGN_IN_QUERY_PARAMS.some((name) => url.searchParams.has(name)) ||
    url.pathname.split('/').filter(Boolean).slice(0, SIGN_IN_PATH_DEPTH).some(isSignInPathSegment)
  );
}

export function createBrowserTabId(): string {
  return `browser-${globalThis.crypto.randomUUID()}`;
}

export function getBrowserTabs(workspace: BrowserTabsSource): WorkspaceBrowserTab[] {
  return workspace?.browserTabs ?? [];
}

export function getActiveBrowserTab(workspace: BrowserTabsSource): WorkspaceBrowserTab | undefined {
  const tabs = getBrowserTabs(workspace);
  return tabs.find((tab) => tab.id === workspace?.activeBrowserTabId) ?? tabs[0];
}

function stateOf(workspace: BrowserTabsSource): BrowserTabsState {
  return {
    browserTabs: getBrowserTabs(workspace),
    activeBrowserTabId: getActiveBrowserTab(workspace)?.id,
  };
}

function isSameLocation(
  tab: WorkspaceBrowserTab,
  location: TerminalExecutionLocation | undefined
): boolean {
  return (tab.urlExecutionLocation ?? 'workspace') === (location ?? 'workspace');
}

function withUrl(
  tab: WorkspaceBrowserTab,
  url: string,
  location: TerminalExecutionLocation | undefined
): WorkspaceBrowserTab {
  const { urlExecutionLocation: _location, title, ...rest } = tab;
  return {
    ...rest,
    url,
    ...(location === 'local-mirror' ? { urlExecutionLocation: location } : {}),
    // A title describes the page it came from.
    ...(url === tab.url && title !== undefined ? { title } : {}),
  };
}

/** Points `target` at a URL and shows it, or adds a tab for the URL when there's no target. */
function showUrlInTab(
  workspace: BrowserTabsSource,
  target: WorkspaceBrowserTab | undefined,
  url: string,
  urlExecutionLocation: TerminalExecutionLocation | undefined,
  id: string
): BrowserTabsState {
  if (!target) return addBrowserTab(workspace, url, urlExecutionLocation, id);
  return {
    browserTabs: getBrowserTabs(workspace).map((tab) =>
      tab.id === target.id ? withUrl(tab, url, urlExecutionLocation) : tab
    ),
    activeBrowserTabId: target.id,
  };
}

/** Adds a tab after the others and shows it, unless the workspace has as many as it can hold. */
export function addBrowserTab(
  workspace: BrowserTabsSource,
  url = '',
  urlExecutionLocation?: TerminalExecutionLocation,
  id = createBrowserTabId()
): BrowserTabsState {
  const state = stateOf(workspace);
  if (state.browserTabs.length >= MAX_BROWSER_TABS) return state;
  const tab = withUrl({ id, url: '' }, url, urlExecutionLocation);
  return { browserTabs: [...state.browserTabs, tab], activeBrowserTabId: id };
}

/**
 * Shows a URL in a tab of its own: a tab already at that URL, else the active tab
 * when it has no page yet, else a new tab.
 */
export function openUrlInNewBrowserTab(
  workspace: BrowserTabsSource,
  url: string,
  urlExecutionLocation?: TerminalExecutionLocation,
  id = createBrowserTabId()
): BrowserTabsState {
  const state = stateOf(workspace);
  // Which machine a link came from matters only for a page on that machine.
  const opened = state.browserTabs.find(
    (tab) =>
      isSameBrowserUrl(tab.url, url) &&
      (!isLocalPageUrl(url) || isSameLocation(tab, urlExecutionLocation))
  );
  if (opened) return selectBrowserTab(workspace, opened.id);
  const active = getActiveBrowserTab(workspace);
  const target =
    (active && !active.url ? active : undefined) ??
    (state.browserTabs.length >= MAX_BROWSER_TABS ? active : undefined);
  return showUrlInTab(workspace, target, url, urlExecutionLocation, id);
}

/** Points a tab at a URL the user or Komla chose. Location defaults to the tab's own. */
export function setBrowserTabUrl(
  workspace: BrowserTabsSource,
  tabId: string,
  url: string,
  urlExecutionLocation?: TerminalExecutionLocation
): BrowserTabsState {
  const state = stateOf(workspace);
  return {
    ...state,
    browserTabs: state.browserTabs.map((tab) =>
      tab.id === tabId ? withUrl(tab, url, urlExecutionLocation ?? tab.urlExecutionLocation) : tab
    ),
  };
}

/** Points the active tab at a URL, adding a tab when the workspace has none. */
export function setActiveBrowserTabUrl(
  workspace: BrowserTabsSource,
  url: string,
  urlExecutionLocation?: TerminalExecutionLocation
): BrowserTabsState {
  const active = getActiveBrowserTab(workspace);
  return active
    ? setBrowserTabUrl(workspace, active.id, url, urlExecutionLocation)
    : addBrowserTab(workspace, url, urlExecutionLocation);
}

/**
 * Records the page a tab navigated to, so it reopens there. Returns null when
 * nothing changed, which spares a save on every in-page event.
 */
export function recordBrowserTabPage(
  workspace: BrowserTabsSource,
  tabId: string,
  page: { url?: string; title?: string }
): BrowserTabsState | null {
  const state = stateOf(workspace);
  const tab = state.browserTabs.find((candidate) => candidate.id === tabId);
  if (!tab) return null;
  const url = page.url !== undefined && isBrowserUrl(page.url) ? page.url : tab.url;
  const title =
    page.title !== undefined ? page.title.slice(0, MAX_BROWSER_TAB_TITLE_LENGTH) : tab.title;
  if (url === tab.url && title === tab.title) return null;
  const { title: _title, ...rest } = tab;
  const next: WorkspaceBrowserTab = { ...rest, url, ...(title ? { title } : {}) };
  return {
    ...state,
    browserTabs: state.browserTabs.map((candidate) => (candidate.id === tabId ? next : candidate)),
  };
}

export function selectBrowserTab(workspace: BrowserTabsSource, tabId: string): BrowserTabsState {
  const state = stateOf(workspace);
  if (!state.browserTabs.some((tab) => tab.id === tabId)) return state;
  return { ...state, activeBrowserTabId: tabId };
}

/** Removes a tab. Closing the active tab shows the one to its right, or else to its left. */
export function closeBrowserTab(workspace: BrowserTabsSource, tabId: string): BrowserTabsState {
  const state = stateOf(workspace);
  const index = state.browserTabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return state;
  const browserTabs = state.browserTabs.filter((tab) => tab.id !== tabId);
  const activeBrowserTabId =
    state.activeBrowserTabId === tabId
      ? (browserTabs[index] ?? browserTabs[index - 1])?.id
      : state.activeBrowserTabId;
  return { browserTabs, activeBrowserTabId };
}

/** Keeps the valid tabs of a saved list; returns undefined when none are left. */
export function normalizeBrowserTabs(value: unknown): WorkspaceBrowserTab[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = new Set<string>();
  const tabs: WorkspaceBrowserTab[] = [];
  for (const entry of value) {
    if (tabs.length >= MAX_BROWSER_TABS) break;
    if (!entry || typeof entry !== 'object') continue;
    const { id, url, urlExecutionLocation, title } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim() || id.length > MAX_BROWSER_TAB_ID_LENGTH) continue;
    if (ids.has(id) || typeof url !== 'string' || (url !== '' && !isBrowserUrl(url))) continue;
    ids.add(id);
    tabs.push({
      id,
      url,
      ...(urlExecutionLocation === 'local-mirror' ? { urlExecutionLocation } : {}),
      ...(typeof title === 'string' && title
        ? { title: title.slice(0, MAX_BROWSER_TAB_TITLE_LENGTH) }
        : {}),
    });
  }
  return tabs.length > 0 ? tabs : undefined;
}

/** A workspace's saved browser panes, without any that are malformed or have no tabs. */
export function normalizeBrowserPanes(value: unknown): WorkspaceBrowserPane[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const panes: WorkspaceBrowserPane[] = [];
  for (const entry of value.slice(0, MAX_BROWSER_PANES)) {
    if (!entry || typeof entry !== 'object') continue;
    const { browserTabs: rawTabs, activeBrowserTabId } = entry as Record<string, unknown>;
    const browserTabs = normalizeBrowserTabs(rawTabs);
    if (!browserTabs) continue;
    const active = getActiveBrowserTab({
      browserTabs,
      activeBrowserTabId: typeof activeBrowserTabId === 'string' ? activeBrowserTabId : undefined,
    });
    panes.push({ browserTabs, activeBrowserTabId: active?.id });
  }
  return panes;
}
