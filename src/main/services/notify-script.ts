/**
 * Generates the content of the shared ~/.komla/notify.js notification script.
 * Hooks run it in place of the komla CLI when Windows blocks the CLI.
 *
 * Usage: node notify.js --source <agent> --event <event> [--message <text>] [--cwd <dir>] [--input argv]
 *   stdin agents (Claude, Gemini): pipe JSON to stdin
 *   argv agents (Codex): pass JSON as first positional arg after flags
 */
export function generateNotifyScript(portFilePath: string): string {
  // Use forward slashes for cross-platform compatibility in the generated script
  const normalizedPortPath = portFilePath.replace(/\\/g, '/');

  return generateScript(normalizedPortPath);
}

function generateScript(portFilePath: string): string {
  // Allow KOMLA_NOTIFY_HOST to override the script's default host at runtime.
  // The script defaults to IPv4 loopback because the server binds 127.0.0.1.
  const hostExpr = `(process.env.KOMLA_NOTIFY_HOST || "127.0.0.1")`;

  return `#!/usr/bin/env node
// Komla notification script — auto-managed, do not edit
// Written by Komla on each launch. Invoked by agent hooks.
"use strict";

var args = process.argv.slice(2);
var source = "generic";
var event = "Notification";
var inputMode = "stdin";
var messageOption;
var explicitCwd;
var positionalArgs = [];
var isHook = false;

// Takes the komla CLI's notify arguments too, since hooks run this when Windows blocks the CLI.
for (var i = 0; i < args.length; i++) {
  if (args[i] === "--source" && args[i + 1]) { source = args[++i]; }
  else if (args[i] === "--event" && args[i + 1]) { event = args[++i]; isHook = true; }
  else if (args[i] === "--input" && args[i + 1]) { inputMode = args[++i]; }
  else if (args[i] === "--message" && i + 1 < args.length) { messageOption = args[++i]; }
  else if (args[i] === "--cwd" && args[i + 1]) { explicitCwd = args[++i]; }
  else { positionalArgs.push(args[i]); }
}

// Grok Build also runs the hooks Claude Code, Codex and Cursor read, Komla's among them,
// which would report Grok's turns as theirs.
if (isHook && process.env.GROK_HOOK_EVENT && source.indexOf("grok") !== 0) process.exit(0);
// Cursor and Devin also run the hooks Claude Code reads.
if (isHook && process.env.CURSOR_VERSION && process.env.CURSOR_PROJECT_DIR && source.indexOf("cursor") !== 0) process.exit(0);
if (isHook && process.env.DEVIN_PROJECT_DIR && source.indexOf("devin") !== 0) process.exit(0);
// Claude Code outside an interactive session: a background session's daemon, which kept the
// environment of the Terminal that started it, or print and SDK mode, such as a claude -p
// another agent runs in its Terminal.
if (isHook && source === "claude-code" && (process.env.CLAUDE_JOB_DIR
  || (process.env.CLAUDE_CODE_ENTRYPOINT || "").indexOf("sdk") === 0)) process.exit(0);

// Antigravity hooks must answer with a JSON object, and Stop with a decision;
// any decision but "continue" lets the agent stop. Answer even if Komla is away.
if (source === "antigravity") {
  try { require("fs").writeSync(1, (event === "Stop" ? '{"decision":"stop"}' : "{}") + "\\n"); } catch (e) {}
}

var port = process.env.KOMLA_NOTIFY_PORT;
if (!port) {
  try { port = require("fs").readFileSync(${JSON.stringify(portFilePath)}, "utf8").trim(); }
  catch (e) { process.exit(0); }
}
var portNum = Number(port);
if (!/^\\d+$/.test(port) || portNum < 1 || portNum > 65535) process.exit(0);

// Cap notification messages well under the server's 64KB limit — desktop
// notifications never need more, and short payloads keep the POST cheap.
function cleanMessage(value, maxLen) {
  if (typeof value !== "string") return undefined;
  if (maxLen === undefined) maxLen = 8192;
  var normalized = value.replace(/\\s+/g, " ").trim();
  return normalized.length > maxLen ? normalized.slice(0, maxLen - 3) + "..." : normalized;
}

function mapKind(source, event, parsed) {
  if (source === "antigravity") {
    // Protojson omits zero and false, so a missing invocationNum is the
    // turn's first model call and a missing fullyIdle is not idle.
    if (event === "PreInvocation") {
      return Number.isInteger(parsed.invocationNum) && parsed.invocationNum > 0 ? "activity" : "prompt-submit";
    }
    if (event === "PostToolUse") return "activity";
    if (event === "Stop") return parsed.fullyIdle === true ? "turn-complete" : "activity";
    return "generic";
  }
  // Claude ends a turn that fails on an API error with StopFailure instead of Stop.
  if (event === "StopFailure") return "error";
  // The turn stopped without news: the agent was cancelled, or Claude quit.
  if (event === "Interrupt" || event === "SessionEnd") return "interrupted";
  // A manual /compact runs as its own command, which sends no Stop.
  if (event === "PostCompact") return "turn-complete";
  if (event === "PreToolUse" || event === "PostToolUse" || event === "PostToolUseFailure" || event === "BeforeTool") return "activity";
  if (event === "Stop") return "turn-complete";
  if (event === "UserPromptSubmit" || event === "BeforeAgent") return "prompt-submit";
  if (event === "PermissionRequest") return "input-required";
  if (event === "AfterAgent") return "turn-complete";
  if (source === "claude-code") {
    if (parsed.notification_type === "permission_prompt" || parsed.notification_type === "elicitation_dialog") return "input-required";
    if (parsed.notification_type === "idle_prompt") return "idle";
    return "generic";
  }
  if (source === "gemini") {
    if (parsed.notification_type === "ToolPermission") return "input-required";
    return "generic";
  }
  if (source === "codex") return "turn-complete";
  if (source === "opencode") return "idle";
  return "generic";
}

function extractMessage(source, event, parsed) {
  if (messageOption !== undefined) return cleanMessage(messageOption);
  if (event === "StopFailure") {
    var failureFields = ["last_assistant_message", "error_details", "error"];
    for (var f = 0; f < failureFields.length; f++) {
      var failure = parsed[failureFields[f]];
      if (typeof failure === "string" && failure.trim()) return cleanMessage(failure);
    }
    return undefined;
  }
  if (event === "PostCompact") return "Compacted the conversation";
  if (event === "Stop") {
    var stopMsg = typeof parsed.last_assistant_message === "string" ? parsed.last_assistant_message
      : (typeof parsed.message === "string" ? parsed.message : undefined);
    if (typeof stopMsg !== "string") stopMsg = source === "claude-code" ? "Claude finished" : "Agent finished";
    return cleanMessage(stopMsg);
  }
  if (event === "UserPromptSubmit" || event === "BeforeAgent") return cleanMessage(parsed.prompt);
  if (event === "PermissionRequest") {
    var toolInput = parsed && typeof parsed.tool_input === "object" && parsed.tool_input ? parsed.tool_input : {};
    // Claude asks its questions through a permission prompt, too.
    var question = Array.isArray(toolInput.questions) && toolInput.questions[0] ? toolInput.questions[0].question : undefined;
    if (typeof question === "string" && question.trim()) return cleanMessage(question);
    if (typeof toolInput.description === "string" && toolInput.description.trim()) return cleanMessage(toolInput.description);
    if (typeof toolInput.command === "string" && toolInput.command.trim()) return cleanMessage(toolInput.command);
    var agentName = source === "opencode" ? "OpenCode" : (source === "codex" ? "Codex" : (source === "claude-code" ? "Claude" : "Agent"));
    if (typeof parsed.tool_name === "string" && parsed.tool_name.trim()) return cleanMessage(agentName + " needs approval for " + parsed.tool_name);
    return agentName + " needs approval";
  }
  if (source === "codex") {
    var raw = typeof parsed["last-assistant-message"] === "string"
      ? parsed["last-assistant-message"]
      : (typeof parsed.message === "string" ? parsed.message : undefined);
    return cleanMessage(raw, 160);
  }
  if (source === "gemini") {
    return cleanMessage(typeof parsed.message === "string" ? parsed.message
      : (typeof parsed.error === "string" ? parsed.error : undefined));
  }
  return cleanMessage(parsed.message);
}

function extractCwd(source, parsed) {
  if (explicitCwd) return explicitCwd;
  // Antigravity runs global hooks from its config directory, so take the
  // workspace from the payload instead.
  if (source === "antigravity" && Array.isArray(parsed.workspacePaths) && typeof parsed.workspacePaths[0] === "string") {
    return parsed.workspacePaths[0];
  }
  if (typeof parsed.cwd === "string") return parsed.cwd;
  if (source === "codex") {
    var inputMessages = Array.isArray(parsed["input-messages"]) ? parsed["input-messages"] : [];
    for (var j = 0; j < inputMessages.length; j++) {
      var item = inputMessages[j];
      var found = findCwdTag(typeof item === "string" ? item : null)
        || findCwdTag(item && typeof item.content === "string" ? item.content : null);
      if (found) return found;
      if (item && Array.isArray(item.content)) {
        for (var k = 0; k < item.content.length; k++) {
          var ci = item.content[k];
          found = findCwdTag(ci && typeof ci.text === "string" ? ci.text : null);
          if (found) return found;
        }
      }
    }
  }
  return process.cwd();
}

function findCwdTag(value) {
  if (!value || typeof value !== "string") return undefined;
  var match = value.match(/<cwd>([^<]+)<\\/cwd>/i);
  return match && typeof match[1] === "string" ? match[1] : undefined;
}

// Komla receives the whole hook input, as from the CLI, unless it is too large to forward.
var MAX_FORWARDED_HOOK_INPUT_BYTES = 64 * 1024;
var COMPACT_HOOK_INPUT_FIELDS = [
  "hook_event_name", "agent_id", "notification_type", "session_id", "turn_id", "prompt_id",
  // What PostCompact, SessionEnd and StopFailure mean depends on these.
  "trigger", "reason", "error",
  // OpenCode names a permission request, and the reply to it, with this.
  "permissionID"
];

function forwardedHookInput(parsed, inputBytes) {
  var hookInput = Object.assign({}, parsed);
  if (inputBytes > MAX_FORWARDED_HOOK_INPUT_BYTES) {
    hookInput = {};
    for (var c = 0; c < COMPACT_HOOK_INPUT_FIELDS.length; c++) {
      var field = COMPACT_HOOK_INPUT_FIELDS[c];
      if (typeof parsed[field] === "string") hookInput[field] = parsed[field];
    }
    if (typeof parsed.message === "string" && parsed.message.length <= 8192) hookInput.message = parsed.message;
    // Antigravity's turn state is a number and a flag rather than an id.
    if (source === "antigravity") {
      if (typeof parsed.invocationNum === "number") hookInput.invocationNum = parsed.invocationNum;
      if (typeof parsed.fullyIdle === "boolean") hookInput.fullyIdle = parsed.fullyIdle;
    }
  }
  if (!hookInput.hook_event_name) hookInput.hook_event_name = event;
  return hookInput;
}

var done = false;
function send(input) {
  if (done) return;
  done = true;
  try {
    var parsed = {};
    try { parsed = JSON.parse(input || "{}"); } catch (e) {}
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) parsed = {};
    // An automatic compact happens inside a turn, which ends with its own Stop.
    if (event === "PostCompact" && parsed.trigger !== "manual") process.exit(0);
    var inputBytes = Buffer.byteLength(input || "");
    // Komla reads nothing of a tool's output, which may be large.
    if ((event === "PostToolUse" || event === "PostToolUseFailure") && "tool_response" in parsed) {
      delete parsed.tool_response;
      inputBytes = Buffer.byteLength(JSON.stringify(parsed));
    }
    var payload = JSON.stringify({
      workspaceId: process.env.KOMLA_WORKSPACE_ID || undefined,
      terminalId: process.env.KOMLA_TERMINAL_ID || undefined,
      cwd: extractCwd(source, parsed),
      kind: mapKind(source, event, parsed),
      source: source,
      hookInput: forwardedHookInput(parsed, inputBytes),
      message: extractMessage(source, event, parsed)
    });
    var notifyHost = ${hostExpr};
    var req = require("http").request("http://" + notifyHost + ":" + port + "/api/v1/notify", {
      method: "POST",
      timeout: 2000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
    });
    req.on("response", function(res) {
      res.resume();
      res.on("error", function() {});
    });
    req.on("finish", function() { process.exit(0); });
    req.on("error", function() { process.exit(0); });
    req.on("timeout", function() { req.destroy(); process.exit(0); });
    req.end(payload);
  } catch (e) {
    process.exit(0);
  }
}

if (inputMode === "argv") {
  send(positionalArgs[0] || "{}");
} else {
  var input = "";
  process.stdin.on("data", function(chunk) {
    input += chunk;
    // Some hook runners leave stdin open after writing the input, so like the CLI, send it once it parses.
    try { JSON.parse(input); } catch (e) { return; }
    send(input);
  });
  process.stdin.on("end", function() { send(input); });
  process.stdin.on("error", function() { send(input); });
  setTimeout(function() { send(input); }, 1000);
}
`;
}
