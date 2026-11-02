---
status: accepted
---

# A typed TypeScript SDK over Komla Operations, with one client and several transports

Scripts, hooks and plugins reach Komla through the `komla` CLI or MCP. Code that wants to tag a
workspace or launch an agent shells out to `komla` and parses its JSON, which loses the types Komla
already has. ADR 0007 also foresees plugin code that keeps state and follows events, run in a plugin
host with a typed API. Both need one typed client in TypeScript.

The **Komla SDK** (`@komla/sdk`) is a third adapter over Komla Operations, beside the CLI and MCP.
It owns no workspace, selection, authorization, persistence or UI rules. A call sends the same
typed operation `komla` sends, and Komla runs it with the same capability checks and context
resolution:

```
komla CLI ──────────┐
MCP ────────────────┤
@komla/sdk ─────────┼──► Komla Operations ──► workspaces, agents, tags, status, settings…
  over local HTTP   │      (main process)
  over a MessagePort┘  (plugin host; later)
        ▲
        └── sidebar panel page, over postMessage (later)
```

Its main consumer will be the plugin host. A plugin's `komla-plugin.json` may name a `main`
TypeScript file, which Komla loads without a build step in an Electron `utilityProcess` and calls as
`activate(komla)`. `komla` is an SDK client. A crashing or busy plugin then can't freeze Komla or
reach the renderer. Scripts, hooks and code on SSH hosts use the same client over Komla's local HTTP
server. Today's command-and-JSON contributions stay the simple path. Step 1 builds only the client,
its HTTP transport and the type generation. The plugin host, events and panel pages come later, on
this design.

- **One client, pluggable transports.** The client turns typed calls into operation requests and
  results, and checks the capabilities its consumer declared. A transport carries a request and
  returns its result or a `KomlaError` with Komla's error code, message and details. HTTP is the
  first transport. A MessagePort between the plugin host and the main process will be the second:
  no port, no HTTP parsing, and a context Komla sets for each plugin rather than one the plugin
  claims. The client entry (`@komla/sdk/client`) uses no Node APIs, so a sandboxed page can load it.
- **HTTP transport.** It posts the operation as JSON to `/api/v1/commands`, the route the CLI and
  the companion's outbox (ADR 0006) use, and reads `{ ok, result }` or `{ ok: false, error }`. It
  names its context as the CLI does. A managed terminal's `KOMLA_API_URL` carries its terminal
  (`/terminals/<id>`). Otherwise the transport sends `X-Komla-Terminal-Id` and
  `X-Komla-Workspace-Id` when it has them, and the caller's `cwd` as a query when it has no
  terminal. `X-Komla-Target-Workspace-Id` replaces the calling workspace when a call names a
  workspace, as `--workspace` does.
- **Discovery.** The order is the CLI's: an explicit URL, then the managed tmux session's
  environment on an SSH host, re-read before each request because another installation that takes
  over the session rewrites it, then `KOMLA_API_URL` and the other `KOMLA_*` variables, then the
  `port` file in Komla's data folder. That folder is `KOMLA_DATA_DIR`, else the folder above the
  `bin` or `helpers` that `KOMLA_CLI` sits in, else `~/.komla`. The rules are small and written
  down in docs/CLI.md, and both sides have tests for them.
- **SSH hosts.** In a managed terminal on a host, `KOMLA_API_URL` leads through the host's tunnel.
  Komla tags such requests with the host and never lets them reach past it, so the SDK gets the
  CLI's limits for free. In step 1 the SDK doesn't find a desktop from outside every workspace on
  a host through the companion routes, and doesn't queue commands while Komla is away (ADR 0006).
  It fails with `KOMLA_UNREACHABLE`, and scripts that need either use the CLI. Both can come later
  without changing the client.
- **Types that can't drift.** The request types come from the Zod schema that
  `parseKomlaOperation` validates requests with. The result types come from result schemas next to
  it: the operation service's return types are derived from them, and the operation tests check
  every result they produce against them, so a new field fails a test until the schema has it. A
  table of which capability each operation needs is the one the service checks before it runs an
  operation. A generator renders the three, by way of JSON Schema, into the SDK's checked-in
  `src/generated.ts`. A desktop test fails while that file differs from what the generator renders,
  and `npm run generate:sdk` rewrites it. Refinements that types can't express, such as a status
  item's length without its terminal colors, stay with Komla, which reports them as
  `INVALID_OPERATION` with the issues.
- **Compatibility.** Requests are strict: Komla rejects a field it doesn't know. An SDK newer than
  the Komla it reaches therefore fails on a new field with `INVALID_OPERATION` rather than having
  it silently ignored. Operations change only by adding optional fields and new results.

## Security

A turned-off capability is off for every adapter. The user's toggles in Settings → Integrations &
MCP → MCP and CLI access apply to SDK calls as they do to CLI commands and MCP tools, because Komla
Operations check them and the SDK can't skip that.

The threat the SDK adds is escalation through text it shows. A status item, tag or panel shows a
pull request title or a log line, and that text must not be able to start an agent or run a
command, which a prompt injected into the text would ask for. So:

- **Declared capabilities.** A client lists the capabilities it uses, and it refuses any other
  operation with `CAPABILITY_NOT_DECLARED` before sending a request. Its TypeScript type has no
  methods for the others. A client that declares nothing can read (context, workspaces, tags and
  agent presets) and do what the CLI does without a capability: notify, wake a snoozed workspace
  and refresh a status-items.json item. A status-item script declares `status.set`, so no bug that
  carries outside text can make it launch an agent.
- **Risk.** Reading, and later subscribing to events, is low-risk: it changes nothing. Showing
  something (`workspace.notify`, `status.set`, `workspace.tag`, `workspace.title`, snooze,
  `preview.open`) changes only what Komla shows. Launching an agent (`agent.launch.tab`,
  `agent.launch.workspace`) runs code with a prompt the caller wrote, as typing into another
  agent's terminal (`terminal.send`) does, and moving a workspace to the Trash, linking workspaces
  and opening folders reach past what's on screen. These are the risky capabilities. Reading a
  terminal (`terminal.read`) is reading, though what it shows may be private.
- **Where declarations are enforced.** The boundary that matters is the process. A local script
  runs as the user, who could already run `komla agent launch`, and the local HTTP server has no
  credential that tells an SDK script from the CLI: it listens on 127.0.0.1 and refuses web pages
  by `Host`, `Origin` and `Sec-Fetch-Site`. A terminal id there is context, not a secret. For
  scripts, declarations are therefore a least-privilege guard against their own mistakes, not a
  wall. Komla doesn't ask them to confirm launches the CLI doesn't confirm, as a confirmation the
  caller requests itself can be skipped by calling the CLI.
- **Plugin code is trusted as plugin commands are.** Komla runs a plugin only once the user turns it
  on, and stops it when its files change from the digest the user approved (ADR 0007). An enabled
  plugin can already run any shell command, so its `main` isn't sandboxed by capability. The client
  Komla passes to `activate` declares every capability, and the user's toggles still apply.
- **Panel pages are untrusted.** A sidebar panel's page shows outside text, so it runs as a
  sandboxed iframe with an opaque origin and no network route to Komla. It talks over postMessage
  to its own plugin's code, which holds the power, and may get an SDK client whose other end is
  Komla, not the page. That end enforces the capabilities the panel's manifest declares, approved
  with the plugin's digest. Low-risk ones run without asking. A risky one asks the user each time,
  showing what it would do, such as the prompt and where the agent starts, as confirmed settings
  changes do (ADR 0004).

## Later

- **Events.** Typed events (`agent.done`, `agent.needs-input`, workspace created and trashed,
  Working Tree Snapshot and branch changes) get an event schema generated into the SDK the same
  way. Clients subscribe with `komla.on(…)`. Over HTTP, events come as server-sent events from a
  route scoped as `workspace.list` is, so a request through an SSH host's tunnel sees only that
  host's workspaces. Over the MessagePort and postMessage, they come on the same channel.
  Subscribing is low-risk, but event payloads such as a branch name are outside text.
  Status items and panels name the events that refresh them with `refreshOn`.
- **Plugin host.** Komla loads `main` in a `utilityProcess` and hands it a MessagePort transport.
  The plugin registers status items, panels, hooks and commands through the client, and Komla
  stops the process when the plugin is turned off or its files change.
- **Panel bridge.** A postMessage transport for `@komla/sdk/client`, with Komla's stylesheet and
  live theme updates for the page.
- **Notifications.** Integrations show their own notifications and badges with
  `workspace.notify`, the operation for what `komla notify <title>` sends: a title, body, kind,
  color, badge and icon. Komla shows it as it shows a notification over `/api/v1/notify` and, like
  that route, refuses it while the user has turned the hooks endpoint off. Agents' lifecycle hooks
  (`komla notify --event`) stay on `/api/v1/notify`: they are an agent's hook protocol, with session
  and turn identity and the companion's durable mailbox on SSH hosts, not an integration's call.
  Over HTTP the SDK sends a hook's notification as the `hook` source, as the CLI does, so it sets
  off no hooks. Unlike the CLI on an SSH host, it doesn't queue the notification while Komla is
  away.
- **Settings.** The confirmed settings resources (ADR 0004) are routes of their own, not Komla
  Operations, so the SDK leaves them out until they become operations. A second contract for them
  would drift.
- **Credentials.** Should Komla need to tell scripts apart, to enforce their declarations, confirm
  their launches or show who did what, the HTTP transport can carry a per-client token the user
  issues. Nothing in the client changes.

## Considered options

- Wrap the CLI, spawning `komla` for each call: rejected because the CLI renders output for people
  and agents, has no generic operation command by design, and would cost a process for each call.
  The CLI itself speaks HTTP to the same route.
- Build on MCP: rejected because MCP exposes four tools, has an on/off switch of its own and wraps
  results in envelopes meant for models.
- Write the SDK's types by hand: rejected because they would drift from the schemas Komla validates
  with, as nothing would check them.
- Sandbox plugin code by capability: rejected because an enabled plugin already runs shell commands
  the user approved, so a capability sandbox around its JavaScript would stop nothing.
