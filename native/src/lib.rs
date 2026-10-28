mod protocol;
mod repository;

pub use protocol::{
    CompanionSnapshotPayload, NotificationPresentation, PendingTerminalHook,
    COMPANION_PROTOCOL_VERSION, MAX_CHANGED_PATHS,
};
pub use repository::{
    run_target_operation, sync_target_branch, BranchObservation, FileListFingerprint,
    RepositoryEventClassifier, RepositoryEventFilter, RepositoryEventKind, RepositorySnapshot,
    RepositoryWatchPaths, RepositoryWatchSignal, RepositoryWatcher, SnapshotDebounce, TargetAction,
    TargetResult, NAMES_CHANGED_PATHS,
};

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::fs;
    use std::process::Command;
    #[cfg(unix)]
    use std::sync::mpsc;
    #[cfg(unix)]
    use std::time::Duration;

    #[cfg(unix)]
    use base64::Engine;
    use tempfile::tempdir;

    use notify::{
        event::{
            AccessKind, AccessMode, CreateKind, DataChange, Flag, MetadataKind, ModifyKind,
            RemoveKind, RenameMode,
        },
        Event, EventKind,
    };

    use super::{
        CompanionSnapshotPayload, PendingTerminalHook, RepositoryEventClassifier,
        RepositoryEventFilter, RepositoryEventKind, RepositorySnapshot, RepositoryWatchPaths,
        RepositoryWatchSignal, SnapshotDebounce, NAMES_CHANGED_PATHS,
    };

    /// The paths a report names on this platform.
    fn named(paths: &[&str]) -> Option<Vec<String>> {
        NAMES_CHANGED_PATHS.then(|| paths.iter().map(|path| (*path).to_owned()).collect())
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        let result = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git should run");
        assert!(
            result.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    fn discovers_git_paths_and_filters_only_ignored_untracked_files() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let repository = repository.canonicalize().unwrap();
        git(&repository, &["init"]);
        git(&repository, &["config", "user.email", "komla@example.com"]);
        git(&repository, &["config", "user.name", "Komla Test"]);

        fs::write(repository.join("tracked.log"), "tracked\n").unwrap();
        git(&repository, &["add", "tracked.log"]);
        git(&repository, &["commit", "-m", "initial"]);
        fs::write(repository.join(".gitignore"), "*.log\nignored/\n").unwrap();
        fs::create_dir(repository.join("nested")).unwrap();
        fs::write(repository.join("nested/.gitignore"), "generated/\n").unwrap();
        fs::create_dir_all(repository.join("nested/generated")).unwrap();
        fs::write(repository.join("nested/generated/output.txt"), "ignored\n").unwrap();
        fs::create_dir(repository.join("ignored")).unwrap();
        fs::write(repository.join("ignored/cache.txt"), "cache\n").unwrap();
        fs::write(repository.join("untracked.log"), "ignored\n").unwrap();

        let paths = RepositoryWatchPaths::discover(&repository).unwrap();
        let filter = RepositoryEventFilter::load(&repository).unwrap();

        assert_eq!(paths.working_tree, repository.canonicalize().unwrap());
        assert_eq!(
            paths.git_dir,
            repository.join(".git").canonicalize().unwrap()
        );
        assert_eq!(paths.common_git_dir, paths.git_dir);
        assert!(filter.is_relevant(&repository.join("tracked.log")));
        assert!(filter.is_relevant(&repository.join(".gitignore")));
        assert!(!filter.is_relevant(&repository.join("untracked.log")));
        assert!(!filter.is_relevant(&repository.join("ignored/cache.txt")));
        assert!(!filter.is_relevant(&repository.join("nested/generated/output.txt")));
        assert!(filter.is_relevant(&repository.join("nested/.gitignore")));
    }

    #[test]
    fn applies_each_gitignore_to_its_own_directory_as_git_does() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let repository = repository.canonicalize().unwrap();
        git(&repository, &["init"]);
        fs::write(
            repository.join(".gitignore"),
            "*.log\nout/\n!out/keep.txt\n",
        )
        .unwrap();
        fs::create_dir_all(repository.join("docs/build")).unwrap();
        fs::write(repository.join("docs/.gitignore"), "*.html\n/build/\n").unwrap();
        fs::create_dir(repository.join("keep")).unwrap();
        fs::write(repository.join("keep/.gitignore"), "!important.log\n").unwrap();
        fs::create_dir_all(repository.join("build")).unwrap();
        fs::create_dir_all(repository.join("src")).unwrap();
        fs::create_dir_all(repository.join("out")).unwrap();
        let candidates = [
            "src/report.html",
            "docs/page.html",
            "build/output.txt",
            "docs/build/output.txt",
            "keep/important.log",
            "debug.log",
            "out/keep.txt",
        ];
        for candidate in candidates {
            fs::write(repository.join(candidate), "contents\n").unwrap();
        }
        let listed = Command::new("git")
            .args(["ls-files", "--others", "--exclude-standard", "-z"])
            .current_dir(&repository)
            .output()
            .unwrap()
            .stdout;
        let listed = String::from_utf8(listed).unwrap();
        let listed: HashSet<&str> = listed.split('\0').filter(|path| !path.is_empty()).collect();

        let filter = RepositoryEventFilter::load(&repository).unwrap();

        for candidate in candidates {
            assert_eq!(
                filter.is_relevant(&repository.join(candidate)),
                listed.contains(candidate),
                "{candidate}"
            );
        }
        assert!(listed.contains("src/report.html") && listed.contains("build/output.txt"));
        let watched = filter.watch_directories().unwrap();
        assert!(watched.contains(&repository.join("build")));
        assert!(!watched.contains(&repository.join("docs/build")));
    }

    #[test]
    fn watch_directory_selection_prunes_ignored_untracked_subtrees() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let repository = repository.canonicalize().unwrap();
        git(&repository, &["init"]);
        fs::write(repository.join(".gitignore"), "node_modules/\n").unwrap();
        fs::create_dir_all(repository.join("src/nested")).unwrap();
        fs::write(repository.join("src/nested/app.rs"), "fn main() {}\n").unwrap();
        git(&repository, &["add", ".gitignore", "src/nested/app.rs"]);
        fs::create_dir_all(repository.join("node_modules/pkg/deep")).unwrap();

        let filter = RepositoryEventFilter::load(&repository).unwrap();
        let watched = filter.watch_directories().unwrap();

        assert!(watched.contains(&repository.canonicalize().unwrap()));
        assert!(watched.contains(&repository.join("src")));
        assert!(watched.contains(&repository.join("src/nested")));
        assert!(!watched.contains(&repository.join("node_modules")));
        assert!(!watched.contains(&repository.join("node_modules/pkg/deep")));
    }

    #[cfg(unix)]
    #[test]
    fn repository_filter_initialization_times_out_when_git_blocks() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, Instant};

        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init"]);
        let hook = temp.path().join("fsmonitor.sh");
        fs::write(&hook, "#!/bin/sh\nsleep 10\nprintf '2\\n'\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
        git(
            &repository,
            &["config", "core.fsmonitor", hook.to_str().unwrap()],
        );

        let started = Instant::now();
        let result = RepositoryEventFilter::load(&repository);

        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn classifies_working_tree_head_and_shared_ref_changes() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let repository = repository.canonicalize().unwrap();
        git(&repository, &["init"]);
        let paths = RepositoryWatchPaths::discover(&repository).unwrap();
        let filter = RepositoryEventFilter::load(&repository).unwrap();

        assert_eq!(
            RepositoryEventClassifier::classify(&paths, &filter, &repository.join("src/app.ts")),
            Some(RepositoryEventKind::WorkingTree)
        );
        assert_eq!(
            RepositoryEventClassifier::classify(&paths, &filter, &paths.git_dir.join("HEAD")),
            Some(RepositoryEventKind::GitHead)
        );
        assert_eq!(
            RepositoryEventClassifier::classify(&paths, &filter, &paths.git_dir.join("index")),
            Some(RepositoryEventKind::GitHead)
        );
        assert_eq!(
            RepositoryEventClassifier::classify(&paths, &filter, &paths.git_dir.join("config")),
            Some(RepositoryEventKind::GitHead)
        );
        assert_eq!(
            RepositoryEventClassifier::classify(
                &paths,
                &filter,
                &paths.common_git_dir.join("refs/heads/main")
            ),
            Some(RepositoryEventKind::GitRefs)
        );
        assert_eq!(
            RepositoryEventClassifier::classify(
                &paths,
                &filter,
                &paths.git_dir.join("objects/aa/object")
            ),
            None
        );
    }

    #[test]
    fn native_events_ignore_ignored_files_and_request_rescan_after_integrity_loss() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let repository = repository.canonicalize().unwrap();
        git(&repository, &["init"]);
        fs::write(repository.join(".gitignore"), "ignored/\n").unwrap();
        fs::create_dir(repository.join("ignored")).unwrap();
        let paths = RepositoryWatchPaths::discover(&repository).unwrap();
        let filter = RepositoryEventFilter::load(&repository).unwrap();

        let ignored = Event::new(EventKind::Any).add_path(repository.join("ignored/cache.txt"));
        assert_eq!(
            RepositoryEventClassifier::analyze(&paths, &filter, Ok(ignored)),
            None
        );

        let head = Event::new(EventKind::Any).add_path(paths.git_dir.join("HEAD"));
        assert_eq!(
            RepositoryEventClassifier::analyze(&paths, &filter, Ok(head)),
            Some(RepositoryWatchSignal::Changed {
                kinds: HashSet::from([RepositoryEventKind::GitHead]),
                paths: None,
                file_list_may_change: true,
                reload_ignore_rules: true,
                rebuild_watcher: true,
            })
        );

        let created_directory = Event::new(EventKind::Create(CreateKind::Folder))
            .add_path(repository.join("new-directory"));
        assert_eq!(
            RepositoryEventClassifier::analyze(&paths, &filter, Ok(created_directory)),
            Some(RepositoryWatchSignal::Changed {
                kinds: HashSet::from([RepositoryEventKind::WorkingTree]),
                paths: named(&["new-directory"]),
                file_list_may_change: true,
                reload_ignore_rules: false,
                rebuild_watcher: true,
            })
        );

        let mut overflow = Event::new(EventKind::Any);
        overflow.attrs.set_flag(Flag::Rescan);
        assert_eq!(
            RepositoryEventClassifier::analyze(&paths, &filter, Ok(overflow)),
            Some(RepositoryWatchSignal::IntegrityLost)
        );
        assert_eq!(
            RepositoryEventClassifier::analyze(
                &paths,
                &filter,
                Err(notify::Error::generic("watch failed"))
            ),
            Some(RepositoryWatchSignal::IntegrityLost)
        );
    }

    #[test]
    fn names_changed_working_tree_paths_unless_git_state_changed_too() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let repository = repository.canonicalize().unwrap();
        git(&repository, &["init"]);
        fs::write(repository.join(".gitignore"), "ignored/\n").unwrap();
        let paths = RepositoryWatchPaths::discover(&repository).unwrap();
        let filter = RepositoryEventFilter::load(&repository).unwrap();
        let changed_paths =
            |event: Event| match RepositoryEventClassifier::analyze(&paths, &filter, Ok(event)) {
                Some(RepositoryWatchSignal::Changed { paths, .. }) => paths,
                signal => panic!("expected a change, got {signal:?}"),
            };

        // Ignored paths are left out rather than making the change unknown.
        assert_eq!(
            changed_paths(
                Event::new(EventKind::Any)
                    .add_path(repository.join("src/app.ts"))
                    .add_path(repository.join("ignored/cache.txt"))
                    .add_path(repository.join("README.md"))
            ),
            named(&["src/app.ts", "README.md"])
        );
        // So are changes to files that change how Git lists or diffs other files.
        for git_path in [
            paths.git_dir.join("index"),
            paths.git_dir.join("info/exclude"),
            repository.join(".gitattributes"),
            repository.join("docs/.gitattributes"),
            repository.join(".gitmodules"),
            repository.join("src/.gitignore"),
        ] {
            assert_eq!(
                changed_paths(
                    Event::new(EventKind::Any)
                        .add_path(repository.join("src/app.ts"))
                        .add_path(git_path)
                ),
                None
            );
        }
    }

    #[test]
    fn tells_whether_a_change_may_add_or_remove_listed_files() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let repository = repository.canonicalize().unwrap();
        git(&repository, &["init"]);
        fs::write(repository.join(".gitignore"), "ignored/\n").unwrap();
        let paths = RepositoryWatchPaths::discover(&repository).unwrap();
        let filter = RepositoryEventFilter::load(&repository).unwrap();
        let may_change =
            |event: Event| match RepositoryEventClassifier::analyze(&paths, &filter, Ok(event)) {
                Some(RepositoryWatchSignal::Changed {
                    file_list_may_change,
                    ..
                }) => file_list_may_change,
                signal => panic!("expected a change, got {signal:?}"),
            };
        let app = repository.join("src/app.ts");
        let edit = EventKind::Modify(ModifyKind::Data(DataChange::Content));

        assert!(!may_change(Event::new(edit).add_path(app.clone())));
        assert!(!may_change(
            Event::new(EventKind::Modify(ModifyKind::Metadata(
                MetadataKind::Permissions
            )))
            .add_path(app.clone())
        ));
        assert!(!may_change(
            Event::new(EventKind::Any).add_path(paths.git_dir.join("refs/heads/main"))
        ));
        for event in [
            Event::new(EventKind::Create(CreateKind::File)).add_path(app.clone()),
            Event::new(EventKind::Remove(RemoveKind::File)).add_path(app.clone()),
            Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::To))).add_path(app.clone()),
            Event::new(EventKind::Any).add_path(app.clone()),
            Event::new(edit).add_path(repository.join(".gitignore")),
            Event::new(edit).add_path(paths.git_dir.join("index")),
        ] {
            assert!(may_change(event.clone()), "{event:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn names_the_links_that_read_through_a_changed_file() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        let repository = repository.canonicalize().unwrap();
        git(&repository, &["init"]);
        fs::write(repository.join(".gitignore"), "ignored/\n").unwrap();
        fs::write(repository.join("AGENTS.md"), "agents\n").unwrap();
        symlink("AGENTS.md", repository.join("CLAUDE.md")).unwrap();
        fs::create_dir(repository.join("docs")).unwrap();
        fs::write(repository.join("docs/real.md"), "real\n").unwrap();
        symlink("real.md", repository.join("docs/link.md")).unwrap();
        symlink("docs", repository.join("docs-link")).unwrap();
        symlink(temp.path(), repository.join("outside")).unwrap();
        let paths = RepositoryWatchPaths::discover(&repository).unwrap();
        let analyze = |filter: &RepositoryEventFilter, event: Event| {
            match RepositoryEventClassifier::analyze(&paths, filter, Ok(event)) {
                Some(RepositoryWatchSignal::Changed {
                    paths,
                    reload_ignore_rules,
                    ..
                }) => (paths, reload_ignore_rules),
                signal => panic!("expected a change, got {signal:?}"),
            }
        };
        let edit = |path: &str| {
            Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Content)))
                .add_path(repository.join(path))
        };

        let filter = RepositoryEventFilter::load(&repository).unwrap();
        assert_eq!(
            analyze(&filter, edit("AGENTS.md")),
            (named(&["AGENTS.md", "CLAUDE.md"]), false)
        );
        assert_eq!(
            analyze(&filter, edit("docs/real.md")),
            (named(&["docs/real.md", "docs/link.md"]), false)
        );
        // Changing a link changes what reads through it.
        assert_eq!(
            analyze(&filter, edit("CLAUDE.md")),
            (named(&["CLAUDE.md"]), true)
        );

        // A link whose file changes go unseen makes every change unknown.
        for (link, target) in [
            ("gone.md", "missing.md"),
            ("secret.md", "ignored/secret.md"),
        ] {
            fs::create_dir_all(repository.join("ignored")).unwrap();
            fs::write(repository.join("ignored/secret.md"), "secret\n").unwrap();
            symlink(target, repository.join(link)).unwrap();
            let filter = RepositoryEventFilter::load(&repository).unwrap();
            assert_eq!(
                analyze(&filter, edit("docs/real.md")),
                (None, false),
                "{link}"
            );
            fs::remove_file(repository.join(link)).unwrap();
        }
    }

    #[test]
    fn native_events_ignore_read_only_file_access() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init"]);
        let paths = RepositoryWatchPaths::discover(&repository).unwrap();
        let filter = RepositoryEventFilter::load(&repository).unwrap();

        for kind in [
            EventKind::Access(AccessKind::Open(AccessMode::Any)),
            EventKind::Access(AccessKind::Close(AccessMode::Read)),
        ] {
            let event = Event::new(kind).add_path(paths.git_dir.join("index"));
            assert_eq!(
                RepositoryEventClassifier::analyze(&paths, &filter, Ok(event)),
                None
            );
        }
    }

    #[test]
    fn coalesces_bursts_but_never_delays_a_snapshot_beyond_three_seconds() {
        let mut debounce = SnapshotDebounce::default();
        debounce.mark_dirty(1_000);
        assert_eq!(debounce.next_due_at_ms(), Some(1_500));

        debounce.mark_dirty(1_400);
        assert_eq!(debounce.next_due_at_ms(), Some(1_900));
        debounce.mark_dirty(3_900);
        assert_eq!(debounce.next_due_at_ms(), Some(4_000));
        assert!(!debounce.take_if_due(3_999));
        assert!(debounce.take_if_due(4_000));
        assert_eq!(debounce.next_due_at_ms(), None);

        debounce.mark_integrity_lost(5_000);
        assert!(debounce.take_if_due(5_000));
    }

    #[test]
    fn native_watcher_emits_a_working_tree_change() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init"]);
        git(&repository, &["config", "user.email", "komla@example.com"]);
        git(&repository, &["config", "user.name", "Komla Test"]);
        fs::write(repository.join("README.md"), "initial\n").unwrap();
        git(&repository, &["add", "README.md"]);
        git(&repository, &["commit", "-m", "initial"]);

        let paths = RepositoryWatchPaths::discover(&repository).unwrap();
        let filter = RepositoryEventFilter::load(&repository).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let _watcher = super::RepositoryWatcher::start(&paths, &filter, move |event| {
            let _ = sender.send(event);
        })
        .unwrap();

        fs::write(repository.join("README.md"), "changed\n").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut saw_change = false;
        while std::time::Instant::now() < deadline {
            if let Ok(event) = receiver.recv_timeout(std::time::Duration::from_millis(50)) {
                if super::RepositoryEventClassifier::analyze(&paths, &filter, event)
                    == Some(RepositoryWatchSignal::Changed {
                        kinds: HashSet::from([RepositoryEventKind::WorkingTree]),
                        paths: named(&["README.md"]),
                        file_list_may_change: false,
                        reload_ignore_rules: false,
                        rebuild_watcher: false,
                    })
                {
                    saw_change = true;
                    break;
                }
            }
        }
        assert!(saw_change, "native watcher should observe README.md writes");
    }

    #[test]
    fn native_watcher_does_not_forward_file_reads() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init"]);
        git(&repository, &["config", "user.email", "komla@example.com"]);
        git(&repository, &["config", "user.name", "Komla Test"]);
        fs::write(repository.join("README.md"), "initial\n").unwrap();
        git(&repository, &["add", "README.md"]);
        git(&repository, &["commit", "-m", "initial"]);

        let paths = RepositoryWatchPaths::discover(&repository).unwrap();
        let filter = RepositoryEventFilter::load(&repository).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let _watcher = super::RepositoryWatcher::start(&paths, &filter, move |event| {
            let _ = sender.send(event);
        })
        .unwrap();

        // Searches and builds open thousands of files. Queued reads overflow the
        // companion's event queue, which counts as a working-tree change.
        fs::read(repository.join("README.md")).unwrap();
        fs::write(repository.join("README.md"), "changed\n").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut saw_write = false;
        while std::time::Instant::now() < deadline {
            if let Ok(event) = receiver.recv_timeout(std::time::Duration::from_millis(50)) {
                let event = event.unwrap();
                assert!(
                    !matches!(event.kind, EventKind::Access(_)),
                    "native watcher forwarded a read: {event:?}"
                );
                if matches!(event.kind, EventKind::Modify(_)) {
                    saw_write = true;
                    break;
                }
            }
        }
        assert!(saw_write, "native watcher should observe README.md writes");
    }

    #[test]
    fn native_watcher_observes_git_info_exclude_changes() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init"]);
        let paths = RepositoryWatchPaths::discover(&repository).unwrap();
        let filter = RepositoryEventFilter::load(&repository).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let _watcher = super::RepositoryWatcher::start(&paths, &filter, move |event| {
            let _ = sender.send(event);
        })
        .unwrap();

        fs::write(paths.common_git_dir.join("info/exclude"), "generated/\n").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut saw_exclude_change = false;
        while std::time::Instant::now() < deadline {
            if let Ok(event) = receiver.recv_timeout(std::time::Duration::from_millis(50)) {
                if matches!(
                    super::RepositoryEventClassifier::analyze(&paths, &filter, event),
                    Some(RepositoryWatchSignal::Changed {
                        reload_ignore_rules: true,
                        rebuild_watcher: true,
                        ..
                    })
                ) {
                    saw_exclude_change = true;
                    break;
                }
            }
        }
        assert!(
            saw_exclude_change,
            "native watcher should observe .git/info/exclude writes"
        );
    }

    #[test]
    fn native_watcher_keeps_observing_atomically_replaced_linked_worktree_head() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        let linked = temp.path().join("linked");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);
        git(&repository, &["config", "user.email", "komla@example.com"]);
        git(&repository, &["config", "user.name", "Komla Test"]);
        fs::write(repository.join("README.md"), "initial\n").unwrap();
        git(&repository, &["add", "README.md"]);
        git(&repository, &["commit", "-m", "initial"]);
        git(
            &repository,
            &["worktree", "add", "-b", "linked", linked.to_str().unwrap()],
        );

        let paths = RepositoryWatchPaths::discover(&linked).unwrap();
        let filter = RepositoryEventFilter::load(&linked).unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let _watcher = super::RepositoryWatcher::start(&paths, &filter, move |event| {
            let _ = sender.send(event);
        })
        .unwrap();

        for branch in ["main", "linked"] {
            let lock = paths.git_dir.join("HEAD.lock");
            fs::write(&lock, format!("ref: refs/heads/{branch}\n")).unwrap();
            fs::rename(lock, paths.git_dir.join("HEAD")).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            let mut saw_head = false;
            while std::time::Instant::now() < deadline {
                if let Ok(event) = receiver.recv_timeout(std::time::Duration::from_millis(50)) {
                    if matches!(
                        super::RepositoryEventClassifier::analyze(&paths, &filter, event),
                        Some(RepositoryWatchSignal::Changed { ref kinds, .. })
                            if kinds.contains(&RepositoryEventKind::GitHead)
                    ) {
                        saw_head = true;
                        break;
                    }
                }
            }
            assert!(
                saw_head,
                "native watcher should observe replacement {branch}"
            );
        }
    }

    #[test]
    fn reads_git_visible_state_and_branch_relationships() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);
        git(&repository, &["config", "user.email", "komla@example.com"]);
        git(&repository, &["config", "user.name", "Komla Test"]);
        fs::write(repository.join("tracked.txt"), "initial\n").unwrap();
        fs::write(repository.join(".gitignore"), "ignored/\n").unwrap();
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-m", "initial"]);
        git(&repository, &["checkout", "-b", "feature"]);
        fs::write(repository.join("committed.txt"), "committed\n").unwrap();
        git(&repository, &["add", "committed.txt"]);
        git(&repository, &["commit", "-m", "feature commit"]);

        fs::write(repository.join("tracked.txt"), "changed\n").unwrap();
        fs::write(repository.join("new.txt"), "new\n").unwrap();
        fs::create_dir(repository.join("ignored")).unwrap();
        fs::write(repository.join("ignored/cache.txt"), "ignored\n").unwrap();

        let snapshot = super::RepositorySnapshot::read(&repository, "main").unwrap();
        let status = snapshot.status_bytes().unwrap();

        assert!(status
            .windows(b"tracked.txt".len())
            .any(|part| part == b"tracked.txt"));
        assert!(status
            .windows(b"new.txt".len())
            .any(|part| part == b"new.txt"));
        assert!(!status
            .windows(b"cache.txt".len())
            .any(|part| part == b"cache.txt"));
        assert_eq!(snapshot.branch.current_branch, "feature");
        assert_eq!(snapshot.branch.target_branch, "main");
        assert_eq!(snapshot.branch.ahead_target_branch, 1);
        assert_eq!(snapshot.branch.behind_target_branch, 0);
    }

    #[test]
    fn compares_workspaces_to_a_strictly_newer_remote_target() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);
        git(&repository, &["config", "user.email", "komla@example.com"]);
        git(&repository, &["config", "user.name", "Komla Test"]);
        fs::write(repository.join("tracked.txt"), "initial\n").unwrap();
        git(&repository, &["add", "tracked.txt"]);
        git(&repository, &["commit", "-m", "initial"]);
        git(&repository, &["checkout", "-b", "feature"]);
        fs::write(repository.join("feature.txt"), "feature\n").unwrap();
        git(&repository, &["add", "feature.txt"]);
        git(&repository, &["commit", "-m", "feature"]);
        git(&repository, &["checkout", "-b", "remote-main", "main"]);
        fs::write(repository.join("remote.txt"), "remote\n").unwrap();
        git(&repository, &["add", "remote.txt"]);
        git(&repository, &["commit", "-m", "remote main"]);
        git(
            &repository,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        git(&repository, &["checkout", "feature"]);

        let snapshot = RepositorySnapshot::read(&repository, "main").unwrap();

        assert_eq!(snapshot.branch.target_branch_ahead_remote, 0);
        assert_eq!(snapshot.branch.target_branch_behind_remote, 1);
        assert_eq!(snapshot.branch.ahead_target_branch, 1);
        assert_eq!(snapshot.branch.behind_target_branch, 1);
    }

    #[test]
    fn keeps_a_diverged_local_target_as_the_workspace_comparison() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);
        git(&repository, &["config", "user.email", "komla@example.com"]);
        git(&repository, &["config", "user.name", "Komla Test"]);
        fs::write(repository.join("tracked.txt"), "initial\n").unwrap();
        git(&repository, &["add", "tracked.txt"]);
        git(&repository, &["commit", "-m", "initial"]);
        git(&repository, &["checkout", "-b", "remote-main"]);
        fs::write(repository.join("remote.txt"), "remote\n").unwrap();
        git(&repository, &["add", "remote.txt"]);
        git(&repository, &["commit", "-m", "remote main"]);
        git(
            &repository,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        git(&repository, &["checkout", "main"]);
        fs::write(repository.join("local.txt"), "local\n").unwrap();
        git(&repository, &["add", "local.txt"]);
        git(&repository, &["commit", "-m", "local main"]);
        git(&repository, &["checkout", "-b", "feature"]);
        fs::write(repository.join("feature.txt"), "feature\n").unwrap();
        git(&repository, &["add", "feature.txt"]);
        git(&repository, &["commit", "-m", "feature"]);

        let snapshot = RepositorySnapshot::read(&repository, "main").unwrap();

        assert_eq!(snapshot.branch.target_branch_ahead_remote, 1);
        assert_eq!(snapshot.branch.target_branch_behind_remote, 1);
        assert_eq!(snapshot.branch.ahead_target_branch, 1);
        assert_eq!(snapshot.branch.behind_target_branch, 0);
    }

    #[test]
    fn does_not_treat_a_branch_tracking_a_different_origin_branch_as_published() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);
        git(&repository, &["config", "user.email", "komla@example.com"]);
        git(&repository, &["config", "user.name", "Komla Test"]);
        fs::write(repository.join("tracked.txt"), "initial\n").unwrap();
        git(&repository, &["add", "tracked.txt"]);
        git(&repository, &["commit", "-m", "initial"]);
        git(&repository, &["remote", "add", "origin", "/tmp/origin.git"]);
        git(
            &repository,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        git(&repository, &["checkout", "-b", "feature"]);
        git(&repository, &["config", "branch.feature.remote", "origin"]);
        git(
            &repository,
            &["config", "branch.feature.merge", "refs/heads/main"],
        );
        fs::write(repository.join("feature.txt"), "feature\n").unwrap();
        git(&repository, &["add", "feature.txt"]);
        git(&repository, &["commit", "-m", "feature"]);

        let snapshot = RepositorySnapshot::read(&repository, "main").unwrap();

        assert!(!snapshot.branch.has_remote);
        assert_eq!(snapshot.branch.unpushed_commits, 0);
        assert_eq!(snapshot.branch.behind_remote, 0);
    }

    #[test]
    fn reads_the_remote_default_branch_independently_of_the_target_branch() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);
        git(&repository, &["config", "user.email", "komla@example.com"]);
        git(&repository, &["config", "user.name", "Komla Test"]);
        fs::write(repository.join("tracked.txt"), "initial\n").unwrap();
        git(&repository, &["add", "tracked.txt"]);
        git(&repository, &["commit", "-m", "initial"]);
        git(&repository, &["remote", "add", "origin", "/tmp/origin.git"]);
        git(
            &repository,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        git(
            &repository,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );

        let snapshot = RepositorySnapshot::read(&repository, "release").unwrap();

        assert_eq!(snapshot.branch.target_branch, "release");
        assert_eq!(snapshot.branch.default_branch, "main");
    }

    #[test]
    fn retains_status_with_large_untracked_files() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);
        git(&repository, &["config", "user.email", "komla@example.com"]);
        git(&repository, &["config", "user.name", "Komla Test"]);
        fs::write(repository.join("tracked.txt"), "initial\n").unwrap();
        git(&repository, &["add", "tracked.txt"]);
        git(&repository, &["commit", "-m", "initial"]);
        let oversized = fs::File::create(repository.join("artifact.bin")).unwrap();
        oversized.set_len(11 * 1024 * 1024).unwrap();

        fs::write(repository.join("tracked.txt"), "changed\nextra\n").unwrap();
        fs::write(repository.join("small.txt"), "small\n").unwrap();

        let snapshot = RepositorySnapshot::read(&repository, "main").unwrap();

        assert!(!snapshot.status_too_large);
        assert!(String::from_utf8(snapshot.status_bytes().unwrap())
            .unwrap()
            .contains("?? artifact.bin\0"));
        let numstat = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(snapshot.numstat_b64)
                .unwrap(),
        )
        .unwrap();
        assert!(numstat.contains("2\t1\ttracked.txt\0"));
        assert!(numstat.contains("1\t0\tsmall.txt\0"));
        assert!(numstat.contains("144180\t0\tartifact.bin\0"));
        assert_eq!(snapshot.branch.current_branch, "main");
    }

    #[cfg(unix)]
    #[test]
    fn counts_an_untracked_symlink_without_reading_its_target() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);
        git(&repository, &["config", "user.email", "komla@example.com"]);
        git(&repository, &["config", "user.name", "Komla Test"]);
        fs::write(repository.join("tracked.txt"), "initial\n").unwrap();
        git(&repository, &["add", "tracked.txt"]);
        git(&repository, &["commit", "-m", "initial"]);
        let target = temp.path().join("outside.txt");
        fs::write(&target, "one\ntwo\nthree\n").unwrap();
        symlink(&target, repository.join("outside-link")).unwrap();

        let snapshot = RepositorySnapshot::read(&repository, "main").unwrap();
        let numstat = base64::engine::general_purpose::STANDARD
            .decode(snapshot.numstat_b64)
            .unwrap();

        assert_eq!(numstat, b"1\t0\toutside-link\0");
    }

    #[cfg(unix)]
    #[test]
    fn skips_untracked_special_files_without_blocking_the_snapshot() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);
        git(&repository, &["config", "user.email", "komla@example.com"]);
        git(&repository, &["config", "user.name", "Komla Test"]);
        fs::write(repository.join("tracked.txt"), "initial\n").unwrap();
        git(&repository, &["add", "tracked.txt"]);
        git(&repository, &["commit", "-m", "initial"]);
        fs::write(repository.join("events.pipe"), "initially regular\n").unwrap();
        let hook = temp.path().join("fsmonitor.sh");
        let count = temp.path().join("fsmonitor-count");
        fs::write(
            &hook,
            format!(
                "#!/bin/sh\ncount=$(cat '{}' 2>/dev/null || printf 0)\ncount=$((count + 1))\nprintf '%s' \"$count\" > '{}'\nif [ \"$count\" -eq 2 ]; then\n  unlink '{}/events.pipe'\n  mkfifo '{}/events.pipe'\nfi\nprintf '2\\n'\n",
                count.display(),
                count.display(),
                repository.display(),
                repository.display()
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
        // macOS delays the first exec of a new script; keep that out of the snapshot deadline.
        // Until a child another test thread forks execs, it holds the script open for
        // writing, and running it fails with "Text file busy".
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let status = loop {
            match Command::new(&hook).status() {
                Err(error)
                    if error.kind() == std::io::ErrorKind::ExecutableFileBusy
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                result => break result.unwrap(),
            }
        };
        assert!(status.success());
        fs::remove_file(&count).unwrap();
        git(
            &repository,
            &["config", "core.fsmonitor", hook.to_str().unwrap()],
        );

        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            sender
                .send(RepositorySnapshot::read(&repository, "main"))
                .unwrap();
        });
        let snapshot = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("special files must not block a repository snapshot")
            .unwrap();
        let numstat = base64::engine::general_purpose::STANDARD
            .decode(snapshot.numstat_b64)
            .unwrap();

        assert!(!numstat
            .windows(b"events.pipe".len())
            .any(|part| part == b"events.pipe"));
    }

    #[test]
    fn snapshot_payload_identifies_its_latest_value() {
        let snapshot = RepositorySnapshot {
            status_b64: "c3RhdHVz".to_owned(),
            numstat_b64: "bnVtc3RhdA==".to_owned(),
            status_too_large: false,
            file_list_hash: Some("file-list".to_owned()),
            branch: super::BranchObservation {
                current_branch: "feature".to_owned(),
                target_branch: "main".to_owned(),
                default_branch: "main".to_owned(),
                ahead_target_branch: 1,
                behind_target_branch: 0,
                has_remote: false,
                has_origin_remote: false,
                unpushed_commits: 0,
                behind_remote: 0,
                target_branch_has_remote: false,
                target_branch_ahead_remote: 0,
                target_branch_behind_remote: 0,
            },
        };
        let payload = CompanionSnapshotPayload::new(
            "workspace-1".to_owned(),
            "/repo".to_owned(),
            4,
            1_700_000_000_000,
            snapshot,
        )
        .unwrap();
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["protocolVersion"], 1);
        assert_eq!(json["kind"], "repository-snapshot");
        assert_eq!(json["sequence"], 4);
        assert_eq!(json["currentBranch"], "feature");
        assert_eq!(json["defaultBranch"], "main");
        assert_eq!(json["fileListHash"], "file-list");
        assert!(json.get("changedPaths").is_none());
        assert!(!payload.state_hash.is_empty());

        let mut with_paths = payload.clone();
        with_paths.changed_paths = Some(vec!["src/app.ts".to_owned()]);
        assert_eq!(
            serde_json::to_value(&with_paths).unwrap()["changedPaths"],
            serde_json::json!(["src/app.ts"])
        );
    }

    #[test]
    fn fingerprints_the_file_list_only_when_files_come_or_go() {
        let temp = tempdir().unwrap();
        let repository = temp.path().join("repository");
        fs::create_dir(&repository).unwrap();
        git(&repository, &["init", "-b", "main"]);
        git(&repository, &["config", "user.email", "komla@example.com"]);
        git(&repository, &["config", "user.name", "Komla Test"]);
        fs::write(repository.join(".gitignore"), "ignored/\n").unwrap();
        fs::write(repository.join("tracked.txt"), "initial\n").unwrap();
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-m", "initial"]);
        let fingerprint = || {
            RepositorySnapshot::read(&repository, "main")
                .unwrap()
                .file_list_hash
                .expect("file list fingerprint")
        };
        let initial = fingerprint();

        fs::write(repository.join("tracked.txt"), "edited\n").unwrap();
        fs::create_dir(repository.join("ignored")).unwrap();
        fs::write(repository.join("ignored/cache.txt"), "cache\n").unwrap();
        assert_eq!(fingerprint(), initial);

        fs::write(repository.join("new.txt"), "new\n").unwrap();
        let with_new_file = fingerprint();
        assert_ne!(with_new_file, initial);
        fs::remove_file(repository.join("tracked.txt")).unwrap();
        assert_ne!(fingerprint(), with_new_file);
    }

    #[test]
    fn maps_agent_hook_events_without_owning_attention_state() {
        let hook = PendingTerminalHook::from_hook(
            "terminal-1".to_owned(),
            "/repo".to_owned(),
            "claude".to_owned(),
            "PermissionRequest".to_owned(),
            br#"{"tool":"Bash"}"#,
        );

        assert_eq!(hook.kind, "input-required");
        assert_eq!(hook.message, "PermissionRequest");
        assert_eq!(hook.hook_input["tool"], "Bash");
    }
}
