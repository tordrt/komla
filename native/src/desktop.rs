//! `komla desktop`: runs GUI apps where there is no display, such as on an SSH host, each on a
//! virtual X desktop of its own that Komla shows in its browser preview through noVNC, or in a
//! VNC app such as Screen Sharing. Where a desktop exists, `run` just starts the app, so one Action
//! works in local and SSH workspaces alike.

use std::env;
#[cfg(any(windows, test))]
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context};

const DESKTOP_USAGE: &str = "usage: komla desktop <run|start|status|stop>\n\n\
  run [--browser | --app] [--] <command> [arguments]\n    Runs a GUI app. On Linux without a display, such as on an SSH host, it runs on a virtual\n    desktop of its own, which Komla lists under its globe button to open in the app your\n    computer opens vnc:// links with, such as Screen Sharing on macOS, or in a tab of Komla's\n    browser preview. --app opens it in that app right away, and --browser in a tab. The desktop\n    stops when the app exits. Run from a terminal on a virtual desktop, the app opens on that\n    desktop.\n  start\n    Starts a virtual desktop for apps you start yourself, which runs until stopped.\n  status\n    Lists the virtual desktops, with their VNC ports and how to start apps on them.\n  stop [:<number>]\n    Stops every virtual desktop, or the one numbered, and the apps on it.\n\n\
Virtual desktops need Xvnc (tigervnc-standalone-server) and, for the browser preview, novnc and\nwebsockify; openbox adds window decorations.";

const RUN_USAGE: &str = "usage: komla desktop run [--browser | --app] [--] <command> [arguments]";

/// Where `desktop run` was asked to open the desktop right away. Without either, Komla only
/// lists it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Viewer {
    /// `--browser`: in a tab of the browser preview.
    Preview,
    /// `--app`: in the VNC app on the user's computer.
    VncApp,
}

/// Where Komla can show a virtual desktop: its VNC server and, with noVNC, a browser view.
pub(crate) struct DesktopView<'a> {
    pub(crate) vnc_port: u16,
    pub(crate) viewer_url: Option<&'a str>,
    /// Where `--browser` or `--app` asked to open it.
    pub(crate) viewer: Option<Viewer>,
    /// The VNC password, which the VNC app takes from its vnc:// link.
    pub(crate) vnc_password: &'a str,
    /// The VNC ports of every running desktop, so Komla can close its forwards to stopped ones.
    pub(crate) vnc_ports: &'a [u16],
    /// What the desktop is named after: the app it was started for, shortened.
    pub(crate) app: Option<&'a str>,
}

/// How Komla showed the desktop.
#[derive(Debug, PartialEq)]
pub(crate) enum Shown {
    /// Under the globe button only, to open from there.
    Listed,
    /// In the browser preview.
    Preview,
    /// In the VNC app on the user's computer.
    VncApp { name: String },
}

/// Komla's answer when it has nowhere to show the desktop: the user's computer has no VNC app,
/// or `--app` asked for one, and the host no browser view, or `--browser` asked for one. Komla
/// doesn't list such a desktop, so an app started on it would run where no one can see it.
#[derive(Debug)]
pub(crate) struct NowhereToShow(pub(crate) String);

impl std::fmt::Display for NowhereToShow {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for NowhereToShow {}

pub(crate) type ShowDesktop<'a> = dyn FnMut(&DesktopView) -> anyhow::Result<Shown> + 'a;

pub(crate) fn run(args: &[String], show: &mut ShowDesktop) -> anyhow::Result<()> {
    let Some((operation, rest)) = args.split_first() else {
        bail!(DESKTOP_USAGE);
    };
    // Run by `desktop run` itself, with the app's arguments, --help included, after them.
    #[cfg(target_os = "linux")]
    match operation.as_str() {
        linux::START_FOR_APP => return linux::start_for_app(rest),
        linux::WATCH => return linux::watch(rest),
        _ => {}
    }
    // Arguments after `run` belong to the app, so only a --help before it is Komla's.
    let help = |argument: &String| matches!(argument.as_str(), "--help" | "-h");
    if help(operation)
        || (operation == "run" && viewer_flag(rest).1.first().is_some_and(help))
        || (operation != "run" && rest.iter().any(help))
    {
        println!("{DESKTOP_USAGE}");
        return Ok(());
    }
    match operation.as_str() {
        "run" => run_app(rest, show),
        "start" | "status" if rest.is_empty() => manage(operation, None),
        "stop" if rest.len() <= 1 => manage(operation, rest.first().map(String::as_str)),
        _ => bail!(DESKTOP_USAGE),
    }
}

/// The viewer `run`'s arguments start by asking for, and the arguments after it.
fn viewer_flag(args: &[String]) -> (Option<Viewer>, &[String]) {
    match args.split_first() {
        Some((flag, rest)) if flag == "--browser" => (Some(Viewer::Preview), rest),
        Some((flag, rest)) if flag == "--app" => (Some(Viewer::VncApp), rest),
        _ => (None, args),
    }
}

/// The viewer asked for before the app, and the app: what follows, less an optional leading
/// `--`.
fn run_arguments(args: &[String]) -> anyhow::Result<(Option<Viewer>, &[String])> {
    let (viewer, rest) = viewer_flag(args);
    let command = match rest.first().map(String::as_str) {
        Some("--") => &rest[1..],
        Some("--browser" | "--app") if viewer.is_some() => {
            bail!("give only one of --browser and --app\n{RUN_USAGE}")
        }
        _ => rest,
    };
    if command.is_empty() {
        bail!(RUN_USAGE);
    }
    Ok((viewer, command))
}

/// An X display for the app: its number, the file holding its access cookie, and the lock the app
/// and what it starts hold, which keeps the desktop running until they've all exited.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
struct Display {
    number: u16,
    xauthority: std::path::PathBuf,
    apps_lock: std::fs::File,
}

fn run_app(args: &[String], show: &mut ShowDesktop) -> anyhow::Result<()> {
    let (viewer, command) = run_arguments(args)?;
    #[cfg(target_os = "linux")]
    let display = linux::display_for_app(command, viewer, show)?;
    // macOS and Windows always have a desktop.
    #[cfg(not(target_os = "linux"))]
    let display = {
        let _ = (viewer, show);
        None
    };
    launch(command, display)
}

/// Starts the app as a desktop launcher would: on `display` when given, and without the
/// variables that tie a Komla terminal to the Komla that opened it.
fn launch(command: &[String], display: Option<Display>) -> anyhow::Result<()> {
    let mut process = platform_command(command);
    remove_komla_variables(&mut process);
    if let Some(display) = &display {
        process
            .env("DISPLAY", format!(":{}", display.number))
            .env("XAUTHORITY", &display.xauthority)
            .env_remove("WAYLAND_DISPLAY");
        #[cfg(target_os = "linux")]
        linux::inherit(&display.apps_lock)
            .context("could not keep the virtual desktop running for the app")?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = process.exec();
        Err(error).with_context(|| format!("could not run {}", command[0]))
    }
    #[cfg(windows)]
    {
        let status = process
            .status()
            .with_context(|| format!("could not run {}", command[0]))?;
        std::process::exit(status.code().unwrap_or(1));
    }
}

fn remove_komla_variables(process: &mut Command) {
    for (name, _) in env::vars_os() {
        if name.to_string_lossy().starts_with("KOMLA_") {
            process.env_remove(name);
        }
    }
}

#[cfg(unix)]
pub(crate) fn platform_command(command: &[String]) -> Command {
    let mut process = Command::new(&command[0]);
    process.args(&command[1..]);
    process
}

#[cfg(windows)]
pub(crate) fn platform_command(command: &[String]) -> Command {
    let program = windows_program(
        &command[0],
        env::var_os("PATH").as_deref(),
        env::var("PATHEXT").ok().as_deref(),
        |path| path.is_file(),
    );
    let mut process = Command::new(program);
    process.args(&command[1..]);
    process
}

/// The file Windows runs for `program`, trying each PATHEXT extension in the PATH directories as
/// cmd does, so script shims such as npm.cmd are found. Command::new alone tries only .exe; it
/// quotes arguments safely for .cmd and .bat files itself.
#[cfg(any(windows, test))]
fn windows_program(
    program: &str,
    path: Option<&std::ffi::OsStr>,
    extensions: Option<&str>,
    is_file: impl Fn(&Path) -> bool,
) -> PathBuf {
    let given = Path::new(program);
    if given.extension().is_some() {
        return given.into();
    }
    let directories: Vec<PathBuf> = if program.contains(['\\', '/', ':']) {
        vec![PathBuf::new()]
    } else {
        path.map(|path| env::split_paths(path).collect())
            .unwrap_or_default()
    };
    let extensions = extensions.unwrap_or(".COM;.EXE;.BAT;.CMD");
    directories
        .iter()
        .flat_map(|directory| {
            extensions
                .split(';')
                .filter(|extension| !extension.is_empty())
                .map(move |extension| directory.join(format!("{program}{extension}")))
        })
        .find(|candidate| is_file(candidate))
        .unwrap_or_else(|| given.into())
}

#[cfg(target_os = "linux")]
fn manage(operation: &str, target: Option<&str>) -> anyhow::Result<()> {
    linux::manage(operation, target)
}

#[cfg(not(target_os = "linux"))]
fn manage(_operation: &str, _target: Option<&str>) -> anyhow::Result<()> {
    bail!("virtual desktops need Linux; apps run with `komla desktop run` open on this computer's own desktop")
}

#[cfg(target_os = "linux")]
mod linux {
    use std::env;
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Read, Write};
    use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::thread::sleep;
    use std::time::{Duration, Instant, SystemTime};

    use anyhow::{anyhow, bail, Context};

    use super::vnc_auth::vnc_password_file;
    use super::{DesktopView, Display, NowhereToShow, ShowDesktop, Shown, Viewer};

    /// `desktop __start <claim> <command>`, which `desktop run` runs to start the app's desktop.
    pub(super) const START_FOR_APP: &str = "__start";
    /// `desktop __watch <display>`, which stops an app's desktop once the app has exited.
    pub(super) const WATCH: &str = "__watch";

    const GEOMETRY: &str = "1600x1000";
    const LAST_DISPLAY: u16 = 99;
    // Another user's desktop can take a display between the check and Xvnc binding it.
    const DISPLAY_ATTEMPTS: usize = 3;
    const READY_TIMEOUT: Duration = Duration::from_secs(10);
    const STOP_TIMEOUT: Duration = Duration::from_secs(5);
    const POLL_INTERVAL: Duration = Duration::from_millis(100);
    const INSTALL_HINT: &str = "Xvnc not found; on Debian or Ubuntu run: \
sudo apt install -y tigervnc-standalone-server openbox novnc websockify";
    const XVNC: &str = "xvnc";
    const WINDOW_MANAGER: &str = "openbox";
    const VIEWER: &str = "websockify";
    const WATCHER: &str = "watcher";
    /// Held, shared, by an app desktop's app, what the app starts, and the apps that join the
    /// desktop; its watcher waits to hold it alone.
    const APPS_LOCK: &str = "apps.lock";
    /// Who started a desktop: `desktop start`, or an app's workspace, folder, and command. Its
    /// modified time is when the desktop last started.
    const OWNER: &str = "owner";
    const MANUAL_OWNER: &[u8] = b"desktop start";
    /// The command an app desktop runs, which `status` shows.
    const APP: &str = "app";
    const DESKTOP_NAME_LENGTH: usize = 40;

    /// Where the app `desktop run` starts opens: on a desktop this machine already has, which
    /// returns None, on the virtual desktop the terminal is on, or on a virtual desktop of its own.
    pub(super) fn display_for_app(
        command: &[String],
        viewer: Option<Viewer>,
        show: &mut ShowDesktop,
    ) -> anyhow::Result<Option<Display>> {
        // A desktop started or shown for an app that can't run would leave Komla a dead tab.
        if !runnable(&command[0]) {
            bail!("could not run {}: not found", command[0]);
        }
        // A DISPLAY forwarded over SSH, or kept by tmux after its X server exited, doesn't count.
        let x = env::var("DISPLAY")
            .ok()
            .and_then(|display| local_display_number(&display));
        if let Some(number) = x {
            if let Some(display) = join(number, viewer, show)? {
                return Ok(Some(display));
            }
            if accepts_connections(&x_socket(number)) {
                return Ok(None);
            }
        }
        if has_wayland() {
            return Ok(None);
        }
        start_for_app_desktop(command, viewer, show).map(Some)
    }

    fn has_wayland() -> bool {
        env::var_os("WAYLAND_DISPLAY")
            .filter(|name| !name.is_empty())
            .and_then(|name| {
                let name = PathBuf::from(name);
                if name.is_absolute() {
                    Some(name)
                } else {
                    env::var_os("XDG_RUNTIME_DIR").map(|runtime| PathBuf::from(runtime).join(name))
                }
            })
            .is_some_and(|socket| accepts_connections(&socket))
    }

    /// The display number in a DISPLAY that names this machine's X server, such as `:0`, `:1.0`,
    /// or `unix:2`.
    pub(super) fn local_display_number(display: &str) -> Option<u16> {
        let (host, rest) = display.rsplit_once(':')?;
        if !matches!(host, "" | "unix") {
            return None;
        }
        rest.split('.').next()?.parse().ok()
    }

    fn x_socket(display: u16) -> PathBuf {
        PathBuf::from(format!("/tmp/.X11-unix/X{display}"))
    }

    fn accepts_connections(socket: &Path) -> bool {
        UnixStream::connect(socket).is_ok()
    }

    /// Joins the virtual desktop on `number`, as apps started from its terminals, or from a
    /// terminal given its DISPLAY, do; None when `number` isn't a running virtual desktop.
    fn join(
        number: u16,
        viewer: Option<Viewer>,
        show: &mut ShowDesktop,
    ) -> anyhow::Result<Option<Display>> {
        let Ok(state) = state_path() else {
            return Ok(None);
        };
        if running(&state, number).is_none() {
            return Ok(None);
        }
        let path = desktop_path(&state, number);
        let (apps_lock, desktop) = loop {
            let apps_lock = open_lock(&path.join(APPS_LOCK))?;
            flock(&apps_lock, libc::LOCK_SH).context("could not join the virtual desktop")?;
            // Desktops start and stop under the state lock, so this sees one wholly started or
            // stopped; a desktop that started on the display meanwhile has a lock of its own.
            let _state = lock(&state)?;
            if holds(&apps_lock, &path.join(APPS_LOCK)) {
                break (apps_lock, running(&state, number));
            }
        };
        // Its watcher may have stopped it while this waited for the lock.
        let Some(desktop) = desktop else {
            return Ok(None);
        };
        // A terminal on the desktop itself, which runs without Komla's variables, shows it already.
        // The app still joins a desktop Komla can't show, which runs whether or not it does.
        if env::var_os("KOMLA_WORKSPACE_ID").is_some() {
            if let Err(error) = show_desktop(&state, &desktop, viewer, show) {
                eprintln!("Couldn't show the desktop in Komla: {error:#}");
            }
        }
        Ok(Some(Display {
            number,
            xauthority: xauthority_path(&path),
            apps_lock,
        }))
    }

    /// Starts a desktop for the app `desktop run` starts, shows it in Komla, and returns its
    /// display.
    fn start_for_app_desktop(
        command: &[String],
        viewer: Option<Viewer>,
        show: &mut ShowDesktop,
    ) -> anyhow::Result<Display> {
        let state = state_dir()?;
        // Held from before the desktop exists, so its watcher can't find it unused before the
        // app starts; the desktop takes it over as its apps lock.
        let claim = format!("app-{}.lock", std::process::id());
        let apps_lock = open_lock(&state.join(&claim))?;
        flock(&apps_lock, libc::LOCK_SH)?;
        // A separate process starts the desktop, so it isn't a child of the app this process
        // becomes, which would leave its exited processes unreaped.
        let output = Command::new(env::current_exe()?)
            .args(["desktop", START_FOR_APP, &claim])
            .args(command)
            .stderr(Stdio::inherit())
            .output()
            .context("could not start a virtual desktop")?;
        let number = output
            .status
            .success()
            .then(|| {
                String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse::<u16>()
                    .ok()
            })
            .flatten();
        let Some(number) = number else {
            let _ = fs::remove_file(state.join(&claim));
            return Err(crate::cli::ReportedCliError.into());
        };
        let desktop =
            running(&state, number).context("the virtual desktop stopped as it started")?;
        // Returning drops the apps lock, so the desktop's watcher stops it.
        show_desktop(&state, &desktop, viewer, show)
            .context("could not show the virtual desktop in Komla, so the app didn't start")?;
        Ok(Display {
            number,
            xauthority: xauthority_path(&desktop_path(&state, number)),
            apps_lock,
        })
    }

    /// Shows the desktop in Komla, saying where; fails only with Komla's `NowhereToShow`.
    pub(super) fn show_desktop(
        state: &Path,
        desktop: &Desktop,
        viewer: Option<Viewer>,
        show: &mut ShowDesktop,
    ) -> anyhow::Result<()> {
        let viewer_url = desktop.viewer_url();
        let app = desktop.app.as_deref().map(desktop_name);
        let vnc_ports: Vec<u16> = running_desktops(state)
            .iter()
            .map(|desktop| vnc_port(desktop.number))
            .collect();
        let view = DesktopView {
            vnc_port: vnc_port(desktop.number),
            viewer_url: viewer_url.as_deref(),
            viewer,
            vnc_password: &desktop.password,
            vnc_ports: &vnc_ports,
            app: app.as_deref(),
        };
        match show(&view) {
            Ok(Shown::Listed) => println!(
                "Virtual desktop :{} is ready: open it from the globe button at the top of Komla, \
or add --app or --browser to open it right away.",
                desktop.number
            ),
            Ok(Shown::VncApp { name }) => println!(
                "Showing the desktop in {name}. If it asks for a password, enter {}.",
                desktop.password
            ),
            Ok(Shown::Preview) if viewer == Some(Viewer::VncApp) => println!(
                "This computer has no app that opens vnc:// links, so the desktop shows in \
Komla's browser preview."
            ),
            Ok(Shown::Preview) => {}
            Err(error) if error.is::<NowhereToShow>() => return Err(error),
            Err(error) => eprintln!("Couldn't show the desktop in Komla: {error:#}"),
        }
        Ok(())
    }

    /// `desktop __start <claim> <command>`: starts a desktop for the app, makes the claim
    /// `desktop run` holds the desktop's apps lock, starts the watcher that stops the desktop once
    /// the lock is free, and prints the display.
    pub(super) fn start_for_app(args: &[String]) -> anyhow::Result<()> {
        let Some((claim, command)) = args
            .split_first()
            .filter(|(claim, command)| !claim.contains('/') && !command.is_empty())
        else {
            bail!("usage: komla desktop {START_FOR_APP} <claim> <command> [arguments]");
        };
        // Ctrl+C or a closed terminal stops `desktop run`, and its claim goes with it; a desktop
        // started halfway would have no watcher, while a finished one's watcher stops it.
        block_terminal_signals();
        let state = state_dir()?;
        let number = start_watched(&state, claim, command).inspect_err(|_| {
            // `desktop run` can't remove it after Ctrl+C.
            let _ = fs::remove_file(state.join(claim));
        })?;
        // `desktop run` is gone after Ctrl+C.
        let _ = writeln!(io::stdout(), "{number}");
        Ok(())
    }

    /// Starts the app's desktop, gives it the claim as its apps lock, starts its watcher, and
    /// returns its display.
    fn start_watched(state: &Path, claim: &str, command: &[String]) -> anyhow::Result<u16> {
        let mut owner = env::var("KOMLA_WORKSPACE_ID")
            .unwrap_or_default()
            .into_bytes();
        owner.push(0);
        owner.extend_from_slice(env::current_dir()?.as_os_str().as_bytes());
        for part in command {
            owner.push(0);
            owner.extend_from_slice(part.as_bytes());
        }
        // Found first, as failing after the desktop starts would leave it running.
        let executable = env::current_exe()?;
        let (_lock, previous) = lock_for_app(state, &owner)?;
        let number = start_display(state, previous, &owner, Some(&command.join(" ")))?;
        let path = desktop_path(state, number);
        let mut watcher = Command::new(executable);
        watcher.args(["desktop", WATCH, &number.to_string()]);
        let watched = fs::rename(state.join(claim), path.join(APPS_LOCK))
            .context("could not give the desktop to the app")
            .and_then(|()| spawn(&path, WATCHER, watcher));
        if let Err(error) = watched {
            stop_desktop(&path);
            return Err(error);
        }
        Ok(number)
    }

    /// Blocks the signals a terminal sends when the user presses Ctrl+C or closes it, for this
    /// process only: `spawn` unblocks them for the desktop's processes.
    fn block_terminal_signals() {
        unsafe {
            let mut signals: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut signals);
            for signal in [libc::SIGINT, libc::SIGQUIT, libc::SIGHUP, libc::SIGTERM] {
                libc::sigaddset(&mut signals, signal);
            }
            libc::pthread_sigmask(libc::SIG_BLOCK, &signals, std::ptr::null_mut());
        }
    }

    /// Locks the desktops' state for a new desktop of `owner`'s, and returns the display it had
    /// before, once that's free, so a restarted app keeps its ports and its tab reconnects.
    fn lock_for_app(state: &Path, owner: &[u8]) -> anyhow::Result<(File, Option<u16>)> {
        loop {
            let lock = lock(state)?;
            let previous = owned_display(state, owner);
            if let Some(number) = previous.filter(|&number| running(state, number).is_some()) {
                let path = desktop_path(state, number);
                match activity(&path.join(APPS_LOCK))? {
                    // Another copy of the app, which keeps its desktop.
                    Activity::Running => {}
                    // A restarted app's desktop, which its watcher hasn't stopped yet.
                    Activity::Exited => {
                        stop_desktop(&path);
                    }
                    Activity::Stopping => {
                        drop(lock);
                        if let Ok(apps) = File::open(path.join(APPS_LOCK)) {
                            flock(&apps, libc::LOCK_SH)?;
                        }
                        continue;
                    }
                }
            }
            return Ok((lock, previous));
        }
    }

    /// What holds a desktop's apps lock.
    #[derive(Debug, PartialEq)]
    pub(super) enum Activity {
        /// Its app, or apps that joined it.
        Running,
        /// Nothing, as its apps have exited.
        Exited,
        /// Its watcher, which is stopping it.
        Stopping,
    }

    pub(super) fn activity(apps_lock: &Path) -> io::Result<Activity> {
        let file = open_lock(apps_lock)?;
        if try_flock(&file, libc::LOCK_EX)? {
            return Ok(Activity::Exited);
        }
        Ok(if try_flock(&file, libc::LOCK_SH)? {
            Activity::Running
        } else {
            Activity::Stopping
        })
    }

    /// `desktop __watch <display>`: stops an app's desktop once the app, what it started, and the
    /// apps that joined the desktop have all exited.
    pub(super) fn watch(args: &[String]) -> anyhow::Result<()> {
        let [number] = args else {
            bail!("usage: komla desktop {WATCH} <display>");
        };
        let number = parse_display(number).context("not a display number")?;
        let state = state_path()?;
        let path = desktop_path(&state, number);
        let apps = OpenOptions::new()
            .read(true)
            .write(true)
            .open(path.join(APPS_LOCK))?;
        flock(&apps, libc::LOCK_EX)?;
        let _lock = lock(&state)?;
        // A desktop stopped meanwhile may have been replaced by another on the same display.
        if holds(&apps, &path.join(APPS_LOCK)) {
            for name in [VIEWER, WINDOW_MANAGER, XVNC] {
                stop(&path, name);
            }
        }
        Ok(())
    }

    /// Whether `held` is still the file at `path`, rather than one renamed over it.
    pub(super) fn holds(held: &File, path: &Path) -> bool {
        fs::metadata(path)
            .ok()
            .zip(held.metadata().ok())
            .is_some_and(|(now, held)| (now.dev(), now.ino()) == (held.dev(), held.ino()))
    }

    /// Lets the app this process becomes, and what it starts, inherit `file`.
    pub(super) fn inherit(file: &File) -> io::Result<()> {
        let descriptor = file.as_raw_fd();
        let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFD) };
        if flags == -1
            || unsafe { libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } == -1
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(super) fn manage(operation: &str, target: Option<&str>) -> anyhow::Result<()> {
        let state = state_dir()?;
        match operation {
            "start" => {
                let _lock = lock(&state)?;
                let previous = owned_display(&state, MANUAL_OWNER);
                let number = match previous.filter(|&number| running(&state, number).is_some()) {
                    Some(number) => {
                        // Also restarts parts that exited, or were installed, since it started.
                        start_parts(&desktop_path(&state, number), number);
                        number
                    }
                    None => start_display(&state, previous, MANUAL_OWNER, None)?,
                };
                let desktop =
                    running(&state, number).context("the virtual desktop stopped as it started")?;
                print_status(&state, &desktop);
            }
            "status" => {
                let desktops = running_desktops(&state);
                if desktops.is_empty() {
                    println!("No virtual desktop is running.");
                }
                for (index, desktop) in desktops.iter().enumerate() {
                    if index > 0 {
                        println!();
                    }
                    print_status(&state, desktop);
                }
            }
            _ => {
                let only = target
                    .map(|target| {
                        parse_display(target).with_context(|| {
                            format!("{target} isn't a virtual desktop; name one as :1")
                        })
                    })
                    .transpose()?;
                let _lock = lock(&state)?;
                let stopped: Vec<String> = (1..=LAST_DISPLAY)
                    .filter(|&number| only.is_none_or(|only| only == number))
                    .filter(|&number| stop_desktop(&desktop_path(&state, number)))
                    .map(|number| format!(":{number}"))
                    .collect();
                match (stopped.as_slice(), only) {
                    ([], Some(number)) => println!("Virtual desktop :{number} isn't running."),
                    ([], None) => println!("No virtual desktop is running."),
                    ([one], _) => println!("Stopped virtual desktop {one}."),
                    (many, _) => println!("Stopped virtual desktops {}.", many.join(", ")),
                }
            }
        }
        Ok(())
    }

    /// A display number as `stop` and the watcher take it, such as `:3` or `3`.
    pub(super) fn parse_display(value: &str) -> Option<u16> {
        value
            .strip_prefix(':')
            .unwrap_or(value)
            .parse()
            .ok()
            .filter(|number| (1..=LAST_DISPLAY).contains(number))
    }

    pub(super) struct Desktop {
        pub(super) number: u16,
        pub(super) password: String,
        pub(super) viewer: bool,
        /// The command it was started for; None for `desktop start`'s.
        pub(super) app: Option<String>,
    }

    impl Desktop {
        fn viewer_url(&self) -> Option<String> {
            self.viewer.then(|| viewer_url(self.number, &self.password))
        }
    }

    pub(super) fn viewer_url(display: u16, password: &str) -> String {
        format!(
            "http://127.0.0.1:{}/vnc.html?autoconnect=1&resize=remote&reconnect=1&password={password}",
            viewer_port(display)
        )
    }

    fn vnc_port(display: u16) -> u16 {
        5900 + display
    }

    fn viewer_port(display: u16) -> u16 {
        6080 + display
    }

    fn print_status(state: &Path, desktop: &Desktop) {
        let path = desktop_path(state, desktop.number);
        match &desktop.app {
            Some(app) => println!(
                "Virtual desktop :{} is running {app}; it stops when the app exits.",
                desktop.number
            ),
            None => println!(
                "Virtual desktop :{} is running until stopped.",
                desktop.number
            ),
        }
        match desktop.viewer_url() {
            Some(url) => println!("Browser view: {url}"),
            None if novnc().is_none() => println!(
                "Browser view: install novnc and websockify to show it in Komla's browser preview."
            ),
            None => println!(
                "Browser view: websockify isn't running; see {}",
                path.join(format!("{VIEWER}.log")).display()
            ),
        }
        println!(
            "VNC: 127.0.0.1:{}, password {}",
            vnc_port(desktop.number),
            desktop.password
        );
        println!(
            "Apps you start yourself: export DISPLAY=:{} XAUTHORITY={}",
            desktop.number,
            crate::offline_workspace::shell_quote(&xauthority_path(&path).to_string_lossy())
        );
    }

    /// The desktops' state, per machine, because machines that share a home folder, as clusters
    /// often do, each run their own desktops. Each desktop has a folder named after its display.
    fn state_path() -> anyhow::Result<PathBuf> {
        let base = env::var_os("XDG_STATE_HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
            .context("HOME is not set")?;
        let host = fs::read_to_string("/proc/sys/kernel/hostname")
            .context("could not read this machine's name")?;
        Ok(base.join("komla/desktop").join(host.trim()))
    }

    fn state_dir() -> anyhow::Result<PathBuf> {
        let state = state_path()?;
        create_private_dir(&state)?;
        Ok(state)
    }

    fn create_private_dir(path: &Path) -> anyhow::Result<()> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .with_context(|| format!("could not create {}", path.display()))
    }

    fn desktop_path(state: &Path, display: u16) -> PathBuf {
        state.join(display.to_string())
    }

    /// Two terminals starting desktops at once pick different displays, and a desktop doesn't
    /// stop while another starts on its display.
    fn lock(state: &Path) -> anyhow::Result<File> {
        let file = open_lock(&state.join("lock"))?;
        flock(&file, libc::LOCK_EX).context("could not lock the desktop state")?;
        Ok(file)
    }

    /// Opens a lock file for reading and writing, which NFS needs: it turns `flock` into a lock
    /// on the whole file, which takes reading for a shared lock and writing for an exclusive one.
    fn open_lock(path: &Path) -> io::Result<File> {
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .open(path)
    }

    fn flock(file: &File, operation: libc::c_int) -> io::Result<()> {
        loop {
            if unsafe { libc::flock(file.as_raw_fd(), operation) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }

    /// Whether `file` took the lock without waiting.
    fn try_flock(file: &File, operation: libc::c_int) -> io::Result<bool> {
        match flock(file, operation | libc::LOCK_NB) {
            Ok(()) => Ok(true),
            Err(error) if error.raw_os_error() == Some(libc::EWOULDBLOCK) => Ok(false),
            Err(error) => Err(error),
        }
    }

    fn running(state: &Path, number: u16) -> Option<Desktop> {
        let path = desktop_path(state, number);
        alive(&path, XVNC)?;
        if !xauthority_path(&path).is_file() {
            return None;
        }
        Some(Desktop {
            number,
            password: fs::read_to_string(state.join("vnc-password")).ok()?,
            viewer: alive(&path, VIEWER).is_some(),
            app: fs::read_to_string(path.join(APP)).ok(),
        })
    }

    fn running_desktops(state: &Path) -> Vec<Desktop> {
        (1..=LAST_DISPLAY)
            .filter_map(|number| running(state, number))
            .collect()
    }

    /// The display `owner`'s desktop last started on.
    fn owned_display(state: &Path, owner: &[u8]) -> Option<u16> {
        (1..=LAST_DISPLAY)
            .filter(|&number| {
                fs::read(desktop_path(state, number).join(OWNER)).is_ok_and(|read| read == owner)
            })
            .max_by_key(|&number| last_started(state, number))
    }

    fn last_started(state: &Path, number: u16) -> Option<SystemTime> {
        fs::metadata(desktop_path(state, number).join(OWNER))
            .and_then(|metadata| metadata.modified())
            .ok()
    }

    /// Starts a desktop's X server on `previous` when free, else on another display, then its
    /// window manager and browser view, and returns its display.
    fn start_display(
        state: &Path,
        previous: Option<u16>,
        owner: &[u8],
        app: Option<&str>,
    ) -> anyhow::Result<u16> {
        let xvnc = find_executable("Xvnc").context(INSTALL_HINT)?;
        let password_file = ensure_password(state)?;
        // What outlived a crashed X server still serves its display and holds its ports.
        for number in 1..=LAST_DISPLAY {
            let path = desktop_path(state, number);
            if path.is_dir() && alive(&path, XVNC).is_none() {
                stop_desktop(&path);
            }
        }
        if let Some(previous) = previous {
            clear_stale_lock(previous);
        }
        let name = app.map_or_else(|| "Komla desktop".to_owned(), desktop_name);
        let mut failed = Vec::new();
        loop {
            let number = choose_display(
                previous,
                |display| !failed.contains(&display) && display_is_free(display),
                |display| last_started(state, display),
            )
            .context("no free X display between :1 and :99")?;
            let path = desktop_path(state, number);
            match start_xvnc(&path, &xvnc, &password_file, number, &name) {
                Ok(()) => {
                    let recorded = fs::write(path.join(OWNER), owner).and_then(|()| match app {
                        Some(app) => fs::write(path.join(APP), app),
                        None => {
                            let _ = fs::remove_file(path.join(APP));
                            Ok(())
                        }
                    });
                    if let Err(error) = recorded {
                        // Its watcher wouldn't start, so nothing would stop it.
                        stop_desktop(&path);
                        return Err(error).context("could not record the virtual desktop");
                    }
                    start_parts(&path, number);
                    return Ok(number);
                }
                Err(error) if failed.len() + 1 >= DISPLAY_ATTEMPTS => return Err(error),
                Err(_) => failed.push(number),
            }
        }
    }

    /// What Xvnc calls the desktop, which noVNC shows as the tab's title and VNC apps as the
    /// window's.
    pub(super) fn desktop_name(app: &str) -> String {
        match app.char_indices().nth(DESKTOP_NAME_LENGTH) {
            Some((end, _)) => format!("{}…", &app[..end]),
            None => app.to_owned(),
        }
    }

    fn start_xvnc(
        path: &Path,
        xvnc: &Path,
        password_file: &Path,
        display: u16,
        name: &str,
    ) -> anyhow::Result<()> {
        create_private_dir(path)?;
        // Without a cookie any user on the host could open the display, skipping the password.
        let xauthority = xauthority_path(path);
        write_private(
            &xauthority,
            &xauthority_entry(display, &random_bytes::<16>()?),
        )?;
        let mut command = Command::new(xvnc);
        command
            .arg(format!(":{display}"))
            .arg("-auth")
            .arg(&xauthority)
            .args(["-localhost", "-rfbport", &vnc_port(display).to_string()])
            .args(["-SecurityTypes", "VncAuth", "-rfbauth"])
            .arg(password_file)
            .args(["-geometry", GEOMETRY, "-depth", "24", "-nolisten", "tcp"])
            .args(["-AlwaysShared", "-desktop", name]);
        spawn(path, XVNC, command)?;
        let socket = x_socket(display);
        wait_until(|| alive(path, XVNC).is_none() || socket.exists());
        if alive(path, XVNC).is_none() || !socket.exists() {
            stop(path, XVNC);
            return Err(start_failure(path, XVNC));
        }
        Ok(())
    }

    /// Starts the window manager and browser view where they aren't running, as both are optional.
    fn start_parts(path: &Path, display: u16) {
        if alive(path, WINDOW_MANAGER).is_none() {
            match find_executable("openbox") {
                Some(openbox) => {
                    let mut command = Command::new(openbox);
                    command
                        .env("DISPLAY", format!(":{display}"))
                        .env("XAUTHORITY", xauthority_path(path));
                    if let Err(error) = spawn(path, WINDOW_MANAGER, command) {
                        eprintln!("{error:#}");
                    }
                }
                None => eprintln!(
                    "openbox not found, so windows on the desktop have no title bars; install \
openbox to add them."
                ),
            }
        }
        if alive(path, VIEWER).is_none() {
            if let Some((websockify, web_root)) = novnc() {
                start_viewer(path, display, &websockify, &web_root);
            }
        }
    }

    /// Stops a desktop's watcher, browser view, window manager, and X server, and so its apps;
    /// returns whether any was running.
    fn stop_desktop(path: &Path) -> bool {
        let mut stopped = false;
        for name in [WATCHER, VIEWER, WINDOW_MANAGER, XVNC] {
            stopped |= stop(path, name);
        }
        stopped
    }

    fn xauthority_path(path: &Path) -> PathBuf {
        path.join("xauthority")
    }

    /// An Xauthority file entry granting `cookie` on `display` from any host name, the form
    /// Xvnc's `-auth` reads and Xlib looks up through XAUTHORITY.
    pub(super) fn xauthority_entry(display: u16, cookie: &[u8]) -> Vec<u8> {
        const FAMILY_WILD: u16 = 0xffff;
        let mut entry = FAMILY_WILD.to_be_bytes().to_vec();
        for field in [
            &b""[..],
            display.to_string().as_bytes(),
            b"MIT-MAGIC-COOKIE-1",
            cookie,
        ] {
            entry.extend_from_slice(&(field.len() as u16).to_be_bytes());
            entry.extend_from_slice(field);
        }
        entry
    }

    fn random_bytes<const N: usize>() -> anyhow::Result<[u8; N]> {
        let mut bytes = [0_u8; N];
        File::open("/dev/urandom")?.read_exact(&mut bytes)?;
        Ok(bytes)
    }

    /// noVNC is optional: without it the desktop is still reachable over VNC.
    fn start_viewer(path: &Path, display: u16, websockify: &Path, web_root: &Path) {
        let listen = SocketAddr::from((Ipv4Addr::LOCALHOST, viewer_port(display)));
        // A reused display's viewer port wasn't checked, and another server answering on it
        // would look like websockify starting.
        if TcpListener::bind(listen).is_err() {
            eprintln!("{VIEWER} didn't start: {listen} is in use");
            return;
        }
        let mut command = Command::new(websockify);
        command
            .arg("--web")
            .arg(web_root)
            .arg(listen.to_string())
            .arg(format!("127.0.0.1:{}", vnc_port(display)));
        let started = spawn(path, VIEWER, command).is_ok()
            && wait_until(|| {
                alive(path, VIEWER).is_none()
                    || TcpStream::connect_timeout(&listen, POLL_INTERVAL).is_ok()
            })
            && alive(path, VIEWER).is_some();
        if !started {
            eprintln!("{:#}", start_failure(path, VIEWER));
            // A viewer that runs without answering would look ready.
            stop(path, VIEWER);
        }
    }

    fn start_failure(path: &Path, name: &str) -> anyhow::Error {
        let log = fs::read_to_string(path.join(format!("{name}.log"))).unwrap_or_default();
        let lines: Vec<&str> = log.lines().collect();
        anyhow!(
            "{name} didn't start:\n{}",
            lines[lines.len().saturating_sub(5)..].join("\n")
        )
    }

    /// The display used before while it's free, so its ports stay the same, else the free one
    /// least recently started, so a tab an earlier app left open doesn't show the new app.
    pub(super) fn choose_display(
        previous: Option<u16>,
        is_free: impl Fn(u16) -> bool,
        last_started: impl Fn(u16) -> Option<SystemTime>,
    ) -> Option<u16> {
        previous.filter(|&display| is_free(display)).or_else(|| {
            (1..=LAST_DISPLAY)
                .filter(|&display| is_free(display))
                .min_by_key(|&display| (last_started(display), display))
        })
    }

    fn display_is_free(display: u16) -> bool {
        !Path::new(&format!("/tmp/.X{display}-lock")).exists()
            && !Path::new(&format!("/tmp/.X11-unix/X{display}")).exists()
            && [vnc_port(display), viewer_port(display)]
                .into_iter()
                .all(|port| TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok())
    }

    /// A crashed X server leaves its lock behind, and Xvnc refuses the display until it's gone.
    fn clear_stale_lock(display: u16) {
        let lock = format!("/tmp/.X{display}-lock");
        let Some(pid) = fs::read_to_string(&lock)
            .ok()
            .and_then(|contents| contents.trim().parse::<i32>().ok())
        else {
            return;
        };
        if unsafe { libc::kill(pid, 0) } == -1
            && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            let _ = fs::remove_file(&lock);
            let _ = fs::remove_file(format!("/tmp/.X11-unix/X{display}"));
        }
    }

    /// The VNC password, made once per host user. Xvnc reads it from the returned file.
    fn ensure_password(state: &Path) -> anyhow::Result<PathBuf> {
        let password_path = state.join("vnc-password");
        let password = match fs::read(&password_path) {
            Ok(password) if password.len() == 8 => password,
            _ => {
                const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
                // VNC passwords stop at 8 characters.
                let password: Vec<u8> = random_bytes::<8>()?
                    .iter()
                    .map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()])
                    .collect();
                write_private(&password_path, &password)?;
                password
            }
        };
        // Rewritten from the password each time, so an interrupted write can't leave Xvnc
        // expecting another password.
        let password_file = state.join("vnc-passwd");
        write_private(&password_file, &vnc_password_file(&password))?;
        Ok(password_file)
    }

    /// Writes a file only this user can read, replacing it whole, as Xvnc reads its password file
    /// at every login.
    pub(super) fn write_private(path: &Path, contents: &[u8]) -> anyhow::Result<()> {
        let mut new = path.as_os_str().to_owned();
        new.push(".new");
        OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(&new)
            .and_then(|mut file| file.write_all(contents))
            .and_then(|()| fs::rename(&new, path))
            .with_context(|| format!("could not write {}", path.display()))
    }

    /// Starts a desktop process in its own session, so it outlives the terminal that started it
    /// and stops as a group, and records its pid with its start time in `<name>.pid`. It runs
    /// apart from that terminal's workspace and Komla.
    fn spawn(path: &Path, name: &str, mut command: Command) -> anyhow::Result<()> {
        let log = File::create(path.join(format!("{name}.log")))?;
        super::remove_komla_variables(&mut command);
        command
            .current_dir(path)
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        unsafe {
            command.pre_exec(|| {
                let mut signals: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut signals);
                if libc::sigprocmask(libc::SIG_SETMASK, &signals, std::ptr::null_mut()) == -1
                    || libc::setsid() == -1
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let pid = command
            .spawn()
            .with_context(|| format!("could not start {name}"))?
            .id();
        let started = fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|stat| process_start_time(&stat))
            .ok_or_else(|| start_failure(path, name))?;
        fs::write(
            path.join(format!("{name}.pid")),
            format!("{pid} {started}\n"),
        )?;
        Ok(())
    }

    /// The pid recorded for `name` while that process runs. A record whose pid now belongs to
    /// another process, after a crash or reboot, doesn't count.
    fn alive(path: &Path, name: &str) -> Option<u32> {
        let record = fs::read_to_string(path.join(format!("{name}.pid"))).ok()?;
        let (pid, started) = record.trim().split_once(' ')?;
        let pid: u32 = pid.parse().ok()?;
        let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        (process_start_time(&stat)? == started.parse::<u64>().ok()?).then_some(pid)
    }

    /// The start time in a /proc/<pid>/stat line, unless the process has exited.
    pub(super) fn process_start_time(stat: &str) -> Option<u64> {
        // The command name in parentheses may hold spaces, so fields count from the last `)`.
        let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
        if matches!(fields.first(), Some(&("Z" | "X"))) {
            return None;
        }
        fields.get(19)?.parse().ok()
    }

    /// Asks the process group to exit, as Ctrl+C would, waits for its leader, then kills what
    /// remains.
    fn stop(path: &Path, name: &str) -> bool {
        let record = path.join(format!("{name}.pid"));
        let Some(pid) = alive(path, name) else {
            let _ = fs::remove_file(record);
            return false;
        };
        let group = -(pid as i32);
        unsafe { libc::kill(group, libc::SIGTERM) };
        let deadline = Instant::now() + STOP_TIMEOUT;
        // A leader this process started stays a zombie until reaped, which `alive` ignores.
        while alive(path, name).is_some() && Instant::now() < deadline {
            sleep(POLL_INTERVAL);
        }
        unsafe { libc::kill(group, libc::SIGKILL) };
        let _ = fs::remove_file(record);
        true
    }

    fn wait_until(mut ready: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if ready() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            sleep(POLL_INTERVAL);
        }
    }

    fn find_executable(name: &str) -> Option<PathBuf> {
        env::split_paths(&env::var_os("PATH")?)
            .map(|directory| directory.join(name))
            .find(|path| executable(path))
    }

    /// Whether `program` names an executable file, found as exec finds it.
    fn runnable(program: &str) -> bool {
        if program.contains('/') {
            executable(Path::new(program))
        } else {
            find_executable(program).is_some()
        }
    }

    fn executable(path: &Path) -> bool {
        path.metadata()
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
    }

    /// websockify and the noVNC page it serves, from the websockify and novnc packages.
    fn novnc() -> Option<(PathBuf, PathBuf)> {
        let websockify = find_executable("websockify")?;
        let web_root = novnc_web_root(&websockify)?;
        Some((websockify, web_root))
    }

    pub(super) fn novnc_web_root(websockify: &Path) -> Option<PathBuf> {
        let beside = websockify.parent()?.parent()?.join("share/novnc");
        [
            beside,
            "/usr/share/novnc".into(),
            "/usr/share/webapps/novnc".into(),
        ]
        .into_iter()
        .find(|root: &PathBuf| root.join("vnc.html").is_file())
    }
}

/// VNC authentication, which still uses DES.
#[cfg(target_os = "linux")]
mod vnc_auth {
    /// What Xvnc's `-rfbauth` file holds: the password, padded to 8 bytes, DES-encrypted with
    /// VNC's fixed key, whose bytes are written here bit-reversed as standard DES expects.
    pub(super) fn vnc_password_file(password: &[u8]) -> [u8; 8] {
        const VNC_KEY: u64 = 0xe84a_d660_c472_1ae0;
        let length = password.len().min(8);
        let mut block = [0_u8; 8];
        block[..length].copy_from_slice(&password[..length]);
        des_encrypt(VNC_KEY, u64::from_be_bytes(block)).to_be_bytes()
    }

    /// Picks bits of the `width`-bit `input` in `table` order; tables number bits from 1, the
    /// most significant, as the DES standard (FIPS 46-3) does.
    fn permute(input: u64, width: u32, table: &[u8]) -> u64 {
        table.iter().fold(0, |output, &position| {
            (output << 1) | ((input >> (width - u32::from(position))) & 1)
        })
    }

    fn des_encrypt(key: u64, block: u64) -> u64 {
        let key = permute(key, 64, &PC1);
        let (mut c, mut d) = (key >> 28, key & 0x0fff_ffff);
        let mut subkeys = [0_u64; 16];
        for (subkey, shift) in subkeys.iter_mut().zip(SHIFTS) {
            c = ((c << shift) | (c >> (28 - shift))) & 0x0fff_ffff;
            d = ((d << shift) | (d >> (28 - shift))) & 0x0fff_ffff;
            *subkey = permute((c << 28) | d, 56, &PC2);
        }
        let block = permute(block, 64, &IP);
        let (mut left, mut right) = (block >> 32, block & 0xffff_ffff);
        for subkey in subkeys {
            let expanded = permute(right, 32, &E) ^ subkey;
            let substituted = S_BOXES
                .iter()
                .enumerate()
                .fold(0, |output, (index, s_box)| {
                    let six = ((expanded >> (42 - 6 * index)) & 0x3f) as usize;
                    let row = ((six >> 4) & 0b10) | (six & 1);
                    (output << 4) | u64::from(s_box[row * 16 + ((six >> 1) & 0xf)])
                });
            (left, right) = (right, left ^ permute(substituted, 32, &P));
        }
        permute((right << 32) | left, 64, &FP)
    }

    #[rustfmt::skip]
    const IP: [u8; 64] = [
        58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
        62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
        57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
        61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
    ];
    #[rustfmt::skip]
    const FP: [u8; 64] = [
        40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
        38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
        36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
        34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
    ];
    #[rustfmt::skip]
    const E: [u8; 48] = [
        32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17,
        16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
    ];
    #[rustfmt::skip]
    const P: [u8; 32] = [
        16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
        2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
    ];
    #[rustfmt::skip]
    const PC1: [u8; 56] = [
        57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
        10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
        63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
        14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
    ];
    #[rustfmt::skip]
    const PC2: [u8; 48] = [
        14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
        41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
    ];
    const SHIFTS: [u32; 16] = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
    #[rustfmt::skip]
    const S_BOXES: [[u8; 64]; 8] = [
        [
            14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
            0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
            4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
            15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13,
        ],
        [
            15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
            3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
            0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
            13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9,
        ],
        [
            10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
            13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
            13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
            1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12,
        ],
        [
            7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
            13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
            10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
            3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14,
        ],
        [
            2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
            14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
            4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
            11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3,
        ],
        [
            12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
            10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
            9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
            4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13,
        ],
        [
            4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
            13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
            1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
            6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12,
        ],
        [
            13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
            1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
            7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
            2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11,
        ],
    ];

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn des_matches_the_standard_test_vector() {
            assert_eq!(
                des_encrypt(0x1334_5779_9bbc_dff1, 0x0123_4567_89ab_cdef),
                0x85e8_1354_0f0a_b405
            );
        }

        #[test]
        fn vnc_password_file_matches_vncpasswd() {
            // `openssl enc -des-ecb -nopad -nosalt -K e84ad660c4721ae0` of the same password.
            assert_eq!(
                vnc_password_file(b"6265411b"),
                [0x34, 0xdc, 0xd9, 0x98, 0x4f, 0x27, 0xdf, 0x59]
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn run_arguments_drop_only_a_leading_separator() {
        assert_eq!(
            run_arguments(&strings(&["--", "npm", "run", "dev", "--", "--inspect"])).unwrap(),
            (
                None,
                strings(&["npm", "run", "dev", "--", "--inspect"]).as_slice()
            )
        );
        assert_eq!(
            run_arguments(&strings(&["npm", "start"])).unwrap(),
            (None, strings(&["npm", "start"]).as_slice())
        );
        assert!(run_arguments(&[]).is_err());
        assert!(run_arguments(&strings(&["--"])).is_err());
    }

    #[test]
    fn run_arguments_take_a_viewer_only_before_the_app() {
        assert_eq!(
            run_arguments(&strings(&["--browser", "--", "xterm"])).unwrap(),
            (Some(Viewer::Preview), strings(&["xterm"]).as_slice())
        );
        assert_eq!(
            run_arguments(&strings(&["--app", "--", "xterm"])).unwrap(),
            (Some(Viewer::VncApp), strings(&["xterm"]).as_slice())
        );
        assert_eq!(
            run_arguments(&strings(&["--app", "xterm", "--browser"])).unwrap(),
            (
                Some(Viewer::VncApp),
                strings(&["xterm", "--browser"]).as_slice()
            )
        );
        assert_eq!(
            run_arguments(&strings(&["xterm", "--browser"])).unwrap(),
            (None, strings(&["xterm", "--browser"]).as_slice())
        );
        assert_eq!(
            run_arguments(&strings(&["--", "--app"])).unwrap(),
            (None, strings(&["--app"]).as_slice())
        );
        assert!(run_arguments(&strings(&["--browser"])).is_err());
        assert!(run_arguments(&strings(&["--app"])).is_err());
        assert!(run_arguments(&strings(&["--browser", "--app", "--", "xterm"])).is_err());
        assert!(run_arguments(&strings(&["--app", "--browser", "xterm"])).is_err());
    }

    #[test]
    fn start_and_status_take_no_arguments() {
        let mut show = |_: &DesktopView| Ok(Shown::Preview);
        assert!(run(&strings(&["status", "now"]), &mut show).is_err());
        assert!(run(&strings(&["stop", ":1", ":2"]), &mut show).is_err());
        assert!(run(&strings(&["restart"]), &mut show).is_err());
        assert!(run(&[], &mut show).is_err());
    }

    #[test]
    fn windows_program_finds_script_shims_on_the_path() {
        let files = [
            PathBuf::from("/node/npm.cmd"),
            PathBuf::from("/tools/app.exe"),
        ];
        // Windows matches file names without regard to case.
        let lowercase = |path: &Path| PathBuf::from(path.to_string_lossy().to_lowercase());
        let is_file = |path: &Path| files.iter().any(|file| lowercase(file) == lowercase(path));
        let path = std::env::join_paths(["/tools", "/node"]).unwrap();
        let find = |program| windows_program(program, Some(&path), Some(".COM;.EXE;.CMD"), is_file);

        assert_eq!(find("npm"), PathBuf::from("/node/npm.CMD"));
        assert_eq!(find("app"), PathBuf::from("/tools/app.EXE"));
        assert_eq!(find("electron.exe"), PathBuf::from("electron.exe"));
        assert_eq!(find("missing"), PathBuf::from("missing"));
    }

    #[cfg(target_os = "linux")]
    mod linux {
        use std::os::fd::AsRawFd;
        use std::time::{Duration, SystemTime};

        use super::super::linux::*;
        use super::super::{DesktopView, NowhereToShow, Shown, Viewer};

        #[test]
        fn process_start_time_counts_fields_after_the_command_name() {
            let stat = "4242 (Xvnc (Komla) x) S 1 4242 4242 0 -1 4194560 213 0 0 0 1 2 0 0 20 0 \
                1 0 987654 12345 678";
            assert_eq!(process_start_time(stat), Some(987_654));
        }

        #[test]
        fn process_start_time_ignores_exited_processes() {
            let stat = "4242 (Xvnc) Z 1 4242 4242 0 -1 4194560 213 0 0 0 1 2 0 0 20 0 1 0 987654";
            assert_eq!(process_start_time(stat), None);
        }

        #[test]
        fn choose_display_keeps_the_previous_display_while_free() {
            let never = |_| None;
            assert_eq!(choose_display(Some(7), |_| true, never), Some(7));
            assert_eq!(
                choose_display(Some(7), |display| display != 7 && display > 2, never),
                Some(3)
            );
            assert_eq!(
                choose_display(None, |display| display == 99, never),
                Some(99)
            );
            assert_eq!(choose_display(None, |_| false, never), None);
        }

        #[test]
        fn choose_display_prefers_displays_started_least_recently() {
            let at = |seconds| Some(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds));
            let last_started = |display| match display {
                1 => at(30),
                2 => at(10),
                3 => at(20),
                _ => None,
            };
            assert_eq!(choose_display(None, |_| true, last_started), Some(4));
            assert_eq!(
                choose_display(None, |display| display <= 3, last_started),
                Some(2)
            );
        }

        #[test]
        fn local_display_number_ignores_forwarded_displays() {
            assert_eq!(local_display_number(":0"), Some(0));
            assert_eq!(local_display_number(":12.0"), Some(12));
            assert_eq!(local_display_number("unix:3"), Some(3));
            assert_eq!(local_display_number("localhost:10.0"), None);
            assert_eq!(local_display_number("192.168.1.5:0"), None);
            assert_eq!(local_display_number(":"), None);
            assert_eq!(local_display_number(""), None);
        }

        #[test]
        fn parse_display_takes_a_virtual_desktop_number() {
            assert_eq!(parse_display(":3"), Some(3));
            assert_eq!(parse_display("12"), Some(12));
            assert_eq!(parse_display(":0"), None);
            assert_eq!(parse_display(":100"), None);
            assert_eq!(parse_display("all"), None);
        }

        #[test]
        fn desktop_name_shortens_long_commands() {
            assert_eq!(desktop_name("npm run dev"), "npm run dev");
            let long = format!("électron {}", "x".repeat(40));
            assert_eq!(desktop_name(&long), format!("électron {}…", "x".repeat(31)));
        }

        #[test]
        fn activity_tells_apps_from_a_stopping_watcher() {
            let folder = tempfile::tempdir().unwrap();
            let path = folder.path().join("apps.lock");
            let lock = |operation| {
                let file = std::fs::File::create(&path).unwrap();
                assert_eq!(unsafe { libc::flock(file.as_raw_fd(), operation) }, 0);
                file
            };

            assert_eq!(activity(&path).unwrap(), Activity::Exited);
            let app = lock(libc::LOCK_SH);
            let joined = lock(libc::LOCK_SH);
            assert_eq!(activity(&path).unwrap(), Activity::Running);
            drop((app, joined));
            let _watcher = lock(libc::LOCK_EX);
            assert_eq!(activity(&path).unwrap(), Activity::Stopping);
        }

        #[test]
        fn holds_tells_a_lock_file_from_one_renamed_over_it() {
            let folder = tempfile::tempdir().unwrap();
            let path = folder.path().join("apps.lock");
            let held = std::fs::File::create(&path).unwrap();
            assert!(holds(&held, &path));

            let claim = folder.path().join("app-1.lock");
            std::fs::write(&claim, "").unwrap();
            std::fs::rename(&claim, &path).unwrap();
            assert!(!holds(&held, &path));
            std::fs::remove_file(&path).unwrap();
            assert!(!holds(&held, &path));
        }

        #[test]
        fn write_private_replaces_the_file_whole() {
            use std::io::Read;
            use std::os::unix::fs::PermissionsExt;

            let folder = tempfile::tempdir().unwrap();
            let path = folder.path().join("vnc-passwd");
            write_private(&path, b"old").unwrap();
            // Xvnc reads its password file at every login.
            let mut login = std::fs::File::open(&path).unwrap();
            write_private(&path, b"new").unwrap();

            let mut read = String::new();
            login.read_to_string(&mut read).unwrap();
            assert_eq!(read, "old");
            assert_eq!(std::fs::read(&path).unwrap(), b"new");
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
            assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 1);
        }

        #[test]
        fn xauthority_entry_grants_the_cookie_on_the_display_from_any_host() {
            assert_eq!(
                xauthority_entry(12, &[0xab; 4]),
                [
                    &[0xff, 0xff, 0, 0, 0, 2][..],
                    b"12",
                    &[0, 18],
                    b"MIT-MAGIC-COOKIE-1",
                    &[0, 4, 0xab, 0xab, 0xab, 0xab],
                ]
                .concat()
            );
        }

        #[test]
        fn viewer_url_connects_novnc_to_the_desktop() {
            assert_eq!(
                viewer_url(3, "pa55word"),
                "http://127.0.0.1:6083/vnc.html?autoconnect=1&resize=remote&reconnect=1&password=pa55word"
            );
        }

        #[test]
        fn novnc_web_root_is_found_beside_websockify() {
            let prefix = tempfile::tempdir().unwrap();
            let websockify = prefix.path().join("bin/websockify");
            let web_root = prefix.path().join("share/novnc");
            std::fs::create_dir_all(websockify.parent().unwrap()).unwrap();
            std::fs::create_dir_all(&web_root).unwrap();
            std::fs::write(&websockify, "").unwrap();
            std::fs::write(web_root.join("vnc.html"), "").unwrap();

            assert_eq!(novnc_web_root(&websockify), Some(web_root));
        }

        #[test]
        fn show_desktop_fails_only_when_komla_has_nowhere_to_show_it() {
            let state = tempfile::tempdir().unwrap();
            let desktop = Desktop {
                number: 3,
                password: "pa55word".to_owned(),
                viewer: false,
                app: Some("xterm".to_owned()),
            };
            let mut nowhere = |_: &DesktopView| -> anyhow::Result<Shown> {
                Err(NowhereToShow("Install novnc and websockify".to_owned()).into())
            };
            let mut unreachable =
                |_: &DesktopView| -> anyhow::Result<Shown> { anyhow::bail!("connection refused") };

            let error = show_desktop(state.path(), &desktop, Some(Viewer::Preview), &mut nowhere)
                .unwrap_err();
            assert!(error.is::<NowhereToShow>(), "{error:#}");
            // Komla may just not be running, as outside it, where the desktop is still of use.
            show_desktop(state.path(), &desktop, None, &mut unreachable).unwrap();
        }
    }
}
