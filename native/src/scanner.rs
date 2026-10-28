use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;

use komla::{FileListFingerprint, RepositorySnapshot};

use crate::clock::now_ms;

pub(crate) struct SnapshotScan {
    pub(crate) workspace_key: usize,
    pub(crate) observed_at: u64,
    pub(crate) result: anyhow::Result<RepositorySnapshot>,
}

pub(crate) struct SnapshotScanner {
    sender: Sender<SnapshotScan>,
    receiver: Receiver<SnapshotScan>,
    runner: Arc<SnapshotRunner>,
    pending: VecDeque<SnapshotRequest>,
    in_flight: usize,
    max_concurrent: usize,
}

struct SnapshotRequest {
    workspace_key: usize,
    working_tree: PathBuf,
    target_branch: String,
    file_list: FileListFingerprint,
}

type SnapshotRunner =
    dyn Fn(&Path, &str, FileListFingerprint) -> anyhow::Result<RepositorySnapshot> + Send + Sync;

const MAX_CONCURRENT_SCANS: usize = 2;

impl SnapshotScanner {
    pub(crate) fn new() -> Self {
        Self::with_runner(
            MAX_CONCURRENT_SCANS,
            RepositorySnapshot::read_with_file_list,
        )
    }

    fn with_runner(
        max_concurrent: usize,
        runner: impl Fn(&Path, &str, FileListFingerprint) -> anyhow::Result<RepositorySnapshot>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        let (sender, receiver) = mpsc::channel();
        Self {
            sender,
            receiver,
            runner: Arc::new(runner),
            pending: VecDeque::new(),
            in_flight: 0,
            max_concurrent: max_concurrent.max(1),
        }
    }

    pub(crate) fn start(
        &mut self,
        workspace_key: usize,
        working_tree: PathBuf,
        target_branch: String,
        file_list: FileListFingerprint,
    ) {
        self.pending.push_back(SnapshotRequest {
            workspace_key,
            working_tree,
            target_branch,
            file_list,
        });
        self.start_queued();
    }

    /// Drops queued scans for a workspace that is no longer monitored.
    pub(crate) fn forget(&mut self, workspace_key: usize) {
        self.pending
            .retain(|request| request.workspace_key != workspace_key);
    }

    fn start_queued(&mut self) {
        while self.in_flight < self.max_concurrent {
            let Some(request) = self.pending.pop_front() else {
                return;
            };
            self.in_flight += 1;
            self.spawn(request);
        }
    }

    fn spawn(&self, request: SnapshotRequest) {
        let sender = self.sender.clone();
        let runner = Arc::clone(&self.runner);
        std::thread::spawn(move || {
            let observed_at = now_ms();
            let result = runner(
                &request.working_tree,
                &request.target_branch,
                request.file_list,
            );
            let _ = sender.send(SnapshotScan {
                workspace_key: request.workspace_key,
                observed_at,
                result,
            });
        });
    }

    pub(crate) fn try_recv(&mut self) -> Option<SnapshotScan> {
        let scan = self.receiver.try_recv().ok()?;
        self.in_flight = self.in_flight.saturating_sub(1);
        self.start_queued();
        Some(scan)
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::{mpsc, Arc, Condvar, Mutex};
    use std::time::Duration;

    use komla::FileListFingerprint;

    use super::SnapshotScanner;

    #[test]
    fn timestamps_a_scan_before_reading_so_slow_results_cannot_look_newer() {
        let (sender, receiver) = mpsc::channel();
        let mut scanner = SnapshotScanner::with_runner(1, move |_, _, _| {
            sender.send(crate::clock::now_ms()).unwrap();
            std::thread::sleep(Duration::from_millis(20));
            Err(anyhow::anyhow!("controlled scan"))
        });
        scanner.start(
            0,
            "/repository".into(),
            "main".into(),
            FileListFingerprint::Compute,
        );
        let started = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        loop {
            if let Some(scan) = scanner.try_recv() {
                assert!(scan.observed_at <= started);
                break;
            }
            assert!(std::time::Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn forgets_queued_scans_for_removed_workspaces() {
        let (_release, blocked) = mpsc::channel::<()>();
        let blocked = Mutex::new(blocked);
        let mut scanner = SnapshotScanner::with_runner(1, move |_: &Path, _: &str, _| {
            let _ = blocked.lock().unwrap().recv();
            Err(anyhow::anyhow!("controlled scan"))
        });
        for workspace_key in 0..3 {
            scanner.start(
                workspace_key,
                format!("/repo-{workspace_key}").into(),
                "main".to_owned(),
                FileListFingerprint::Compute,
            );
        }

        scanner.forget(1);

        let queued: Vec<_> = scanner
            .pending
            .iter()
            .map(|request| request.workspace_key)
            .collect();
        assert_eq!(queued, [2]);
    }

    #[test]
    fn bounds_concurrent_repository_scans() {
        let (started_sender, started_receiver) = mpsc::channel();
        let permits = Arc::new((Mutex::new(0_u32), Condvar::new()));
        let runner_permits = Arc::clone(&permits);
        let mut scanner = SnapshotScanner::with_runner(2, move |_: &Path, _: &str, _| {
            started_sender.send(()).unwrap();
            let (lock, ready) = &*runner_permits;
            let mut available = lock.lock().unwrap();
            while *available == 0 {
                available = ready.wait(available).unwrap();
            }
            *available -= 1;
            Err(anyhow::anyhow!("controlled scan finished"))
        });

        for workspace_key in 0..3 {
            scanner.start(
                workspace_key,
                format!("/repo-{workspace_key}").into(),
                "main".to_owned(),
                FileListFingerprint::Compute,
            );
        }

        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(started_receiver
            .recv_timeout(Duration::from_millis(100))
            .is_err());

        let (lock, ready) = &*permits;
        *lock.lock().unwrap() = 1;
        ready.notify_one();
        let deadline = std::time::Instant::now() + Duration::from_secs(1);
        while scanner.try_recv().is_none() && std::time::Instant::now() < deadline {
            std::thread::yield_now();
        }
        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        *lock.lock().unwrap() = 2;
        ready.notify_all();
    }
}
