import { isMcpToolEnabled } from '../../../shared/constants/mcp-built-in-tools';
import { resolveKomlaRequestRoute } from '../../lib/komla-request-route';
import { isLocalHostHeader } from '../../lib/local-host-header';
import { createLogger } from '../../lib/logger';
import { configService } from '../config.service';

import { parseRequestUrl, singleHeader, writeNotFound } from './http-io';
import { handleKomlaCommandRequest } from './routes/commands';
import { handleCreateWorkspaceRequest } from './routes/create-workspace';
import { handleMcpRequest } from './routes/mcp';
import { handleNotifyRequest } from './routes/notify';
import { handleSettingsManagementRequest } from './routes/settings';
import { handleSkillFileRequest } from './routes/skills';
import { handleSshHostChangedRequest } from './routes/ssh-host-changed';
import { handleSshWorkspaceStatusRequest } from './routes/ssh-workspace-status';

import type http from 'http';

const logger = createLogger('HttpServerService');

// Refused hosts already logged, so a page retrying in a loop logs each host once.
const refusedHosts = new Set<string>();

interface RouteRequest {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** The request target, without any `/terminals/<id>` prefix but with its query. */
  url: string;
  pathname: string | undefined;
  terminalId: string | undefined;
}

interface Route {
  matches(request: RouteRequest): boolean;
  /** Read per request, so toggles take effect without a restart. Off answers as unknown. */
  isOn?(config: ReturnType<typeof configService.get>): boolean;
  handle(request: RouteRequest): void;
}

const ANY_METHOD = undefined;

/** Compares the whole request target, so these routes don't match with a query. */
function target(methods: readonly string[] | typeof ANY_METHOD, ...urls: readonly string[]) {
  return ({ req, url }: RouteRequest): boolean =>
    urls.includes(url) && (!methods || methods.includes(req.method ?? ''));
}

const isMcpOn: Route['isOn'] = (config) => !config.disableMcpServer;

// The first match answers.
const ROUTES: readonly Route[] = [
  {
    matches: ({ pathname }) => Boolean(pathname?.startsWith('/settings/')),
    handle: ({ req, res, url, terminalId }) =>
      handleSettingsManagementRequest(req, res, url, terminalId),
  },
  {
    matches: target(['GET'], '/api/v1/health'),
    handle: ({ res }) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
  },
  {
    matches: target(['POST'], '/api/v1/notify'),
    isOn: (config) => !config.disableNotificationEndpoint,
    handle: ({ req, res }) => handleNotifyRequest(req, res),
  },
  {
    matches: target(['POST'], '/api/v1/ssh-workspace-status'),
    handle: ({ req, res }) => handleSshWorkspaceStatusRequest(req, res),
  },
  {
    matches: target(['POST'], '/api/v1/ssh-host-changed'),
    handle: ({ req, res }) => handleSshHostChangedRequest(req, res),
  },
  {
    matches: target(['POST'], '/api/v1/workspace'),
    // REST sibling of the spawn_agent_in_new_workspace MCP tool — gate it
    // on the same per-tool toggle so disabling the tool actually disables
    // the capability, not just the MCP registration.
    isOn: (config) =>
      !config.disableMcpServer && isMcpToolEnabled('spawn_agent_in_new_workspace', config),
    handle: ({ req, res }) => handleCreateWorkspaceRequest(req, res),
  },
  {
    matches: ({ req, pathname }) => req.method === 'POST' && pathname === '/api/v1/commands',
    handle: ({ req, res, url, terminalId }) => handleKomlaCommandRequest(req, res, url, terminalId),
  },
  {
    matches: target(ANY_METHOD, '/api/v1/cli/mcp'),
    isOn: isMcpOn,
    // The installed `komla` executable exposes this adapter over stdio.
    // Typed CLI commands use /api/v1/commands and remain independent.
    handle: ({ req, res, terminalId }) =>
      handleMcpRequest(req, res, {
        terminalId: terminalId ?? singleHeader(req.headers['x-komla-terminal-id']),
        workspaceId: singleHeader(req.headers['x-komla-workspace-id']),
        sshHostId: singleHeader(req.headers['x-komla-ssh-host-id']),
      }),
  },
  {
    matches: target(ANY_METHOD, '/api/v1/mcp'),
    isOn: isMcpOn,
    handle: ({ req, res }) => handleMcpRequest(req, res),
  },
  {
    matches: ({ req, url }) => req.method === 'GET' && url.startsWith('/skills/'),
    handle: ({ res, url }) => handleSkillFileRequest(url, res),
  },
];

export function createRequestHandler(): http.RequestListener {
  return (req, res) => {
    // Read config per-request so toggles take effect without restart.
    const config = configService.get();
    if (refuseForeignHost(req, res)) return;
    if (refuseWebPage(req, res)) return;
    const scoped = resolveTerminalScopedRoute(req.url ?? '');
    if (!scoped) return writeNotFound(res);
    const { url, terminalId } = scoped;
    const request: RouteRequest = {
      req,
      res,
      url,
      terminalId,
      pathname: parseRequestUrl(url)?.pathname,
    };
    const route = ROUTES.find((candidate) => candidate.matches(request));
    if (!route || route.isOn?.(config) === false) return writeNotFound(res);
    route.handle(request);
  };
}

/**
 * Turns away web pages that point their own domain at 127.0.0.1 (DNS
 * rebinding), such as a site open in Komla's browser.
 */
function refuseForeignHost(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (isLocalHostHeader(req.headers.host)) return false;
  const host = req.headers.host ?? '';
  if (refusedHosts.size < 100 && !refusedHosts.has(host)) {
    refusedHosts.add(host);
    logger.warn('Refused a request whose Host is not this machine', {
      host: host.slice(0, 100),
    });
  }
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end('Forbidden');
  return true;
}

/**
 * Turns away a request a browser sends for a web page, such as a site open
 * in Komla's browser or the user's own. The Host check misses pages reaching
 * Komla through an SSH host's gateway, which rewrites Host, and same-origin
 * or simple requests get no CORS preflight to stop them. Agent hooks, the
 * companion, `komla` and agents' MCP clients never send these headers.
 */
function refuseWebPage(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const site = singleHeader(req.headers['sec-fetch-site']);
  if (req.headers.origin === undefined && (site === undefined || site === 'none')) return false;
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end('Forbidden');
  return true;
}

function resolveTerminalScopedRoute(rawUrl: string): { url: string; terminalId?: string } | null {
  const resolved = resolveKomlaRequestRoute(rawUrl);
  if (!resolved) return null;
  if (!resolved.terminalId) return { url: rawUrl };
  return { url: `${resolved.route}${resolved.url.search}`, terminalId: resolved.terminalId };
}
