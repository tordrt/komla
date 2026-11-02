//! Ends a test process when a test hangs, so CI reports which test stopped and where,
//! instead of holding the runner until the job times out. Tests that start a native
//! filesystem watcher have hung on Windows CI with no output.

use std::io::Write;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Far above what these tests take on a busy CI runner, so only a hang trips it.
const LIMIT: Duration = Duration::from_secs(120);

pub(crate) struct Watchdog {
    step: Arc<Mutex<&'static str>>,
    // Dropped with the watchdog, which wakes and ends its thread.
    _finished: Sender<()>,
}

impl Watchdog {
    pub(crate) fn start(test: &'static str) -> Self {
        let step = Arc::new(Mutex::new("start"));
        let (finished, wait) = mpsc::channel::<()>();
        let reached = Arc::clone(&step);
        std::thread::spawn(move || {
            if wait.recv_timeout(LIMIT) == Err(RecvTimeoutError::Timeout) {
                let step = *reached.lock().unwrap_or_else(|error| error.into_inner());
                // Written to stderr directly: the test harness captures eprintln! output and
                // would drop it when the process exits.
                let _ = writeln!(
                    std::io::stderr(),
                    "{test} hung for {} seconds at: {step}",
                    LIMIT.as_secs()
                );
                // abort, not exit: exit runs process teardown, which can wait on the very
                // thread or lock that hung.
                std::process::abort();
            }
        });
        Self {
            step,
            _finished: finished,
        }
    }

    /// Records what the test is about to do, for the message a hang prints.
    pub(crate) fn step(&self, step: &'static str) {
        *self.step.lock().unwrap_or_else(|error| error.into_inner()) = step;
    }
}
