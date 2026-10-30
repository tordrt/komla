//! An authenticated phone's requests: the workspace list, one attached terminal at a time, and
//! creating, starting and stopping workspaces and their tabs from what the desktop shared in
//! `launch.json`. What needs the desktop itself (voice, push, generated titles, Quick Commands) is
//! reported as unavailable so the phone can say so.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

use super::attention::AttentionBoard;
use super::frame_budget::{split_json_string, MAX_BODY_BYTES};
use super::launch::HostLaunch;
use super::terminal::{session_exists, TerminalClient, TerminalEvent};
use super::workspace_control::{self, CreateRequest, TerminalSource};
use super::workspaces::{live_sessions, read_workspaces};
use crate::automation::host_caller;
use crate::clock::now_ms;
use crate::offline_workspace::TmuxSessionLauncher;

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
const MAX_REATTACHES: usize = 3;
const REATTACH_WINDOW_MS: u64 = 10_000;
const NEEDS_DESKTOP: &str = "Open Komla on your computer for this.";
const TERMINAL_STOPPED: &str =
    "This tab isn't running. Start the workspace to run its agent again.";
const MAX_ID_CHARS: usize = 128;
const MAX_NAME_CHARS: usize = 256;
const MAX_PROMPT_CHARS: usize = 64 * 1024;
/// The protocol's limit on an `app:error` message.
const MAX_ERROR_CHARS: usize = 2048;

pub(crate) struct SessionEnvironment {
    pub(crate) base: PathBuf,
    pub(crate) tmux_socket: String,
    pub(crate) host_name: String,
    pub(crate) attention: Arc<Mutex<AttentionBoard>>,
    /// The desktop's `launch.json`: what this host may start.
    pub(crate) launch_path: PathBuf,
    /// The phone agreed to take projects' icons.
    pub(crate) project_icons: bool,
    /// The phone agreed to take workspaces' tags.
    pub(crate) workspace_tags: bool,
}

struct Attached {
    workspace_id: String,
    client: TerminalClient,
    generation: u64,
    seq: u64,
    cols: u16,
    rows: u16,
    reattaches: VecDeque<u64>,
}

pub(crate) struct AppSession {
    environment: SessionEnvironment,
    events: SyncSender<TerminalEvent>,
    wake: Arc<dyn Fn() + Send + Sync>,
    attached: Option<(String, Attached)>,
    next_attach_id: u64,
    last_list: Option<Value>,
}

fn error(request_id: Option<&str>, code: &str, message: &str) -> Value {
    let message: String = message.chars().take(MAX_ERROR_CHARS).collect();
    let message = if message.trim().is_empty() {
        "the request failed".to_owned()
    } else {
        message
    };
    let mut frame = json!({ "type": "app:error", "code": code, "message": message });
    if let Some(request_id) = request_id {
        frame["requestId"] = Value::String(request_id.to_owned());
    }
    frame
}

/// `app:workspaces` frames that each fit one encrypted frame; all but the last say `more`.
fn workspace_pages(request_id: &str, workspaces: Value) -> Vec<Value> {
    let empty = json!({
        "type": "app:workspaces",
        "requestId": request_id,
        "workspaces": [],
        "more": true,
    });
    let budget = MAX_BODY_BYTES - empty.to_string().len();
    let mut pages: Vec<Vec<Value>> = vec![Vec::new()];
    let mut bytes = 0;
    for workspace in workspaces.as_array().cloned().unwrap_or_default() {
        // Count the comma that separates it from the next summary.
        let size = workspace.to_string().len() + 1;
        let page = pages.last_mut().expect("one page at least");
        if bytes + size > budget && !page.is_empty() {
            pages.push(Vec::new());
            bytes = 0;
        }
        pages.last_mut().expect("one page at least").push(workspace);
        bytes += size;
    }
    let last = pages.len() - 1;
    pages
        .into_iter()
        .enumerate()
        .map(|(index, page)| {
            let mut frame = json!({
                "type": "app:workspaces",
                "requestId": request_id,
                "workspaces": page,
            });
            if index < last {
                frame["more"] = Value::Bool(true);
            }
            frame
        })
        .collect()
}

/// An optional string field of at most `max_chars`; `Err` when it is there but isn't one.
fn optional_text(frame: &Value, key: &str, max_chars: usize) -> Result<Option<String>, ()> {
    match frame.get(key) {
        None => Ok(None),
        Some(Value::String(text)) if text.chars().count() <= max_chars => Ok(Some(text.clone())),
        Some(_) => Err(()),
    }
}

/// Ids are only compared with the manifests' and `launch.json`'s, as the protocol allows any.
fn optional_id(frame: &Value, key: &str) -> Result<Option<String>, ()> {
    match optional_text(frame, key, MAX_ID_CHARS)? {
        Some(id) if id.is_empty() => Err(()),
        id => Ok(id),
    }
}

fn required_id(frame: &Value, key: &str) -> Result<String, ()> {
    optional_id(frame, key)?.ok_or(())
}

fn create_request(frame: &Value) -> Result<CreateRequest, ()> {
    let non_empty = |text: Option<String>| text.filter(|text| !text.trim().is_empty());
    Ok(CreateRequest {
        project_id: required_id(frame, "projectId")?,
        preset_id: optional_id(frame, "presetId")?,
        launch_mode_id: optional_id(frame, "launchModeId")?,
        name: non_empty(optional_text(frame, "name", MAX_NAME_CHARS)?),
        branch: non_empty(optional_text(frame, "branchName", MAX_NAME_CHARS)?),
        prompt: non_empty(optional_text(frame, "initialPrompt", MAX_PROMPT_CHARS)?),
    })
}

fn terminal_source(source: &Value) -> Result<Option<TerminalSource>, ()> {
    match source["kind"].as_str() {
        Some("shell") => Ok(Some(TerminalSource::Shell)),
        Some("agent") => Ok(Some(TerminalSource::Agent {
            preset_id: required_id(source, "presetId")?,
            launch_mode_id: optional_id(source, "launchModeId")?,
            prompt: optional_text(source, "prompt", MAX_PROMPT_CHARS)?
                .filter(|prompt| !prompt.trim().is_empty()),
        })),
        Some("action") => Ok(None),
        _ => Err(()),
    }
}

fn bad_request(request_id: Option<&str>) -> Vec<Value> {
    vec![error(request_id, "bad-request", "invalid remote app frame")]
}

fn dimension(value: &Value, fallback: u16) -> u16 {
    value
        .as_u64()
        .filter(|value| (1..=1000).contains(value))
        .map_or(fallback, |value| value as u16)
}

impl AppSession {
    pub(crate) fn new(
        environment: SessionEnvironment,
        events: SyncSender<TerminalEvent>,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            environment,
            events,
            wake,
            attached: None,
            next_attach_id: 1,
            last_list: None,
        }
    }

    fn workspace_list(&self) -> Value {
        let sessions = live_sessions(&self.environment.tmux_socket);
        let attention = self
            .environment
            .attention
            .lock()
            .expect("attention lock poisoned");
        Value::Array(
            read_workspaces(&self.environment.base)
                .iter()
                .map(|workspace| {
                    let mut summary =
                        workspace.summary(&sessions, &attention, &self.environment.host_name);
                    if !self.environment.workspace_tags {
                        if let Some(summary) = summary.as_object_mut() {
                            summary.remove("tag");
                        }
                    }
                    summary
                })
                .collect(),
        )
    }

    pub(crate) fn handle(&mut self, frame: &Value) -> Vec<Value> {
        let request_id = frame["requestId"].as_str();
        match frame["type"].as_str().unwrap_or_default() {
            "app:workspaces:list" => {
                let workspaces = self.workspace_list();
                self.last_list = Some(workspaces.clone());
                workspace_pages(request_id.unwrap_or("list"), workspaces)
            }
            "app:launch-options:get" => {
                let request_id = request_id.unwrap_or("launch");
                match HostLaunch::load(&self.environment.launch_path) {
                    Ok(launch) => vec![launch.options_frame(
                        request_id,
                        &self.environment.base,
                        &self.environment.host_name,
                        self.environment.project_icons,
                    )],
                    Err(cause) => {
                        eprintln!("phone launch options not read: {cause:#}");
                        vec![HostLaunch::default().options_frame(
                            request_id,
                            &self.environment.base,
                            &self.environment.host_name,
                            false,
                        )]
                    }
                }
            }
            "app:voice:status" => vec![json!({
                "type": "app:voice:availability",
                "requestId": request_id.unwrap_or("voice"),
                "available": false,
            })],
            "app:push:config:get" => vec![json!({
                "type": "app:push:config",
                "requestId": request_id.unwrap_or("push"),
                "available": false,
                "subscribed": false,
                "notifyWhen": "away",
            })],
            "app:client:visibility" => Vec::new(),
            "app:terminal:attach" => self.attach(frame),
            "app:terminal:input" => {
                let terminal_id = frame["terminalId"].as_str().unwrap_or_default();
                let data = frame["data"].as_str().unwrap_or_default();
                match &mut self.attached {
                    Some((attached_id, attached)) if attached_id == terminal_id => {
                        if attached.client.write_input(data.as_bytes()).is_err() {
                            return vec![error(
                                None,
                                "terminal-input-failed",
                                "input did not reach the terminal",
                            )];
                        }
                        Vec::new()
                    }
                    _ => Vec::new(),
                }
            }
            "app:terminal:resize" => {
                let terminal_id = frame["terminalId"].as_str().unwrap_or_default();
                if let Some((attached_id, attached)) = &mut self.attached {
                    if attached_id == terminal_id {
                        attached.cols = dimension(&frame["cols"], attached.cols);
                        attached.rows = dimension(&frame["rows"], attached.rows);
                        let _ = attached.client.resize(attached.cols, attached.rows);
                    }
                }
                Vec::new()
            }
            "app:terminal:detach" => {
                let terminal_id = frame["terminalId"].as_str().unwrap_or_default();
                if self
                    .attached
                    .as_ref()
                    .is_some_and(|(attached_id, _)| attached_id == terminal_id)
                {
                    self.attached = None;
                }
                Vec::new()
            }
            "app:workspace:create" => self.create_workspace(frame),
            "app:workspace:start" => self.start_workspace(frame),
            "app:workspace:stop" => self.stop_workspace(frame),
            "app:terminal:create" => self.create_terminal(frame),
            "app:terminal:close" => self.close_terminal(frame),
            "app:workspace:title:regenerate"
            | "app:voice:transcribe"
            | "app:push:subscribe"
            | "app:push:unsubscribe"
            | "app:push:test" => vec![error(request_id, "unsupported", NEEDS_DESKTOP)],
            other => vec![error(
                request_id,
                "bad-request",
                &format!(
                    "unrecognized remote app frame {}",
                    other.chars().take(64).collect::<String>()
                ),
            )],
        }
    }

    fn launcher(&self) -> TmuxSessionLauncher {
        TmuxSessionLauncher::on_socket(&self.environment.base, &self.environment.tmux_socket)
    }

    /// One workspace's summary as the list now has it, and the list for the phone to refresh.
    fn workspace_reply(
        &mut self,
        frame: Value,
        request_id: &str,
        workspace_id: &str,
    ) -> Vec<Value> {
        let workspaces = self.workspace_list();
        let Some(summary) = workspaces
            .as_array()
            .and_then(|list| {
                list.iter()
                    .find(|workspace| workspace["id"] == workspace_id)
            })
            .cloned()
        else {
            return vec![error(
                Some(request_id),
                "workspace-not-found",
                "this workspace is not on this host",
            )];
        };
        let mut frame = frame;
        frame["requestId"] = Value::String(request_id.to_owned());
        frame["workspace"] = summary;
        self.last_list = Some(workspaces.clone());
        let mut frames = vec![frame];
        frames.extend(workspace_pages(request_id, workspaces));
        frames
    }

    /// Cutting a worktree fetches first, so it runs off this connection's thread.
    fn create_workspace(&mut self, frame: &Value) -> Vec<Value> {
        let request_id = frame["requestId"].as_str().unwrap_or("create").to_owned();
        let Ok(request) = create_request(frame) else {
            return bad_request(Some(&request_id));
        };
        let launch = match HostLaunch::load(&self.environment.launch_path) {
            Ok(launch) => launch,
            Err(cause) => {
                return vec![error(
                    Some(&request_id),
                    "create-failed",
                    &format!("{cause:#}"),
                )]
            }
        };
        let environment = &frame["environment"];
        if !environment.is_null()
            && (environment["kind"] != "ssh" || environment["hostId"] != launch.host_id())
        {
            return vec![error(
                Some(&request_id),
                "unsupported",
                "This host creates workspaces only on itself. Open Komla on your computer for others.",
            )];
        }
        let base = self.environment.base.clone();
        let mut launcher = self.launcher();
        let events = self.events.clone();
        let wake = Arc::clone(&self.wake);
        let spawned = thread::Builder::new()
            .name("phone-create-workspace".to_owned())
            .spawn(move || {
                let result = workspace_control::create(
                    &host_caller(&base),
                    &launch,
                    &request,
                    &mut launcher,
                    now_ms(),
                )
                .map_err(|cause| format!("{cause:#}"));
                let _ = events.send(TerminalEvent::WorkspaceCreated { request_id, result });
                wake();
            });
        match spawned {
            Ok(_) => Vec::new(),
            Err(cause) => vec![error(
                frame["requestId"].as_str(),
                "create-failed",
                &format!("could not start creating the workspace: {cause}"),
            )],
        }
    }

    fn start_workspace(&mut self, frame: &Value) -> Vec<Value> {
        let request_id = frame["requestId"].as_str().unwrap_or("start").to_owned();
        let Ok(workspace_id) = required_id(frame, "workspaceId") else {
            return bad_request(Some(&request_id));
        };
        self.detach_workspace(&workspace_id);
        let caller = host_caller(&self.environment.base);
        if let Err(cause) =
            workspace_control::start(&caller, &workspace_id, &mut self.launcher(), now_ms())
        {
            return vec![error(
                Some(&request_id),
                "start-failed",
                &format!("{cause:#}"),
            )];
        }
        self.workspace_reply(
            json!({ "type": "app:workspace:started" }),
            &request_id,
            &workspace_id,
        )
    }

    fn stop_workspace(&mut self, frame: &Value) -> Vec<Value> {
        let request_id = frame["requestId"].as_str().unwrap_or("stop").to_owned();
        let Ok(workspace_id) = required_id(frame, "workspaceId") else {
            return bad_request(Some(&request_id));
        };
        self.detach_workspace(&workspace_id);
        if let Err(cause) =
            workspace_control::stop(&self.environment.base, &workspace_id, &mut self.launcher())
        {
            return vec![error(
                Some(&request_id),
                "stop-failed",
                &format!("{cause:#}"),
            )];
        }
        self.workspace_reply(
            json!({ "type": "app:workspace:stopped" }),
            &request_id,
            &workspace_id,
        )
    }

    fn create_terminal(&mut self, frame: &Value) -> Vec<Value> {
        let request_id = frame["requestId"].as_str().unwrap_or("terminal").to_owned();
        let (Ok(workspace_id), Ok(source)) = (
            required_id(frame, "workspaceId"),
            terminal_source(&frame["source"]),
        ) else {
            return bad_request(Some(&request_id));
        };
        let Some(source) = source else {
            return vec![error(Some(&request_id), "unsupported", NEEDS_DESKTOP)];
        };
        let launch = match HostLaunch::load(&self.environment.launch_path) {
            Ok(launch) => launch,
            Err(cause) => {
                return vec![error(
                    Some(&request_id),
                    "terminal-create-failed",
                    &format!("{cause:#}"),
                )]
            }
        };
        let caller = host_caller(&self.environment.base);
        let terminal_id = match workspace_control::add_terminal(
            &caller,
            &launch,
            &workspace_id,
            &source,
            &mut self.launcher(),
            now_ms(),
        ) {
            Ok(terminal_id) => terminal_id,
            Err(cause) => {
                return vec![error(
                    Some(&request_id),
                    "terminal-create-failed",
                    &format!("{cause:#}"),
                )]
            }
        };
        self.workspace_reply(
            json!({ "type": "app:terminal:created", "terminalId": terminal_id }),
            &request_id,
            &workspace_id,
        )
    }

    fn close_terminal(&mut self, frame: &Value) -> Vec<Value> {
        let request_id = frame["requestId"].as_str().unwrap_or("close").to_owned();
        let (Ok(workspace_id), Ok(terminal_id)) = (
            required_id(frame, "workspaceId"),
            required_id(frame, "terminalId"),
        ) else {
            return bad_request(Some(&request_id));
        };
        if self
            .attached
            .as_ref()
            .is_some_and(|(attached_id, _)| *attached_id == terminal_id)
        {
            self.attached = None;
        }
        if let Err(cause) = workspace_control::close_terminal(
            &self.environment.base,
            &workspace_id,
            &terminal_id,
            &mut self.launcher(),
            now_ms(),
        ) {
            return vec![error(
                Some(&request_id),
                "terminal-close-failed",
                &format!("{cause:#}"),
            )];
        }
        self.workspace_reply(
            json!({ "type": "app:terminal:closed", "terminalId": terminal_id }),
            &request_id,
            &workspace_id,
        )
    }

    /// Lets go of the attached terminal if it is the workspace's, before its sessions end.
    fn detach_workspace(&mut self, workspace_id: &str) {
        if self
            .attached
            .as_ref()
            .is_some_and(|(_, attached)| attached.workspace_id == workspace_id)
        {
            self.attached = None;
        }
    }

    fn attach(&mut self, frame: &Value) -> Vec<Value> {
        let request_id = frame["requestId"].as_str().unwrap_or("attach").to_owned();
        let workspace_id = frame["workspaceId"].as_str().unwrap_or_default().to_owned();
        let sessions = live_sessions(&self.environment.tmux_socket);
        let Some(workspace) = read_workspaces(&self.environment.base)
            .into_iter()
            .find(|workspace| workspace.id == workspace_id)
        else {
            return vec![error(
                Some(&request_id),
                "workspace-not-found",
                "this workspace is not on this host",
            )];
        };
        let requested = frame["terminalId"].as_str();
        let terminal_id = match requested {
            Some(id) => workspace
                .terminals
                .iter()
                .find(|terminal| terminal.id == id),
            None => workspace
                .terminals
                .iter()
                .find(|terminal| sessions.contains_key(&terminal.id)),
        }
        .map(|terminal| terminal.id.clone());
        let Some(terminal_id) = terminal_id.filter(|id| sessions.contains_key(id)) else {
            return vec![error(
                Some(&request_id),
                "terminal-stopped",
                TERMINAL_STOPPED,
            )];
        };
        let cols = dimension(&frame["cols"], DEFAULT_COLS);
        let rows = dimension(&frame["rows"], DEFAULT_ROWS);
        self.attached = None;

        let attach_id = self.next_attach_id;
        self.next_attach_id += 1;
        let wake = Arc::clone(&self.wake);
        let client = match TerminalClient::attach(
            &self.environment.tmux_socket,
            &terminal_id,
            attach_id,
            cols,
            rows,
            self.events.clone(),
            move || wake(),
        ) {
            Ok(client) => client,
            Err(cause) => {
                return vec![error(
                    Some(&request_id),
                    "terminal-attach-failed",
                    &cause.to_string(),
                )]
            }
        };
        let viewed = self
            .environment
            .attention
            .lock()
            .expect("attention lock poisoned")
            .mark_viewed(&terminal_id);
        let mut frames = vec![
            json!({
                "type": "app:terminal:attached",
                "requestId": request_id,
                "snapshot": {
                    "workspaceId": workspace_id,
                    "terminalId": terminal_id,
                    "status": "running",
                    "seq": 0,
                    "generation": 1,
                    "cols": cols,
                    "rows": rows,
                    "chunkCount": 1,
                },
            }),
            // tmux repaints the whole screen once its client attaches.
            json!({
                "type": "app:terminal:snapshot-chunk",
                "requestId": request_id,
                "terminalId": terminal_id,
                "generation": 1,
                "index": 0,
                "data": "",
            }),
        ];
        self.attached = Some((
            terminal_id,
            Attached {
                workspace_id,
                client,
                generation: 1,
                seq: 0,
                cols,
                rows,
                reattaches: VecDeque::new(),
            },
        ));
        if viewed {
            frames.extend(self.list_if_changed());
        }
        frames
    }

    pub(crate) fn on_event(&mut self, event: TerminalEvent, now: u64) -> Vec<Value> {
        match event {
            TerminalEvent::Output {
                terminal_id,
                attach_id,
                data,
            } => {
                let Some((attached_id, attached)) = &mut self.attached else {
                    return Vec::new();
                };
                if *attached_id != terminal_id || attached.client.attach_id != attach_id {
                    return Vec::new();
                }
                let empty = json!({
                    "type": "app:terminal:data",
                    "workspaceId": attached.workspace_id,
                    "terminalId": terminal_id,
                    "data": "",
                    "seq": u64::MAX,
                    "generation": u64::MAX,
                });
                let budget = MAX_BODY_BYTES - empty.to_string().len();
                // A read too large for one frame becomes several, each with its own seq.
                split_json_string(&data, budget)
                    .into_iter()
                    .map(|piece| {
                        attached.seq += 1;
                        json!({
                            "type": "app:terminal:data",
                            "workspaceId": attached.workspace_id,
                            "terminalId": terminal_id,
                            "data": piece,
                            "seq": attached.seq,
                            "generation": attached.generation,
                        })
                    })
                    .collect()
            }
            TerminalEvent::Exited {
                terminal_id,
                attach_id,
            } => self.on_exit(&terminal_id, attach_id, now),
            TerminalEvent::WorkspaceCreated { request_id, result } => match result {
                Ok(workspace_id) => self.workspace_reply(
                    json!({ "type": "app:workspace:created" }),
                    &request_id,
                    &workspace_id,
                ),
                Err(message) => vec![error(Some(&request_id), "create-failed", &message)],
            },
        }
    }

    /// The tmux client ended: the session stopped, or another client attached with `-d`.
    fn on_exit(&mut self, terminal_id: &str, attach_id: u64, now: u64) -> Vec<Value> {
        let Some((attached_id, attached)) = &mut self.attached else {
            return Vec::new();
        };
        if attached_id != terminal_id || attached.client.attach_id != attach_id {
            return Vec::new();
        }
        while attached
            .reattaches
            .front()
            .is_some_and(|at| now.saturating_sub(*at) > REATTACH_WINDOW_MS)
        {
            attached.reattaches.pop_front();
        }
        if attached.reattaches.len() < MAX_REATTACHES
            && session_exists(&self.environment.tmux_socket, terminal_id)
        {
            let next_id = self.next_attach_id;
            self.next_attach_id += 1;
            let wake = Arc::clone(&self.wake);
            if let Ok(client) = TerminalClient::attach(
                &self.environment.tmux_socket,
                terminal_id,
                next_id,
                attached.cols,
                attached.rows,
                self.events.clone(),
                move || wake(),
            ) {
                attached.client = client;
                attached.reattaches.push_back(now);
                attached.generation += 1;
                return vec![json!({
                    "type": "app:terminal:reset",
                    "workspaceId": attached.workspace_id,
                    "terminalId": terminal_id,
                    "generation": attached.generation,
                    "seq": attached.seq,
                    "cols": attached.cols,
                    "rows": attached.rows,
                })];
            }
        }
        let workspace_id = attached.workspace_id.clone();
        self.attached = None;
        let mut frames = vec![json!({
            "type": "app:terminal:status",
            "workspaceId": workspace_id,
            "terminalId": terminal_id,
            "status": "stopped",
        })];
        frames.extend(self.list_if_changed());
        frames
    }

    /// Output the phone missed starts a new generation, repainted by tmux.
    pub(crate) fn recover_overflow(&mut self) -> Vec<Value> {
        let Some((terminal_id, attached)) = &mut self.attached else {
            return Vec::new();
        };
        if !attached.client.overflowed.swap(false, Ordering::SeqCst) {
            return Vec::new();
        }
        attached.generation += 1;
        attached.client.refresh();
        vec![json!({
            "type": "app:terminal:reset",
            "workspaceId": attached.workspace_id,
            "terminalId": terminal_id,
            "generation": attached.generation,
            "seq": attached.seq,
            "cols": attached.cols,
            "rows": attached.rows,
        })]
    }

    /// Marks the attached terminal as overflowed after its output could not be queued.
    pub(crate) fn mark_overflowed(&self) {
        if let Some((_, attached)) = &self.attached {
            attached.client.overflowed.store(true, Ordering::SeqCst);
        }
    }

    /// The list, when sessions or agent state changed since the phone last saw it.
    pub(crate) fn list_if_changed(&mut self) -> Vec<Value> {
        let workspaces = self.workspace_list();
        if self.last_list.as_ref() == Some(&workspaces) {
            return Vec::new();
        }
        self.last_list = Some(workspaces.clone());
        workspace_pages("push", workspaces)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_a_workspace_list_too_large_for_one_frame() {
        let workspaces: Vec<Value> = (0..200)
            .map(|index| json!({ "id": format!("w-{index}"), "name": "漢字".repeat(100) }))
            .collect();

        let pages = workspace_pages("r1", Value::Array(workspaces.clone()));

        assert!(pages.len() > 1);
        let (last, rest) = pages.split_last().unwrap();
        assert!(rest.iter().all(|page| page["more"] == true));
        assert!(last.get("more").is_none());
        assert!(pages
            .iter()
            .all(|page| page.to_string().len() <= MAX_BODY_BYTES));
        let ids: Vec<Value> = pages
            .iter()
            .flat_map(|page| page["workspaces"].as_array().unwrap().clone())
            .collect();
        assert_eq!(ids, workspaces);
    }

    #[test]
    fn sends_a_short_or_empty_list_as_one_page() {
        let pages = workspace_pages("push", json!([]));
        assert_eq!(
            pages,
            vec![json!({ "type": "app:workspaces", "requestId": "push", "workspaces": [] })]
        );
    }
}
