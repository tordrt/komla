import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { parseJsonc } from '../lib/jsonc';
import {
  describeNotifyRunner,
  getKomlaCliPath,
  getNotifyHelper,
  isKomlaCliBlocked,
} from '../lib/komla-cli';
import { createLogger } from '../lib/logger';

import type { NotificationIntegrationUpdate } from '../../shared/types/notification-integration';

const logger = createLogger('OpenCodeSettingsService');

interface OpenCodeConfig {
  mcp?: Record<
    string,
    {
      type?: string;
      url?: string;
      command?: string[];
      enabled?: boolean;
      [key: string]: unknown;
    }
  >;
  [key: string]: unknown;
}

export interface OpenCodeMcpStatus {
  isConfigured: boolean;
}

export interface OpenCodeNotificationStatus {
  isConfigured: boolean;
}

class OpenCodeSettingsService {
  private configPath = join(homedir(), '.config', 'opencode', 'opencode.json');
  private pluginsDir = join(homedir(), '.config', 'opencode', 'plugins');
  private pluginFileName = 'komla-notify.js';
  private mcpServerName = 'komla';

  getSettingsPath(): string {
    return this.configPath;
  }

  getPluginPath(): string {
    return join(this.pluginsDir, this.pluginFileName);
  }

  private readConfig(): OpenCodeConfig {
    try {
      if (existsSync(this.configPath)) {
        const data = readFileSync(this.configPath, 'utf-8');
        return parseJsonc<OpenCodeConfig>(data);
      }
    } catch (error) {
      logger.error('Failed to read OpenCode config:', error);
    }
    return {};
  }

  // --- Notification plugin ---

  private buildPluginContent(): string {
    const helper = getNotifyHelper();
    return buildOpenCodeNotifyPlugin(
      getKomlaCliPath().replace(/\\/g, '/'),
      isKomlaCliBlocked()
        ? {
            nodePathFile: helper.nodePathFile.replace(/\\/g, '/'),
            script: helper.script.replace(/\\/g, '/'),
          }
        : undefined
    );
  }

  getPluginContent(): string {
    return this.buildPluginContent();
  }

  enableNotificationPlugin(): void {
    if (!existsSync(this.pluginsDir)) {
      mkdirSync(this.pluginsDir, { recursive: true });
    }
    const pluginPath = this.getPluginPath();
    writeFileSync(pluginPath, this.buildPluginContent());
  }

  disableNotificationPlugin(): void {
    const pluginPath = this.getPluginPath();
    if (existsSync(pluginPath)) {
      unlinkSync(pluginPath);
    }
  }

  getNotificationUpdate(): NotificationIntegrationUpdate | undefined {
    const path = this.getPluginPath();
    if (!existsSync(path) || readFileSync(path, 'utf-8') === this.buildPluginContent())
      return undefined;
    return {
      files: [
        {
          path,
          description: `Replace this Komla notification plugin with the current one. It runs ${describeNotifyRunner()}. Any manual edits to this file will be replaced.`,
        },
      ],
    };
  }

  isNotificationPluginEnabled(): boolean {
    return existsSync(this.getPluginPath());
  }

  getNotificationStatus(): OpenCodeNotificationStatus {
    return {
      isConfigured: this.isNotificationPluginEnabled(),
    };
  }

  // --- MCP server ---

  getMcpServerUrl(port: number): string {
    return `http://localhost:${port}/api/v1/mcp`;
  }

  getMcpCliCommand(port: number): string {
    return `npx add-mcp ${this.getMcpServerUrl(port)} -g -n ${this.mcpServerName}`;
  }

  getMcpConfigJson(port: number): string {
    return JSON.stringify(
      {
        mcp: {
          [this.mcpServerName]: {
            type: 'remote',
            url: this.getMcpServerUrl(port),
          },
        },
      },
      null,
      2
    );
  }

  getMcpStatus(): OpenCodeMcpStatus {
    const config = this.readConfig();
    const hasKomla =
      config.mcp &&
      (config.mcp[this.mcpServerName] ||
        Object.values(config.mcp).some((s) => s.url && s.url.includes('/mcp')));
    return {
      isConfigured: !!hasKomla,
    };
  }
}

export const opencodeSettingsService = new OpenCodeSettingsService();

/**
 * OpenCode notification plugin source; `komlaCli` is the CLI path on the machine running OpenCode.
 * With `notifyHelper`, the plugin runs notify.js instead, for a computer where Windows blocks the CLI.
 *
 * One file serves both OpenCode generations: 1.18.29 and later call `server()`, and 2.x calls
 * `setup()`. Older 1.x releases don't load it.
 */
export function buildOpenCodeNotifyPlugin(
  komlaCli: string,
  notifyHelper?: { nodePathFile: string; script: string }
): string {
  // Node can't start komla-node.cmd without a shell, which would also parse the message, so
  // the plugin runs Komla's own executable as Node.
  const start = notifyHelper
    ? `const { readFileSync } = await import("node:fs");
    const node = readFileSync(${JSON.stringify(notifyHelper.nodePathFile)}, "utf8").trim();
    const proc = execFile(node, [${JSON.stringify(notifyHelper.script)}, ...args.slice(1)], {
      timeout: 5000,
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" }
    });`
    : `const proc = execFile(${JSON.stringify(komlaCli)}, args, {
      timeout: 5000,
      env: { ...process.env, ...env }
    });`;
  return `// Komla notification plugin – auto-managed, do not edit
// OpenCode 1.18.29 and later call server(); OpenCode 2 calls setup().

async function runKomla(args, input, env) {
  try {
    const { execFile } = await import("node:child_process");
    ${start}
    proc.stdin?.on("error", () => {});
    proc.stdin?.end(JSON.stringify(input));
    proc.on("error", () => {});
  } catch {}
}

async function server() {
  const seenPrompts = new Set();
  const pendingUserMessages = new Map();
  const textParts = new Map();
  const recentStops = new Map();
  // Task-tool subagents run in child sessions, mapped here to their root session.
  const childSessions = new Map();
  // Why a root session's turn is ending: OpenCode reports the error just before going idle.
  const turnErrors = new Map();
  // Root sessions waiting to retry a failed request; an abort then reports no error.
  const retrying = new Set();

  // Bounds what a long session keeps; the newest entries are the ones still needed.
  function remember(collection, key, value) {
    collection.delete(key);
    if (collection instanceof Set) collection.add(key);
    else collection.set(key, value);
    if (collection.size > 200) collection.delete(collection.keys().next().value);
  }

  function rememberSession(event) {
    const info = (event && event.properties && event.properties.info) || {};
    if (!info.id || !info.parentID || childSessions.has(info.id)) return;
    remember(childSessions, info.id, childSessions.get(info.parentID) || info.parentID);
  }

  async function notify(eventName, payload) {
    const args = ["notify", "--source", "opencode", "--event", eventName, "--cwd", process.cwd()];
    if (eventName === "StopFailure" && payload.error) args.push("--message", payload.error);
    await runKomla(args, {
      cwd: process.cwd(),
      source: "opencode",
      ...payload
    });
  }

  function sessionID(event) {
    return event && event.properties && event.properties.sessionID;
  }

  function emitStop(event) {
    const id = sessionID(event) || "unknown";
    // A subagent going idle is not the end of the root turn.
    if (childSessions.has(id)) return;
    const now = Date.now();
    const last = recentStops.get(id) || 0;
    if (now - last < 2000) return;
    remember(recentStops, id, now);
    const error = turnErrors.get(id);
    const aborted = (error && error.name === "MessageAbortedError") || (!error && retrying.has(id));
    turnErrors.delete(id);
    retrying.delete(id);
    if (aborted) {
      void notify("Interrupt", { sessionID: id });
      return;
    }
    if (error) {
      const data = error.data || {};
      const message = typeof data.message === "string" && data.message.trim() ? data.message : String(error.name || "OpenCode failed");
      // The message goes on the command line, which a provider's whole error page could overflow.
      void notify("StopFailure", {
        sessionID: id,
        error: Array.from(message).slice(0, 2000).join("")
      });
      return;
    }
    void notify("Stop", {
      sessionID: id,
      message: "OpenCode finished"
    });
  }

  function rememberStatus(event) {
    const id = sessionID(event);
    const status = (event.properties && event.properties.status) || {};
    const type = status.type;
    if (!id || childSessions.has(id)) return;
    // Work went on, so an error reported before it did not end the turn.
    if (type === "busy" || type === "retry") turnErrors.delete(id);
    if (type === "retry") remember(retrying, id);
    else if (type === "busy") retrying.delete(id);
  }

  function rememberError(event) {
    const id = sessionID(event);
    const error = event.properties && event.properties.error;
    // A subagent's error is reported to its root turn, which carries on.
    if (!id || childSessions.has(id) || !error || typeof error !== "object") return;
    // OpenCode compacts the conversation and carries on.
    if (error.name === "ContextOverflowError") return;
    remember(turnErrors, id, error);
  }

  function emitPrompt(event) {
    const props = (event && event.properties) || {};
    const info = props.info || {};
    const prompt = props.prompt || {};
    const text = typeof prompt.text === "string" ? prompt.text : undefined;
    if (typeof text !== "string" || !text.trim()) return;
    const currentSessionID = props.sessionID || info.sessionID;
    // A subagent's instructions are not the user's prompt.
    if (childSessions.has(currentSessionID)) return;
    const id = event.id || info.id;
    const key = currentSessionID ? currentSessionID + "\\0" + text : undefined;
    if ((id && seenPrompts.has("id:" + id)) || (key && seenPrompts.has("key:" + key))) return;
    if (id) remember(seenPrompts, "id:" + id);
    if (key) remember(seenPrompts, "key:" + key);
    void notify("UserPromptSubmit", {
      sessionID: currentSessionID,
      prompt: text
    });
  }

  function rememberTextPart(event) {
    const props = (event && event.properties) || {};
    const part = props.part || {};
    if (part.type !== "text" || typeof part.text !== "string" || !part.text.trim()) return;
    // OpenCode writes some messages itself, such as one to continue after compacting.
    if (part.synthetic === true) return;
    const messageID = part.messageID || props.messageID;
    if (!messageID) return;
    remember(textParts, messageID, part.text);
    const pending = pendingUserMessages.get(messageID);
    if (!pending) return;
    pendingUserMessages.delete(messageID);
    emitPrompt({
      id: messageID,
      properties: {
        sessionID: pending.sessionID || part.sessionID || props.sessionID,
        prompt: { text: part.text }
      }
    });
  }

  function rememberUserMessage(event) {
    const props = (event && event.properties) || {};
    const info = props.info || {};
    if (info.role !== "user" || !info.id) return;
    const existingText = textParts.get(info.id);
    if (existingText) {
      textParts.delete(info.id);
      emitPrompt({
        id: info.id,
        properties: {
          sessionID: props.sessionID || info.sessionID,
          prompt: { text: existingText }
        }
      });
      return;
    }
    remember(pendingUserMessages, info.id, {
      sessionID: props.sessionID || info.sessionID
    });
  }

  function emitPermission(event) {
    const props = (event && event.properties) || {};
    const permission = props.permission && typeof props.permission === "object" ? props.permission : props;
    const metadata = permission.metadata || {};
    const patterns = Array.isArray(permission.patterns) ? permission.patterns : undefined;
    const toolName = typeof permission.type === "string" ? permission.type
      : typeof permission.tool === "string" ? permission.tool
      : typeof metadata.tool === "string" ? metadata.tool
      : typeof metadata.tool_name === "string" ? metadata.tool_name
      : typeof permission.permission === "string" ? permission.permission
      : undefined;
    void notify("PermissionRequest", {
      sessionID: props.sessionID || permission.sessionID,
      permissionID: props.requestID || props.id || permission.id,
      tool_name: toolName,
      tool_input: {
        description: permission.title || metadata.description,
        command: metadata.command || metadata.pattern || permission.pattern || (patterns ? patterns.join(", ") : undefined)
      }
    });
  }

  // OpenCode's auto mode answers a request as soon as it is asked. The reply goes as tool
  // activity, which every Komla CLI maps, naming the request so Komla doesn't show it. A
  // rejection ends the turn instead, so it reports no activity.
  function emitPermissionReply(event) {
    const props = (event && event.properties) || {};
    if ((props.reply || props.response) === "reject") return;
    void notify("PreToolUse", {
      sessionID: props.sessionID,
      permissionID: props.requestID || props.permissionID
    });
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created" || event.type === "session.updated") {
        rememberSession(event);
      }
      if (event.type === "session.error") rememberError(event);
      if (event.type === "session.status") rememberStatus(event);
      if (event.type === "session.idle") emitStop(event);
      if (event.type === "session.status" && event.properties?.status?.type === "idle") {
        emitStop(event);
      }
      if (event.type === "permission.asked" || event.type === "permission.updated") {
        emitPermission(event);
      }
      if (event.type === "permission.replied") emitPermissionReply(event);
      if (event.type === "session.next.prompted") {
        emitPrompt(event);
      }
      if (event.type === "message.updated") {
        rememberUserMessage(event);
      }
      if (event.type === "message.part.updated") {
        rememberTextPart(event);
      }
    },
    "tool.execute.before": async (input, output) => {
      if (!input || typeof input.tool !== "string" || !input.tool) return;
      // A subagent's tools keep its root turn working.
      const rootSessionID = childSessions.get(input.sessionID) || input.sessionID;
      recentStops.delete(rootSessionID || "unknown");
      if (input.tool !== "question") {
        void notify("PreToolUse", {
          sessionID: rootSessionID,
          tool_name: input.tool
        });
        return;
      }
      const args = (output && output.args) || {};
      const questions = Array.isArray(args.questions) ? args.questions : [];
      const first = questions[0] || {};
      void notify("PermissionRequest", {
        sessionID: rootSessionID,
        tool_name: "question",
        tool_input: {
          description: typeof first.question === "string" ? first.question : undefined
        }
      });
    }
  }
}

// OpenCode 2 runs every session in one background service, which has the environment of whichever
// terminal started it, so its Komla ids may name another terminal. Komla finds the workspace from
// the session's own folder instead. An SSH host's tmux session would name that terminal too.
const SHARED_SERVICE_ENV = { KOMLA_TERMINAL_ID: "", KOMLA_WORKSPACE_ID: "", TMUX: "" };

// The service runs setup() once for every folder it has loaded, and each run can see every
// session's events, so the first to see an event reports it.
function firstSighting(event) {
  const seen = (globalThis[Symbol.for("komla.notify.events")] ??= new Set());
  if (!event.id) return true;
  if (seen.has(event.id)) return false;
  seen.add(event.id);
  if (seen.size > 1000) seen.delete(seen.values().next().value);
  return true;
}

async function setup(ctx) {
  const location = (ctx.location && ctx.location.directory) || process.cwd();
  // Each session's root session and folder. Subagents run in child sessions.
  const sessions = new Map();

  function describe(id, info) {
    let known = sessions.get(id);
    if (known) return known;
    known = (info ? Promise.resolve(info) : ctx.session.get({ sessionID: id }))
      .then(async (session) => {
        const parentID = session && session.parentID;
        if (parentID) return { ...(await describe(parentID)), child: true };
        const directory = session && session.location && session.location.directory;
        return { root: id, directory: directory || location };
      })
      .catch(() => ({ root: id, directory: location }));
    sessions.set(id, known);
    // Bounds what a long-running service keeps; the newest sessions are the ones still needed.
    if (sessions.size > 200) sessions.delete(sessions.keys().next().value);
    return known;
  }

  // \`turn\` marks a session's own prompt or turn end, which a subagent's are not to its root turn.
  async function report(eventName, id, payload, turn) {
    const session = await describe(id);
    if (turn && session.child) return;
    const args = ["notify", "--source", "opencode", "--event", eventName, "--cwd", session.directory];
    if (eventName === "StopFailure" && payload.error) args.push("--message", payload.error);
    await runKomla(args, {
      cwd: session.directory,
      source: "opencode",
      sessionID: session.root,
      ...payload
    }, SHARED_SERVICE_ENV);
  }

  function onEvent(event) {
    const data = (event && event.data) || {};
    if (event.type === "session.created") void describe(data.sessionID, data);
    if (event.type === "session.execution.succeeded") {
      void report("Stop", data.sessionID, { message: "OpenCode finished" }, true);
    }
    if (event.type === "session.execution.failed") {
      const error = data.error || {};
      const message = typeof error.message === "string" && error.message.trim() ? error.message : String(error.type || "OpenCode failed");
      // The message goes on the command line, which a provider's whole error page could overflow.
      void report("StopFailure", data.sessionID, { error: Array.from(message).slice(0, 2000).join("") }, true);
    }
    // A superseded run hands the turn to the next one.
    if (event.type === "session.execution.interrupted" && data.reason !== "superseded") {
      void report("Interrupt", data.sessionID, {}, true);
    }
    if (event.type === "permission.asked") {
      const metadata = data.metadata || {};
      const resources = Array.isArray(data.resources) ? data.resources : [];
      void report("PermissionRequest", data.sessionID, {
        permissionID: data.id,
        tool_name: data.action,
        tool_input: {
          description: data.message || metadata.description,
          command: metadata.command || (resources.length ? resources.join(", ") : undefined)
        }
      });
    }
    // An answer goes as tool activity naming the request, as in OpenCode 1. A rejection ends the turn.
    if (event.type === "permission.replied" && data.reply !== "reject") {
      void report("PreToolUse", data.sessionID, { permissionID: data.requestID });
    }
    // The question tool asks through a form.
    if (event.type === "form.created") {
      const form = data.form || {};
      const metadata = form.metadata || {};
      const first = (Array.isArray(form.fields) && form.fields[0]) || {};
      void report("PermissionRequest", form.sessionID, {
        permissionID: form.id,
        tool_name: metadata.kind === "question" ? "question" : "form",
        tool_input: { description: first.description || form.title }
      });
    }
    if (event.type === "form.replied") void report("PreToolUse", data.sessionID, { permissionID: data.id });
  }

  await ctx.session.hook("prompt", (event) => {
    const text = event && event.prompt && event.prompt.text;
    if (typeof text !== "string" || !text.trim()) return;
    void report("UserPromptSubmit", event.sessionID, { prompt: text }, true);
  });
  await ctx.tool.hook("execute.before", (event) => {
    // The question's form reports it.
    if (!event || typeof event.tool !== "string" || !event.tool || event.tool === "question") return;
    void report("PreToolUse", event.sessionID, { tool_name: event.tool });
  });
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event && firstSighting(event)) onEvent(event);
      }
    } catch {}
  })();
  return () => controller.abort();
}

export default { id: "komla.notify", setup, server };
`;
}
