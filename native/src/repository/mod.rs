mod snapshot;
mod watcher;

pub use snapshot::{BranchObservation, FileListFingerprint, RepositorySnapshot};
pub use watcher::{
    RepositoryEventClassifier, RepositoryEventFilter, RepositoryEventKind, RepositoryWatchPaths,
    RepositoryWatchSignal, RepositoryWatcher, SnapshotDebounce, NAMES_CHANGED_PATHS,
};

mod target;
pub use target::{run_target_operation, sync_target_branch, TargetAction, TargetResult};
