# Komla Self-Integration

Integrate this agent CLI with whichever Komla surfaces it supports: notifications, the Komla skill, and workspace trust. Komla already has built-in integrations for Claude Code, Codex, Antigravity CLI, and OpenCode; this workflow is for other CLIs.

## Workflow

### Phase 1: Investigate and propose

Keep the agent's configuration unchanged during this phase.

1. Identify the CLI and version. Inspect its official documentation, help output, and existing user-level configuration for lifecycle hooks (including tool activity, root versus subagent completion, and session/turn identity), a global, user-level folder of Agent Skills (see [Komla skill reference](#komla-skill-reference)), and whether it asks the user to trust each new folder (see [Workspace trust reference](#workspace-trust-reference)).
2. Classify each surface as **supported**, **unsupported**, or **uncertain**. For each supported surface, identify the evidence, exact global config file or CLI command, proposed settings, and any limitations involving payloads, asynchronous execution, approval flow, transport, or restarts.
3. Report the classification and exact proposed changes, including every file you would modify and anything the user must do manually.
4. End your turn and wait for the user's approval.

Phase 1 is complete only when every surface is classified and every proposed edit is backed by the CLI's documentation, help output, or existing config conventions.

### Phase 2: Apply and verify

Continue only after the user approves the proposal.

1. Apply only the approved global configuration, preserving unrelated settings. Change the agent's launch commands only through `komla settings apply agents`, which asks the user again.
2. Validate each changed file with the CLI's parser, status command, or another authoritative check; otherwise re-read it and report that only structural validation was possible.
3. Verify every configured surface as far as the CLI permits:
   - **Notifications:** run the exact configured command from the current workspace and confirm that Komla receives it. Exercise prompt → completion → renewed tool activity → root completion where supported; verify recovery and that a subagent finishing does not stop the root spinner. If receipt is visible only in the UI, ask the user to confirm the indicator.
   - **Komla skill:** use the CLI's skills list command or a fresh session to confirm that it lists the `komla` skill. If the current process cannot reload skills, say that a new agent session is required for the final check.
   - **Workspace trust:** start the CLI the way you configured it in a folder it hasn't seen, such as a new worktree of a scratch repository, and confirm that it doesn't ask. Then ask the user to start the agent from Komla in a new workspace and confirm the same.
4. Report each surface as verified, unverified with a reason and next check, or unsupported.
5. Tell the user that this session was only for setup: they can close this tab, or delete the workspace if it was created just for setup. Future Komla workspaces inherit the global configuration (on SSH, future workspaces on the same host). Offer the Komla CLI demo tour from Komla's tips menu.

Phase 2 is complete only when every configured surface has a reported verification result.

## Notification reference (outgoing)

Komla installs its CLI in every managed terminal. Run `komla notify` from lifecycle hooks and Komla
updates that workspace's attention indicators. The command resolves the terminal and desktop on its
own; on SSH it uses the Remote Companion's durable mailbox while the tunnel is unavailable.

If the CLI has no lifecycle hook or equivalent way to run a command or send an HTTP request on an event, classify notifications as unsupported.

### The hooks to wire up

Map each supported CLI event to the matching command. Replace `<agent>` with a short, stable source name for the CLI.

| When this happens                                                    | Command to run                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| the agent finishes its turn and stops working                        | `komla notify --source <agent> --event Stop`              |
| the agent starts a tool call                                         | `komla notify --source <agent> --event PreToolUse`        |
| the user sends the agent a new message                               | `komla notify --source <agent> --event UserPromptSubmit`  |
| the agent pauses to wait for the user to approve or answer something | `komla notify --source <agent> --event PermissionRequest` |
| the agent sends a later reminder while waiting on the user           | `komla notify --source <agent> --event Notification`      |
| the user cancels the turn and the agent stops without finishing      | `komla notify --source <agent> --event Interrupt`         |
| the turn ends on an error, such as a failed model request            | `komla notify --source <agent> --event StopFailure`       |

- **`Stop`** clears the working indicator after a short grace period. Wire it to root-agent turn completion. Subagent completion, intermediate responses, and individual tool completion must not emit a root `Stop`.
- **`UserPromptSubmit`** starts the working indicator and records the user prompt.
- **`PreToolUse`** reports activity independently of prompt submission. It restores the working indicator and clears stale completion attention when work resumes, without recording a prompt or sending a notification. Wire it only when the CLI documents a corresponding tool-start event.
- Configure `UserPromptSubmit` and `PreToolUse` only alongside a reliable root `Stop`, so the working indicator can clear. If tool hooks are unavailable, report that activity recovery is unavailable; ordinary terminal output is not proof that the agent is working.
- **`PermissionRequest`** surfaces an approval/input notification. **`Notification`** is an optional later reminder while waiting, not another turn-end signal.
- **`Interrupt`** stops the working indicator without a notification, and **`StopFailure`** ends the turn with an error instead of a completion; pass the error text with `--message` when the CLI provides it. Send either one instead of `Stop` for that turn, and wire them only when the CLI reports the root turn being cancelled or failing as a distinct event; otherwise its `Stop` covers those turns too. Activity reported shortly after either one is treated as late news from that turn until the next prompt.

Report only the root agent's lifecycle. If the CLI runs subagents or child sessions, leave their
events unhooked or send them with the subagent's `agent_id` so Komla ignores them; never send a
subagent's completion or prompt as a root `Stop` or `UserPromptSubmit`. A subagent's tool activity
may be sent as the root's `PreToolUse`, because the root turn is still working. If the CLI can end
the root turn while a subagent it started keeps running and resumes the root when it finishes, pass
`background_tasks: [{"type": "subagent", "status": "running"}]` in that `Stop` input when the CLI
reports it; otherwise report that the working indicator may clear early instead of working around
it.

For Gemini, use its native `BeforeTool` event with `--event BeforeTool`; pair it with
`BeforeAgent` and `AfterAgent`. Reset any completion deduplication when activity resumes, so a
quick later completion can stop the spinner.
For Grok Build, use `--source grok-build`, the name it reports its own state under. Grok also
runs the hooks Komla installs for Claude Code, which Komla ignores inside Grok, so they don't
count as an existing integration.

Pass the original JSON hook input on stdin. Preserve `hook_event_name`, `session_id`, and the
CLI's turn identifier (`turn_id` or `prompt_id`), plus `agent_id` for subagents when available.
Komla uses this metadata to ignore identifiable subagent and older-turn events. For other payload
names, document an evidence-backed adapter; do not invent identifiers or infer completion from text.
Activity or a new prompt cancels a pending completion during the grace period. Hooks without identity
metadata have weaker protection against delayed events; report that limitation.

Use the CLI's documented hook execution mode. Prefer ordered delivery for lifecycle events;
asynchronous hooks may arrive out of order. Keep activity hooks lightweight. If the hook runner
does not inherit Komla's managed `PATH`, use the absolute path from `KOMLA_CLI` as the command.

### Working directory

Komla matches a notification to a workspace by its managed terminal identity and current directory.
If hooks run elsewhere, pass `--cwd <workspace-path>`. A JSON hook payload may be supplied on stdin.

### Raw HTTP fallback

If the CLI's event system can send HTTP requests but cannot run a command, the notification surface
is unsupported by this workflow. Do not embed a port or hand-written request; Komla's CLI owns that
compatibility contract.

## On SSH

In a Komla SSH workspace, the agent and its hooks run on the remote host and may not inherit Komla's
managed `PATH`. Resolve the CLI to a literal path with `test -x "$KOMLA_CLI" && printf '%s\n' "$KOMLA_CLI"`
and use that path instead of `komla` in hook commands. The Komla skill goes on the host, as the
reference below describes; the host's Komla skill switch is on its tab in Settings →
Integrations & MCP. Leave Komla's managed runtime files on the host unchanged.

## When Windows blocks the Komla CLI

Windows can refuse to start `komla` on this computer, saying an application control policy blocked
it or that access is denied; Smart App Control does this to an unsigned CLI. A command that isn't
found, or a Komla that can't be reached, is a different problem. SSH workspaces run their
own CLI, so this applies only to local workspaces. In a WSL terminal, `komla` starts the same
blocked program and the fallback below can't run from Linux, so classify notifications and
the Komla skill as unsupported there. When Windows refuses it:

- **Notifications:** in place of `komla notify`, run Komla's fallback with the same events,
  `--cwd`, and stdin:
  `"{{komlaDir}}/komla-node.cmd" "{{komlaDir}}/notify.js" --source <agent> --event Stop`.
  cmd.exe parses these arguments again, so pass no free text on the command line: leave out
  `--message`, since notify.js reads a failure's text from the hook input's `error` field. Quote
  both paths and write them as the hook's shell expects: Git Bash needs forward slashes, and
  PowerShell needs the call operator (`& "<path>" "<path>" --source ...`). Komla rewrites both
  files at every launch, so point at them rather than copying them. A `.cmd` file needs a shell;
  if the hooks can only start a program directly, classify notifications as unsupported.
- **Komla skill:** `komla skill komla` is the same blocked program, so copy
  `{{komlaDir}}/skills/komla/SKILL.md` instead.
- **Workspace trust:** `komla settings` is the same blocked program, so give the user the commands
  to change under Settings → Agents instead.

At the end of setup, don't offer the Komla CLI demo tour: it runs the same blocked program.

## Workspace trust reference

Every Komla workspace is a new folder, usually a new git worktree of the same repository. A CLI that
asks the user to trust each new folder before it works there asks again in every workspace. Komla's
built-in presets avoid this for Codex and Antigravity CLI by passing an argument that trusts the
workspace's folder each time Komla starts them.

Find out whether the CLI asks, and what it remembers when the user accepts: the folder, the git
repository (so every worktree of a trusted repository skips the prompt, as with Claude Code), or a
folder and everything under it. Find out, too, whether a flag, environment variable or config entry
trusts a folder without asking. Test in a new scratch repository and a worktree of it, not in this
workspace, which the user may already have trusted.

Propose the first of these that works:

1. **Nothing to do:** the CLI doesn't ask, or trusting a repository once covers its worktrees.
2. **A launch argument:** add the flag or environment variable to the commands Komla starts the
   agent with, as below. It covers every workspace, on this computer, over SSH and in VMs. Prefer
   one that trusts the folder for that session without writing it to a config file.
3. **A trusted parent folder in the CLI's global config:** only when the CLI documents that trusting
   a folder covers everything under it. It covers only workspaces under that folder, such as the one
   holding this workspace's folder, and only on the computer whose config you change.
4. **Unsupported:** the user accepts the prompt once in each new workspace.

Trust is a security decision. Trusting a folder often lets the CLI load that repository's own
settings, hooks, MCP servers or instructions without asking, and a launch argument does that for
every repository the user opens in Komla, including ones they only cloned to read. Say what trusting
a folder allows this CLI to do, and let the user decide.

### Add the argument to the agent's launch commands

1. Run `komla settings get agents`. It lists each preset's `id`, `name` and the `program` it runs.
   Find the one that runs this CLI. If more than one does, ask the user which. If none does, the
   user starts the CLI some other way: tell them to add it under Settings → Agents, then continue.
2. Write `{"presets": [{"id": "<id>", "addArguments": "<arguments>"}]}` to a file. Komla adds the
   arguments right after the program in each command that runs it, including a launch mode's own
   command, and leaves the rest of each command as it is. Only arguments are accepted: no `;`, `&`,
   `|`, `<`, `>`, backticks, `$(` or `{{…}}` placeholders.
3. Komla runs these commands in the user's shell, in the workspace's folder. When the argument
   names the folder, write the current folder rather than a fixed path: `"$PWD"` in a POSIX shell
   such as bash, zsh or Git Bash, or `$PWD.ProviderPath` in PowerShell on Windows (`"$PWD"` there
   names a network folder in a form most CLIs don't match).
4. Run `komla settings apply agents --file <path>`. Komla shows each command before and after, and
   waits while the user decides. `"status": "applied"` means they applied them, `"cancelled"` that
   they didn't, and `"unchanged"` that the commands already have the arguments; fix each problem an
   `INVALID_SETTINGS` error lists and apply again.

You can't read or otherwise change the commands this way. For anything else, such as an environment
variable the CLI needs, give the user the change to make under Settings → Agents.

## Komla skill reference

The Komla skill tells the agent when and how to use the `komla` command: starting agents in new
workspaces or tabs, previews, workspace titles, snooze and the Trash, and the guides for project setup
and Komla's settings. `komla skill komla` prints it.

Install it only if the CLI loads Agent Skills: one folder per skill, holding a `SKILL.md` with `name`
and `description` frontmatter. Use the CLI's **global, user-level** skills folder, not one inside
the repo: every Komla workspace is a separate worktree, so a project-level skill would be missing
from every other workspace.

- **The CLI reads `~/.agents/skills` or `~/.claude/skills`:** Komla's Komla skill switch, in
  Settings → Integrations & MCP, writes the skill to both and keeps it up to date. Propose turning it
  on rather than copying the skill; if it's already on, the skill is there.
- **It reads only its own folder:** write the output of `komla skill komla`, unchanged, to
  `komla/SKILL.md` there. This copy doesn't update itself; running this setup again updates it.

If the CLI has no skills support, classify the skill as unsupported: the `komla` command still works
in its terminals.
