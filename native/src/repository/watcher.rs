use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Context};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::{Match, WalkBuilder};
use notify::{
    event::{CreateKind, ModifyKind, RemoveKind},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};

use super::snapshot::command_output_with_deadline;
use crate::protocol::MAX_CHANGED_PATH_BYTES;

#[cfg(not(test))]
const INITIAL_GIT_TIMEOUT: Duration = Duration::from_secs(5);
// Long enough for git on a machine still busy with other suites, short of the blocked-git tests' 5s.
#[cfg(test)]
const INITIAL_GIT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_GIT_PATH_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_GIT_ADMIN_PATH_BYTES: usize = 64 * 1024;
/// Where Komla puts imported files, as `KOMLA_FILES_DIR` in `git-status.ts`. Local copies leave it
/// out, so a change in it updates anything showing the file but needs no sync.
const KOMLA_FILES_DIR: &str = ".komla-files";
/// Whether reports name the paths that changed. macOS file systems match names regardless of case
/// and Unicode normalization, so an event can spell a file differently than Git lists it.
pub const NAMES_CHANGED_PATHS: bool = !cfg!(target_os = "macos");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryWatchPaths {
    pub working_tree: PathBuf,
    pub git_dir: PathBuf,
    pub common_git_dir: PathBuf,
}

impl RepositoryWatchPaths {
    pub fn discover(working_tree: &Path) -> anyhow::Result<Self> {
        let working_tree = working_tree
            .canonicalize()
            .with_context(|| format!("could not resolve {}", working_tree.display()))?;
        let git_dir = resolve_git_path(&working_tree, "--git-dir")?;
        let common_git_dir = resolve_git_path(&working_tree, "--git-common-dir")?;
        Ok(Self {
            working_tree,
            git_dir,
            common_git_dir,
        })
    }
}

fn resolve_git_path(working_tree: &Path, argument: &str) -> anyhow::Result<PathBuf> {
    let mut command = Command::new("git");
    command
        .arg("--no-optional-locks")
        .args(["rev-parse", argument])
        .current_dir(working_tree);
    let output =
        command_output_with_deadline(&mut command, INITIAL_GIT_TIMEOUT, MAX_GIT_ADMIN_PATH_BYTES)
            .with_context(|| format!("could not run git rev-parse {argument}"))?;
    if !output.status.success() {
        bail!(
            "git rev-parse {argument} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    if output.stdout_exceeded {
        bail!("git rev-parse {argument} output exceeded the limit");
    }
    let value = String::from_utf8(output.stdout)
        .context("git returned a non-UTF-8 administrative path")?
        .trim()
        .to_owned();
    let path = PathBuf::from(value);
    let path = if path.is_absolute() {
        path
    } else {
        working_tree.join(path)
    };
    path.canonicalize()
        .with_context(|| format!("could not resolve Git path {}", path.display()))
}

pub struct RepositoryEventFilter {
    working_tree: PathBuf,
    ignore_rules: IgnoreRules,
    tracked: HashSet<PathBuf>,
    tracked_directories: HashSet<PathBuf>,
    // The files symlinks in the working tree resolve to, each with the names of its links.
    links: HashMap<PathBuf, Vec<String>>,
    link_paths: HashSet<PathBuf>,
    // Whether a link resolves to a file whose changes go unseen, or to nothing.
    unmapped_links: bool,
}

/// Git's ignore rules. Each `.gitignore` matches paths relative to its own directory and
/// overrides those above it; `info/exclude` comes last.
struct IgnoreRules {
    by_directory: HashMap<PathBuf, Gitignore>,
    info_exclude: Gitignore,
}

impl IgnoreRules {
    /// Whether Git ignores `path`, inside `working_tree`. As in Git, nothing inside an ignored
    /// directory can be re-included.
    fn is_ignored(&self, working_tree: &Path, path: &Path, is_dir: bool) -> bool {
        path.ancestors()
            .skip(1)
            .take_while(|directory| *directory != working_tree)
            .any(|directory| self.matched(working_tree, directory, true).is_ignore())
            || self.matched(working_tree, path, is_dir).is_ignore()
    }

    fn matched(&self, working_tree: &Path, path: &Path, is_dir: bool) -> Match<()> {
        for directory in path.ancestors().skip(1) {
            let matched = self
                .by_directory
                .get(directory)
                .map_or(Match::None, |rules| rules.matched(path, is_dir));
            if !matched.is_none() {
                return matched.map(|_| ());
            }
            if directory == working_tree {
                break;
            }
        }
        self.info_exclude.matched(path, is_dir).map(|_| ())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RepositoryEventKind {
    WorkingTree,
    KomlaFiles,
    GitHead,
    GitRefs,
}

pub struct RepositoryEventClassifier;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepositoryWatchSignal {
    Changed {
        kinds: HashSet<RepositoryEventKind>,
        /// The working-tree paths the event changed, relative and `/`-separated, with the links
        /// that read through them. `None` when it may have changed a file it doesn't name, as
        /// a change to Git's own files can.
        paths: Option<Vec<String>>,
        /// Whether the event may have added or removed a file Git lists, rather than only
        /// editing one.
        file_list_may_change: bool,
        /// Whether ignore rules or symlinks changed, so the filter must be loaded again.
        reload_ignore_rules: bool,
        rebuild_watcher: bool,
    },
    IntegrityLost,
}

pub struct RepositoryWatcher {
    _watcher: RecommendedWatcher,
}

#[derive(Debug, Default)]
pub struct SnapshotDebounce {
    first_dirty_at_ms: Option<u64>,
    due_at_ms: Option<u64>,
}

impl SnapshotDebounce {
    pub const QUIET_PERIOD_MS: u64 = 500;
    pub const MAX_DELAY_MS: u64 = 3_000;

    pub fn mark_dirty(&mut self, now_ms: u64) {
        let first = *self.first_dirty_at_ms.get_or_insert(now_ms);
        self.due_at_ms = Some(
            now_ms
                .saturating_add(Self::QUIET_PERIOD_MS)
                .min(first.saturating_add(Self::MAX_DELAY_MS)),
        );
    }

    pub fn mark_integrity_lost(&mut self, now_ms: u64) {
        self.first_dirty_at_ms = Some(now_ms);
        self.due_at_ms = Some(now_ms);
    }

    pub fn next_due_at_ms(&self) -> Option<u64> {
        self.due_at_ms
    }

    pub fn take_if_due(&mut self, now_ms: u64) -> bool {
        if self.due_at_ms.is_none_or(|due| now_ms < due) {
            return false;
        }
        self.first_dirty_at_ms = None;
        self.due_at_ms = None;
        true
    }
}

impl RepositoryWatcher {
    pub fn start(
        paths: &RepositoryWatchPaths,
        filter: &RepositoryEventFilter,
        mut on_event: impl FnMut(notify::Result<Event>) + Send + 'static,
    ) -> anyhow::Result<Self> {
        // inotify reports every file open. Searches and builds open thousands of files,
        // and queuing those reads overflows the event queue, which is handled as an
        // unknown working-tree change that resyncs local copies.
        let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
            let is_read = matches!(
                &event,
                Ok(event) if matches!(event.kind, EventKind::Access(_)) && !event.need_rescan()
            );
            if !is_read {
                on_event(event);
            }
        })
        .context("could not create native filesystem watcher")?;
        let mut watched = HashSet::new();
        for directory in filter.watch_directories()? {
            watch_path(
                &mut watcher,
                &mut watched,
                &directory,
                RecursiveMode::NonRecursive,
            )?;
        }
        watch_git_administration(&mut watcher, &mut watched, &paths.git_dir)?;
        if paths.common_git_dir != paths.git_dir {
            watch_git_administration(&mut watcher, &mut watched, &paths.common_git_dir)?;
        }
        Ok(Self { _watcher: watcher })
    }
}

fn watch_git_administration(
    watcher: &mut RecommendedWatcher,
    watched: &mut HashSet<PathBuf>,
    git_dir: &Path,
) -> anyhow::Result<()> {
    // Git updates files such as HEAD and index by renaming lock files over
    // them. Watching the stable directory keeps those replacements observable
    // after the original inode watch is removed, including for linked
    // worktrees whose administrative directory is outside the working tree.
    watch_path(watcher, watched, git_dir, RecursiveMode::NonRecursive)?;
    for name in [
        "HEAD",
        "index",
        "ORIG_HEAD",
        "FETCH_HEAD",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "BISECT_HEAD",
        "COMMIT_EDITMSG",
        "packed-refs",
        "config",
    ] {
        let path = git_dir.join(name);
        if path.exists() {
            watch_path(watcher, watched, &path, RecursiveMode::NonRecursive)?;
        }
    }
    for name in ["refs/heads", "refs/remotes", "refs/tags"] {
        let path = git_dir.join(name);
        if path.exists() {
            watch_path(watcher, watched, &path, RecursiveMode::Recursive)?;
        }
    }
    let info = git_dir.join("info");
    if info.exists() {
        watch_path(watcher, watched, &info, RecursiveMode::NonRecursive)?;
    }
    Ok(())
}

fn watch_path(
    watcher: &mut RecommendedWatcher,
    watched: &mut HashSet<PathBuf>,
    path: &Path,
    mode: RecursiveMode,
) -> anyhow::Result<()> {
    if watched.insert(path.to_path_buf()) {
        watcher
            .watch(path, mode)
            .with_context(|| format!("could not watch {}", path.display()))?;
    }
    Ok(())
}

impl RepositoryEventClassifier {
    pub fn analyze(
        paths: &RepositoryWatchPaths,
        filter: &RepositoryEventFilter,
        event: notify::Result<Event>,
    ) -> Option<RepositoryWatchSignal> {
        let event = match event {
            Ok(event) if !event.need_rescan() => event,
            Ok(_) | Err(_) => return Some(RepositoryWatchSignal::IntegrityLost),
        };
        // Snapshotting reads working-tree and Git administration files. Some
        // backends report those opens/closes as access events, which must not
        // feed back into another snapshot. Actual writes also produce create,
        // modify, rename, or remove events.
        if matches!(event.kind, EventKind::Access(_)) {
            return None;
        }
        // Windows reports every add as Create(Any), so a new folder is told apart by its path.
        let rebuild_for_directory_change = matches!(
            event.kind,
            EventKind::Create(CreateKind::Folder) | EventKind::Remove(RemoveKind::Folder)
        ) || matches!(
            event.kind,
            EventKind::Create(CreateKind::Any) | EventKind::Modify(ModifyKind::Name(_))
        ) && event.paths.iter().any(|path| path.is_dir());
        // Windows reports every change to a file's contents or attributes as Modify(Any), and
        // adds, removes and renames as their own events.
        let edits_only = matches!(
            event.kind,
            EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_))
        ) || cfg!(windows)
            && matches!(event.kind, EventKind::Modify(ModifyKind::Any));
        let mut kinds = HashSet::new();
        let mut changed_paths = Some(Vec::new());
        let mut file_list_may_change = false;
        let mut reload_ignore_rules = false;
        for path in event.paths {
            let changes_ignore_rules = (path.file_name().is_some_and(|name| name == ".gitignore")
                && path.starts_with(&paths.working_tree))
                || is_git_info_exclude(paths, &path);
            reload_ignore_rules |= changes_ignore_rules;
            if let Some(kind) = Self::classify(paths, filter, &path) {
                let in_working_tree = matches!(
                    kind,
                    RepositoryEventKind::WorkingTree | RepositoryEventKind::KomlaFiles
                );
                reload_ignore_rules |= kind == RepositoryEventKind::GitHead
                    || in_working_tree && filter.is_link(&path);
                file_list_may_change |= match kind {
                    RepositoryEventKind::WorkingTree | RepositoryEventKind::KomlaFiles => {
                        !edits_only || changes_ignore_rules
                    }
                    RepositoryEventKind::GitHead => true,
                    RepositoryEventKind::GitRefs => false,
                };
                let names = (in_working_tree && !changes_other_files(paths, &path))
                    .then(|| filter.changed_names(&path))
                    .flatten();
                match (names, changed_paths.as_mut()) {
                    (Some(names), Some(changed)) => changed.extend(names),
                    (None, _) => changed_paths = None,
                    (Some(_), None) => {}
                }
                kinds.insert(kind);
            }
        }
        (!kinds.is_empty()).then_some(RepositoryWatchSignal::Changed {
            kinds,
            paths: changed_paths,
            file_list_may_change,
            reload_ignore_rules,
            rebuild_watcher: reload_ignore_rules || rebuild_for_directory_change,
        })
    }

    pub fn classify(
        paths: &RepositoryWatchPaths,
        filter: &RepositoryEventFilter,
        path: &Path,
    ) -> Option<RepositoryEventKind> {
        if let Some(kind) = classify_git_path(&paths.git_dir, path) {
            return Some(kind);
        }
        if paths.common_git_dir != paths.git_dir {
            if let Some(kind) = classify_git_path(&paths.common_git_dir, path) {
                return Some(kind);
            }
        }
        filter.is_relevant(path).then(|| {
            if filter.is_komla_file(path) {
                RepositoryEventKind::KomlaFiles
            } else {
                RepositoryEventKind::WorkingTree
            }
        })
    }
}

fn classify_git_path(git_dir: &Path, path: &Path) -> Option<RepositoryEventKind> {
    let relative = path.strip_prefix(git_dir).ok()?;
    if relative == Path::new("info/exclude") {
        return Some(RepositoryEventKind::WorkingTree);
    }
    let file_name = relative.file_name()?.to_str()?;
    if matches!(
        file_name,
        "HEAD"
            | "index"
            | "ORIG_HEAD"
            | "FETCH_HEAD"
            | "MERGE_HEAD"
            | "CHERRY_PICK_HEAD"
            | "REVERT_HEAD"
            | "BISECT_HEAD"
            | "COMMIT_EDITMSG"
            | "config"
    ) {
        return Some(RepositoryEventKind::GitHead);
    }
    if file_name == "packed-refs"
        || relative.starts_with("refs/heads")
        || relative.starts_with("refs/remotes")
        || relative.starts_with("refs/tags")
    {
        return Some(RepositoryEventKind::GitRefs);
    }
    None
}

/// Names `path` as Komla names workspace files: relative to the working tree, `/`-separated.
fn working_tree_path(working_tree: &Path, path: &Path) -> Option<String> {
    let parts = path
        .strip_prefix(working_tree)
        .ok()?
        .components()
        .map(|component| match component {
            Component::Normal(part) => part.to_str(),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    let name = parts.join("/");
    (!name.is_empty() && name.len() <= MAX_CHANGED_PATH_BYTES).then_some(name)
}

fn is_git_info_exclude(paths: &RepositoryWatchPaths, path: &Path) -> bool {
    path == paths.git_dir.join("info/exclude") || path == paths.common_git_dir.join("info/exclude")
}

/// Whether a change to `path` changes how Git lists or diffs other files.
fn changes_other_files(paths: &RepositoryWatchPaths, path: &Path) -> bool {
    is_git_info_exclude(paths, path)
        || path.file_name().is_some_and(|name| {
            name == ".gitattributes" || name == ".gitignore" || name == ".gitmodules"
        })
}

impl RepositoryEventFilter {
    pub fn load(working_tree: &Path) -> anyhow::Result<Self> {
        let working_tree = working_tree
            .canonicalize()
            .with_context(|| format!("could not resolve {}", working_tree.display()))?;
        let mut by_directory = HashMap::new();
        let mut links = Vec::new();
        for entry in WalkBuilder::new(&working_tree)
            .hidden(false)
            .follow_links(false)
            .build()
            .filter_map(Result::ok)
        {
            if entry.path_is_symlink() {
                links.push(entry.path().to_path_buf());
            }
            if entry.file_name() != ".gitignore" {
                continue;
            }
            let directory = entry.path().parent().unwrap_or(&working_tree);
            let mut builder = GitignoreBuilder::new(directory);
            let rules = match builder.add(entry.path()) {
                Some(error) => Err(error.into()),
                None => builder.build().map_err(anyhow::Error::from),
            }
            .with_context(|| {
                format!("could not parse ignore rules in {}", entry.path().display())
            })?;
            by_directory.insert(directory.to_path_buf(), rules);
        }
        let paths = RepositoryWatchPaths::discover(&working_tree)?;
        let info_exclude = paths.common_git_dir.join("info/exclude");
        let mut builder = GitignoreBuilder::new(&working_tree);
        if info_exclude.exists() {
            if let Some(error) = builder.add(&info_exclude) {
                return Err(error).context("could not parse Git info/exclude");
            }
        }
        let ignore_rules = IgnoreRules {
            by_directory,
            info_exclude: builder
                .build()
                .context("could not build Git info/exclude matcher")?,
        };
        let mut command = Command::new("git");
        command
            .arg("--no-optional-locks")
            .args(["ls-files", "-z"])
            .current_dir(&working_tree);
        let output = command_output_with_deadline(
            &mut command,
            INITIAL_GIT_TIMEOUT,
            MAX_GIT_PATH_OUTPUT_BYTES,
        )
        .context("could not list tracked files")?;
        if !output.status.success() {
            bail!(
                "git ls-files failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        if output.stdout_exceeded {
            bail!("git ls-files output exceeded the limit");
        }
        let tracked: HashSet<PathBuf> = output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
            .map(|path| PathBuf::from(String::from_utf8_lossy(path).as_ref()))
            .collect();
        let mut tracked_directories = HashSet::new();
        for path in &tracked {
            let mut parent = path.parent();
            while let Some(directory) = parent {
                if directory.as_os_str().is_empty() {
                    break;
                }
                tracked_directories.insert(directory.to_path_buf());
                parent = directory.parent();
            }
        }
        let mut filter = Self {
            working_tree,
            ignore_rules,
            tracked,
            tracked_directories,
            links: HashMap::new(),
            link_paths: HashSet::new(),
            unmapped_links: false,
        };
        for link in links {
            filter.add_link(link);
        }
        Ok(filter)
    }

    /// Records a symlink, which Komla lists and reads through, so a change to its file names
    /// it too. Komla won't read through a link that leaves the working tree, and doesn't list
    /// what a link to a directory holds.
    fn add_link(&mut self, link: PathBuf) {
        let name = working_tree_path(&self.working_tree, &link);
        match (name, fs::canonicalize(&link).ok()) {
            (_, Some(file)) if !file.starts_with(&self.working_tree) || file.is_dir() => {}
            (Some(name), Some(file)) if self.is_relevant(&file) => {
                self.links.entry(file).or_default().push(name);
            }
            _ => self.unmapped_links = true,
        }
        self.link_paths.insert(link);
    }

    /// Whether `path` is or was a symlink, whose change changes what reads through it.
    fn is_link(&self, path: &Path) -> bool {
        self.link_paths.contains(path)
            || fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
    }

    /// The names of `path` and of the links that read through it. `None` when some may go
    /// unnamed.
    fn changed_names(&self, path: &Path) -> Option<Vec<String>> {
        if !NAMES_CHANGED_PATHS || self.unmapped_links {
            return None;
        }
        let mut names = vec![working_tree_path(&self.working_tree, path)?];
        names.extend(self.links.get(path).into_iter().flatten().cloned());
        Some(names)
    }

    pub fn watch_directories(&self) -> anyhow::Result<Vec<PathBuf>> {
        let mut watched = Vec::new();
        let mut pending = vec![self.working_tree.clone()];
        while let Some(directory) = pending.pop() {
            watched.push(directory.clone());
            let mut children = fs::read_dir(&directory)
                .with_context(|| format!("could not inspect {}", directory.display()))?
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    entry
                        .file_type()
                        .ok()
                        .filter(|file_type| file_type.is_dir())
                        .map(|_| entry.path())
                })
                .filter(|path| self.should_watch_directory(path))
                .collect::<Vec<_>>();
            children.sort();
            pending.extend(children.into_iter().rev());
        }
        Ok(watched)
    }

    fn should_watch_directory(&self, path: &Path) -> bool {
        let Ok(relative) = path.strip_prefix(&self.working_tree) else {
            return false;
        };
        if relative.starts_with(".git") {
            return false;
        }
        if self.tracked_directories.contains(relative) {
            return true;
        }
        !self.ignore_rules.is_ignored(&self.working_tree, path, true)
    }

    fn is_komla_file(&self, path: &Path) -> bool {
        path.strip_prefix(&self.working_tree)
            .is_ok_and(|relative| relative.starts_with(KOMLA_FILES_DIR))
    }

    pub fn is_relevant(&self, path: &Path) -> bool {
        let Ok(relative) = path.strip_prefix(&self.working_tree) else {
            return false;
        };
        if relative
            .file_name()
            .is_some_and(|name| name == ".gitignore")
        {
            return true;
        }
        if relative.starts_with(".git") {
            return false;
        }
        if self.tracked.contains(relative) {
            return true;
        }
        !self
            .ignore_rules
            .is_ignored(&self.working_tree, path, path.is_dir())
    }
}
