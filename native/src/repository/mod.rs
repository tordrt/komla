mod snapshot;
mod watcher;

pub use snapshot::{BranchObservation, FileListFingerprint, RepositorySnapshot};
pub use watcher::{
    native_watchers_started_on_this_thread, RepositoryEventClassifier, RepositoryEventFilter,
    RepositoryEventKind, RepositoryWatchPaths, RepositoryWatchSignal, RepositoryWatchers,
    SnapshotDebounce, NAMES_CHANGED_PATHS,
};

mod target;
pub use target::{run_target_operation, sync_target_branch, TargetAction, TargetResult};
