//! `komla --help`: an index of the commands by what they're for, and a page for each command with
//! its options and examples. Text is wrapped at render time, so entries hold plain sentences.

const WIDTH: usize = 80;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Group {
    Workspaces,
    Agents,
    Status,
    Settings,
    More,
    Komla,
}

const GROUPS: [(Group, &str); 6] = [
    (Group::Workspaces, "This workspace"),
    (Group::Agents, "Agents"),
    (Group::Status, "Notifications and the status bar"),
    (Group::Settings, "Settings and guides"),
    (Group::More, "More"),
    (Group::Komla, "Used by Komla and its integrations"),
];

struct Command {
    group: Group,
    /// The words that name it, such as `status set`.
    name: &'static str,
    /// What follows the name in the index, such as `<tag>`.
    index: &'static str,
    /// What follows the name on each usage line.
    usages: &'static [&'static str],
    /// The index's line for it.
    summary: &'static str,
    /// Paragraphs for its page.
    description: &'static [&'static str],
    options: &'static [(&'static str, &'static str)],
    examples: &'static [&'static str],
}

const JSON: (&str, &str) = ("--json", "Print the result as JSON.");

const COMMANDS: &[Command] = &[
    Command {
        group: Group::Workspaces,
        name: "title",
        index: "<title>",
        usages: &["<title> [--description <text>] [--json]"],
        summary: "Set its title and description in the sidebar",
        description: &["Updates the current workspace's title, and its description with --description."],
        options: &[("--description <text>", "The description under the title."), JSON],
        examples: &["komla title \"Login fix\" --description \"Fix the flaky login test\""],
    },
    Command {
        group: Group::Workspaces,
        name: "tags",
        index: "",
        usages: &["[--json]"],
        summary: "List the user's tags, to reuse one",
        description: &["Lists the user's tags, which komla tag gives a workspace with the look the user gave them."],
        options: &[JSON],
        examples: &["komla tags"],
    },
    Command {
        group: Group::Workspaces,
        name: "tag",
        index: "<tag>",
        usages: &["<tag> [options]"],
        summary: "Say on its card what it waits on",
        description: &[
            "Tags the current workspace to say what it waits on, such as \"In review\", or what a script sees, such as \"CI running\". The tag shows on its card while no agent is busy there, until it's taken off or replaced. A workspace has one tag, so this replaces the user's.",
            "A tag the user doesn't have yet joins their list with --tone, --icon and --spinner; one they have keeps the look they gave it. `komla tags` lists them.",
        ],
        options: &[
            ("--tone <tone>", "neutral, info, attention, success, warning or error."),
            ("--icon <file|svg>", "An image in place of the tag glyph, in the tag's color: a file or SVG markup."),
            ("--spinner", "A spinner in place of the glyph, for work under way."),
            ("--tooltip <text>", "More on hover, until the tag changes."),
            ("--if <tag>", "Change only a workspace that has that tag, so a script leaves alone a tag the user put on since."),
            JSON,
        ],
        examples: &[
            "komla tag \"CI running\" --spinner --tone info",
            "komla tag \"CI failed\" --tone error --if \"CI running\"",
        ],
    },
    Command {
        group: Group::Workspaces,
        name: "untag",
        index: "[<tag>]",
        usages: &["[<tag>] [--json]"],
        summary: "Take its tag off",
        description: &["Takes the current workspace's tag off, or only that tag, so a script leaves alone a tag the user put on since."],
        options: &[JSON],
        examples: &["komla untag \"CI running\""],
    },
    Command {
        group: Group::Workspaces,
        name: "snooze",
        index: "<when>",
        usages: &["<30m|2h|1d|17:30|YYYY-MM-DD HH:MM> [--until-notified] [--json]", "--until-notified [--json]"],
        summary: "Hide it until a time or its next notification",
        description: &[
            "Hides the current workspace on the sidebar's Snoozed shelf until then, in Komla's time zone. It comes back marked Woke, or sooner when an agent there needs input or fails.",
        ],
        options: &[
            ("--until-notified", "Also wake it at its next notification, such as an agent's turn ending there, komla notify or a background Quick Command. The time is then optional."),
            JSON,
        ],
        examples: &["komla snooze 2h", "komla snooze --until-notified"],
    },
    Command {
        group: Group::Workspaces,
        name: "wake",
        index: "",
        usages: &["[--json]"],
        summary: "End its snooze now",
        description: &["Ends the current workspace's snooze now, marked Woke, such as when a job it waits on ends."],
        options: &[JSON],
        examples: &[],
    },
    Command {
        group: Group::Workspaces,
        name: "trash",
        index: "",
        usages: &["[--json]"],
        summary: "Move it to the Trash once your turn ends",
        description: &[
            "Moves the current workspace to the Trash once the agent's turn finishes, stopping its terminals; the user can restore it for 7 days. It stays when the turn is interrupted or fails, or when another tab's agent works, waits for input or failed.",
            "Run it last: when Komla can't follow the agent's turns, it moves a second later. It acts only on the current workspace, so it takes no --workspace.",
        ],
        options: &[JSON],
        examples: &[],
    },
    Command {
        group: Group::Workspaces,
        name: "workspace list",
        index: "",
        usages: &["[--all] [--json]"],
        summary: "List workspaces and their ids, for --workspace",
        description: &[
            "Lists the workspaces with their ids, branches, attention and tags. `komla workspace <title|snooze|wake|tag|untag|trash>` is the same as the command without `workspace`.",
            "On an SSH host that can't reach Komla, it lists the host's own workspaces, without the tags, attention and agent state only Komla knows.",
        ],
        options: &[("--all", "Also list those in the Trash."), JSON],
        examples: &["komla workspace list --json"],
    },
    Command {
        group: Group::Agents,
        name: "launch",
        index: "[prompt]",
        usages: &["[prompt] [options]"],
        summary: "Start an agent in a new workspace or a tab",
        description: &["Starts an agent in a new isolated workspace, or in a new tab of this one with --here, with the prompt as its first message."],
        options: &[
            ("--here", "Open a tab in the current workspace instead."),
            ("--preset <name-or-id>", "The agent to start, from `komla agent presets`."),
            ("--mode <id>", "One of that agent's launch modes."),
            ("--prompt-file <path|->", "Read the prompt from a file, or stdin with -."),
            ("--project <name-or-id>", "The project for the new workspace. Outside every workspace, such as in an SSH host's shell, it's required, and leaving it out lists the projects."),
            ("--name <name>", "The new workspace's title."),
            ("--description <text>", "The new workspace's description."),
            ("--branch <name>", "The new workspace's branch."),
            ("--from-current-branch", "Branch from this workspace's branch instead of the base branch."),
            JSON,
        ],
        examples: &[
            "komla launch \"Fix the flaky login test\"",
            "komla launch --here --preset codex \"Review the diff\"",
        ],
    },
    Command {
        group: Group::Agents,
        name: "agent presets",
        index: "",
        usages: &["[--all] [--json]"],
        summary: "List the agents and modes launch can start",
        description: &[
            "Lists agent presets and their modes, for --preset and --mode. Presets marked inactive or unavailable can't be launched, nor can modes marked unavailable; --json says why. A mode marked isolated SSH host starts only on an SSH host the user marked isolated.",
        ],
        options: &[("--all", "Also list inactive presets."), JSON],
        examples: &[],
    },
    Command {
        group: Group::Status,
        name: "notify",
        index: "<title>",
        usages: &["<title> [options]", "[<title>] -- <command> [arguments]"],
        summary: "Notify, or run a command and notify when it ends",
        description: &[
            "Shows a notification for the current workspace. Its title shows on the sidebar card, or --badge's shorter text with the title on hover, so keep it to a word or two.",
            "With -- <command>, runs the command with the terminal's input and output, showing its tab as working, then notifies Done, or Failed with its exit code, and exits as it did. A title replaces both Done and Failed, so only the color then says which; the options and --workspace don't apply.",
            "Agent CLIs report their hook events with --source <agent> --event <event>, as `komla skill self-integration` sets up.",
        ],
        options: &[
            ("--body <text>", "More on the card's hover."),
            ("--kind <kind>", "input-required, turn-complete, error, idle or generic, which sets its glyph and color."),
            ("--color <color>", "success, warning, error, info, attention, muted or a CSS color."),
            ("--badge <text>", "Shorter text for the card, with the title on hover."),
            ("--icon <file|svg>", "An image in place of the kind's glyph."),
            ("--icon-color <color>", "The icon's shape in a color."),
        ],
        examples: &[
            "komla notify -- npm run test:e2e",
            "komla notify \"CI failed\" --badge CI --color error",
        ],
    },
    Command {
        group: Group::Status,
        name: "status set",
        index: "<id> <text>",
        usages: &["<id> <text> [options]", "<id> --segments <json> [options]"],
        summary: "Show a short status in the status bar",
        description: &[
            "Shows a short status, such as test results, in Komla's status bar while the current workspace is open, until Komla quits. Setting an id again replaces it. The text can carry Nerd Font icons and terminal colors for parts of it.",
        ],
        options: &[
            ("--tone <tone>", "A dot of success, warning, error or info."),
            ("--color <color>", "The text's color: success, warning, error, info, muted, foreground or a hex color."),
            ("--icon <file|svg>", "An image before the text: SVG, PNG, WebP, GIF or JPEG, up to 32 KB, or SVG markup."),
            ("--icon-color <color>", "The icon's shape in a color, such as foreground for a one-color logo."),
            ("--tooltip <text>", "Text on hover."),
            ("--link <url>", "A page the item opens, or with --popover a button below it."),
            ("--popover <markdown>", "Markdown shown when the item is clicked."),
            ("--popover-file <path|->", "The popover's Markdown from a file, or stdin with -."),
            ("--segments <json>", "Parts in place of the text, to put icons anywhere, such as [{\"icon\":\"logo.svg\"},{\"text\":\" CI\",\"color\":\"success\"}]."),
            ("--segments-file <path|->", "The segments from a file, or stdin with -."),
            JSON,
        ],
        examples: &["komla status set tests \"142/150 passing\" --tone warning"],
    },
    Command {
        group: Group::Status,
        name: "status clear",
        index: "[id]",
        usages: &["[id] [--json]"],
        summary: "Clear one status, or all of this workspace's",
        description: &["Clears one status item komla status set showed, or all of the current workspace's."],
        options: &[JSON],
        examples: &[],
    },
    Command {
        group: Group::Status,
        name: "status refresh",
        index: "<id>",
        usages: &["<id> [--json]"],
        summary: "Run a status bar item's command again now",
        description: &["Runs a status-items.json item's command again now and waits for it, as from a hook or a Quick Command when what it shows changed."],
        options: &[JSON],
        examples: &["komla status refresh tests"],
    },
    Command {
        group: Group::Settings,
        name: "settings",
        index: "<get|apply>",
        usages: &["get <resource> [--scope <scope>]", "apply <resource> [--scope <scope>] [--file <path>]"],
        summary: "Read settings, or change them once confirmed",
        description: &[
            "Reads or replaces Quick Commands (actions), Workspace Setup (workspace-setup), the project's automations, the theme (appearance), status bar items (status-items), hooks, keyboard shortcuts (shortcuts), terminal settings (terminal), or agent presets' arguments and level pickers (agents).",
            "apply takes JSON on stdin or from --file and waits while Komla shows the change and the user applies or cancels it.",
        ],
        options: &[
            ("--scope <scope>", "For actions: global, or current-project for this project's."),
            ("--file <path>", "For apply: the JSON to apply, in place of stdin."),
        ],
        examples: &[
            "komla settings get actions --scope current-project",
            "komla settings apply hooks --file hooks.json",
        ],
    },
    Command {
        group: Group::Settings,
        name: "settings schema",
        index: "<resource>",
        usages: &["<resource> [--json]"],
        summary: "List the fields a settings file takes",
        description: &["Prints the fields status-items, hooks, shortcuts, terminal or agents take, with their limits, defaults and what they do."],
        options: &[("--json", "Print it as JSON Schema.")],
        examples: &["komla settings schema hooks"],
    },
    Command {
        group: Group::Settings,
        name: "skill",
        index: "<guide>",
        usages: &["<guide>"],
        summary: "Print a guide for an agent to follow",
        description: &[
            "Prints a guide for an agent to follow. customize, status-items, automations, project-setup and appearance change Komla's settings. onboarding-demo and self-integration are flows Komla's own prompts start: a tour of the CLI, and connecting an agent CLI Komla doesn't support out of the box.",
        ],
        options: &[],
        examples: &["komla skill customize"],
    },
    Command {
        group: Group::Settings,
        name: "context",
        index: "",
        usages: &["[--json]"],
        summary: "Show the workspace and terminal commands act on",
        description: &["Shows the project, workspace and terminal that commands target."],
        options: &[JSON],
        examples: &[],
    },
    Command {
        group: Group::More,
        name: "open",
        index: "[folder]",
        usages: &["[folder] [--json]"],
        summary: "Open a folder on this computer in Komla",
        description: &["Opens a folder on this computer, the current one by default, in Komla as Open Folder does: a workspace of its own, or the one already open there. No agent starts."],
        options: &[JSON],
        examples: &["komla open ~/notes"],
    },
    Command {
        group: Group::More,
        name: "preview",
        index: "[url]",
        usages: &["[url] [--json]"],
        summary: "Open a dev server in Komla's browser preview",
        description: &["Opens a running dev server in Komla's browser preview, once it responds. `komla preview open` is the same."],
        options: &[JSON],
        examples: &["komla preview http://localhost:3000"],
    },
    Command {
        group: Group::More,
        name: "desktop run",
        index: "<command>",
        usages: &["[--browser | --app] [--] <command> [arguments]"],
        summary: "Run a GUI app, on a virtual desktop if needed",
        description: &[
            "Runs a GUI app. On Linux without a display, such as on an SSH host, it runs on a virtual desktop of its own, listed under Komla's globe button to open in a VNC app or Komla's browser preview. `komla desktop --help` describes it and desktop start, status and stop.",
        ],
        options: &[
            ("--app", "Open the desktop in the VNC app right away."),
            ("--browser", "Open it in Komla's browser preview right away."),
        ],
        examples: &["komla desktop run -- npm run electron"],
    },
    Command {
        group: Group::More,
        name: "mcp",
        index: "",
        usages: &[""],
        summary: "Serve Komla's MCP tools over stdio",
        description: &["Serves Komla's MCP tools over stdio, for clients that require an MCP server."],
        options: &[],
        examples: &[],
    },
    Command {
        group: Group::More,
        name: "version",
        index: "",
        usages: &[""],
        summary: "Print this CLI's version as JSON",
        description: &["Prints this CLI's version and protocol version as JSON."],
        options: &[],
        examples: &[],
    },
    Command {
        group: Group::Komla,
        name: "agent launch",
        index: "[prompt]",
        usages: &["[prompt] [--new-workspace] [options]"],
        summary: "launch's older form, which opens a tab",
        description: &["The older form of komla launch, which opens a tab in the current workspace unless --new-workspace is given. It takes launch's other options."],
        options: &[("--new-workspace", "Start the agent in a new workspace.")],
        examples: &[],
    },
    Command {
        group: Group::Komla,
        name: "git snapshot",
        index: "",
        usages: &["[-C <path>] [--target <branch>]"],
        summary: "Print a repository's state as JSON",
        description: &["Prints the repository's branch, changes and target branch state as JSON, for Komla."],
        options: &[("-C <path>", "The repository, in place of the current folder."), ("--target <branch>", "The branch to compare with.")],
        examples: &[],
    },
    Command {
        group: Group::Komla,
        name: "git target",
        index: "<operation>",
        usages: &["<push|pull|merge-remote|merge-source|sync> [-C <path>] [--target <branch>]"],
        summary: "Sync a branch with its target branch",
        description: &["Pushes, pulls or merges between a workspace's branch and its target branch, for Komla."],
        options: &[("-C <path>", "The repository, in place of the current folder."), ("--target <branch>", "The target branch.")],
        examples: &[],
    },
    Command {
        group: Group::Komla,
        name: "automation",
        index: "<operation>",
        usages: &["<list|save|enable|disable|delete|run|tick> [arguments]"],
        summary: "Manage this SSH host's automations",
        description: &["Manages the agent tasks this SSH host starts on a schedule from its crontab: list, save, enable, disable, delete, run and tick. Komla's Automations settings use it."],
        options: &[],
        examples: &[],
    },
];

/// Options most commands that act on a workspace take.
const COMMON_OPTIONS: [(&str, &str); 2] = [
    ("--workspace <id>", "Act on another workspace, by its id"),
    ("--json", "Print the result as JSON"),
];

/// The index: each command's name and one line, grouped by what it's for.
pub(crate) fn index() -> String {
    let mut out = String::from(
        "komla: work with Komla from a terminal in one of its workspaces\n\nusage: komla <command> [arguments]\n",
    );
    let label = |command: &Command| join(command.name, command.index);
    let column = COMMANDS
        .iter()
        .map(|command| label(command).len())
        .max()
        .unwrap_or(0)
        + 4;
    let column = column.max(
        COMMON_OPTIONS
            .iter()
            .map(|(option, _)| option.len())
            .max()
            .unwrap_or(0)
            + 4,
    );
    for (group, title) in GROUPS {
        out.push_str(&format!("\n{title}\n"));
        for command in COMMANDS.iter().filter(|command| command.group == group) {
            out.push_str(&row(&label(command), command.summary, column));
        }
    }
    out.push_str("\nOptions for commands that act on a workspace\n");
    for (option, description) in COMMON_OPTIONS {
        out.push_str(&row(option, description, column));
    }
    out.push_str("\nRun `komla <command> --help` for a command's options and examples.\n");
    out
}

/// The pages for the command `words` name, such as `tag` or `status`, or `None` when none does.
pub(crate) fn command(words: &[&str]) -> Option<String> {
    // `workspace tag` and the rest are `tag` and the rest for another workspace.
    let words = match words {
        ["workspace", "title" | "snooze" | "wake" | "tag" | "untag" | "trash", ..] => &words[1..],
        _ => words,
    };
    if words.is_empty() {
        return None;
    }
    let name = |command: &Command| command.name.split(' ').collect::<Vec<_>>();
    // The commands the words name or start, such as each `status` command for `status`.
    let mut matching: Vec<&Command> = COMMANDS
        .iter()
        .filter(|command| name(command).starts_with(words))
        .collect();
    // Otherwise the command the words go on to give arguments to, such as `tag` for `tag CI`.
    if matching.is_empty() {
        let given = |command: &&Command| words.starts_with(&name(command));
        let longest = COMMANDS
            .iter()
            .filter(given)
            .map(|command| name(command).len())
            .max();
        matching = COMMANDS
            .iter()
            .filter(|command| given(command) && Some(name(command).len()) == longest)
            .collect();
    }
    if matching.is_empty() {
        return None;
    }
    let pages: Vec<String> = matching.into_iter().map(page).collect();
    Some(pages.join("\n"))
}

fn page(command: &Command) -> String {
    let mut out = String::new();
    for (index, usage) in command.usages.iter().enumerate() {
        let prefix = if index == 0 { "usage: " } else { "       " };
        out.push_str(&wrap(
            &format!(
                "{prefix}{}",
                join(&format!("komla {}", command.name), usage)
            ),
            "",
            "         ",
        ));
    }
    for paragraph in command.description {
        out.push('\n');
        out.push_str(&wrap(paragraph, "", ""));
    }
    if !command.options.is_empty() {
        out.push_str("\noptions:\n");
        let column = command
            .options
            .iter()
            .map(|(option, _)| option.len())
            .max()
            .unwrap_or(0)
            + 4;
        for (option, description) in command.options {
            out.push_str(&row(option, description, column.min(28)));
        }
    }
    if !command.examples.is_empty() {
        out.push_str("\nexamples:\n");
        for example in command.examples {
            out.push_str(&format!("  {example}\n"));
        }
    }
    out
}

/// A label and its text, the text in a column from `column` and wrapped under itself.
fn row(label: &str, text: &str, column: usize) -> String {
    let indent = " ".repeat(column);
    let label = format!("  {label}");
    if label.len() + 2 > column {
        format!("{label}\n{}", wrap(text, &indent, &indent))
    } else {
        let first = format!("{label}{}", " ".repeat(column - label.len()));
        wrap(text, &first, &indent)
    }
}

/// Text wrapped at WIDTH, its first line after `first` and the rest after `rest`.
fn wrap(text: &str, first: &str, rest: &str) -> String {
    let mut out = String::new();
    let mut line = first.to_owned();
    let mut empty = true;
    for word in text.split(' ') {
        if !empty && line.chars().count() + 1 + word.chars().count() > WIDTH {
            out.push_str(line.trim_end());
            out.push('\n');
            line = rest.to_owned();
            empty = true;
        }
        if !empty {
            line.push(' ');
        }
        line.push_str(word);
        empty = false;
    }
    out.push_str(line.trim_end());
    out.push('\n');
    out
}

fn join(name: &str, arguments: &str) -> String {
    if arguments.is_empty() {
        name.to_owned()
    } else {
        format!("{name} {arguments}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_line_fits_the_terminal() {
        let pages = COMMANDS.iter().map(page);
        for text in std::iter::once(index()).chain(pages) {
            for line in text.lines() {
                assert!(line.chars().count() <= WIDTH, "{line:?}");
            }
        }
    }

    #[test]
    fn the_index_lists_each_command_once_in_its_group() {
        let index = index();
        for command in COMMANDS {
            let label = format!("\n  {} ", join(command.name, command.index));
            assert_eq!(index.matches(&label).count(), 1, "{label:?}");
        }
        assert!(
            index.contains("\nThis workspace\n  title <title>"),
            "{index}"
        );
        assert!(
            index.ends_with("Run `komla <command> --help` for a command's options and examples.\n")
        );
    }

    #[test]
    fn a_page_shows_the_command_its_options_and_examples() {
        let tag = command(&["tag", "CI running"]).unwrap();
        assert!(
            tag.starts_with("usage: komla tag <tag> [options]\n\nTags the current workspace"),
            "{tag}"
        );
        assert!(tag.contains("\noptions:\n  --tone <tone>"), "{tag}");
        assert!(
            tag.contains("\nexamples:\n  komla tag \"CI running\" --spinner --tone info\n"),
            "{tag}"
        );
        assert!(!tag.contains("untag"), "{tag}");
        assert_eq!(command(&["workspace", "tag"]), Some(tag));
        let tags = command(&["tags"]).unwrap();
        assert!(tags.starts_with("usage: komla tags [--json]\n"), "{tags}");
        assert!(!tags.contains("komla tag <tag>"), "{tags}");

        let notify = command(&["notify"]).unwrap();
        assert!(notify.contains("usage: komla notify <title> [options]\n       komla notify [<title>] -- <command> [arguments]\n"), "{notify}");
    }

    #[test]
    fn a_command_with_subcommands_shows_each_until_one_is_named() {
        let status = command(&["status"]).unwrap();
        for name in ["status set", "status clear", "status refresh"] {
            assert!(
                status.contains(&format!("usage: komla {name} ")),
                "{status}"
            );
        }
        let set = command(&["status", "set", "ci"]).unwrap();
        assert!(!set.contains("status clear"), "{set}");

        let get = command(&["settings", "get", "hooks"]).unwrap();
        assert!(
            get.starts_with("usage: komla settings get <resource>"),
            "{get}"
        );
        assert!(!get.contains("settings schema"), "{get}");
        assert_eq!(
            command(&["settings"]).unwrap().matches("usage: ").count(),
            2
        );

        assert_eq!(command(&[]), None);
        assert_eq!(command(&["nonsense"]), None);
    }

    #[test]
    fn long_text_wraps_under_its_column() {
        assert_eq!(
            row("--if <tag>", &"word ".repeat(20), 16),
            format!(
                "  --if <tag>    {}\n{}{}\n",
                "word ".repeat(13).trim_end(),
                " ".repeat(16),
                "word ".repeat(7).trim_end()
            )
        );
        assert!(row("--a-very-long-option <value>", "Text.", 16)
            .starts_with("  --a-very-long-option <value>\n                Text."));
    }

    #[test]
    fn help_leaves_out_internal_entrypoints() {
        let pages: String = COMMANDS.iter().map(page).collect();
        for text in [index(), pages] {
            assert!(!text.contains("sidecar"));
            assert!(!text.contains("__companion"));
        }
    }
}
