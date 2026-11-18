//! A connection to a `stackql` engine running as a child process on this
//! machine.
//!
//! This is the only place that knows the engine is a child process.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use tokio::sync::{Notify, watch};

use super::{
    AgentChannel, Connection, DelegateBuilder, EngineState, EngineStatus, EventSink,
    McpServerCommand, SafetyMode,
};
use crate::config::SettingsStore;
use crate::engine::approot::{self, Defaults as ApprootDefaults};
use crate::engine::discovery::{self, Inputs, Resolved};
use crate::engine::logbuf::LogBuffer;
use crate::engine::port::pick_free_port;
use crate::engine::supervisor::{ChildSpec, EnvSpec, ManagedChild, StdioMode, Supervisor};
use crate::error::{HostError, HostResult};
use crate::query::result::{QueryError, QueryEvent, ResultSet, RunSummary};
use crate::query::session::{PgSession, StatementEvent};
use crate::query::split::split_statements;
use crate::util::lock;

/// How long the engine gets to become ready. It normally takes well under a
/// second.
const READY_TIMEOUT: Duration = Duration::from_secs(15);
const READY_POLL: Duration = Duration::from_millis(50);
/// One connect attempt during the readiness check. Kept short because a
/// refused loopback connect is retried by Windows for about half a second.
const READY_ATTEMPT: Duration = Duration::from_millis(300);
const LOG_TAIL_LINES: usize = 40;

/// What a statement needs from a running engine.
#[derive(Clone)]
struct Endpoint {
    port: u16,
    stderr: LogBuffer,
}

/// What the running engine was started with. The agent channel starts its
/// MCP server from the same binary, on the same data folder.
#[derive(Clone)]
struct Launch {
    binary: PathBuf,
    approot: PathBuf,
}

/// State shared with the task that watches for the engine exiting.
struct Shared {
    status: watch::Sender<EngineStatus>,
    endpoint: Mutex<Option<Endpoint>>,
    launch: Mutex<Option<Launch>>,
    /// Bumped on every start and stop, so a watcher from an earlier engine
    /// cannot overwrite the status of a later one.
    generation: AtomicU64,
}

impl Shared {
    fn set_status(&self, status: EngineStatus) {
        self.status.send_replace(status);
    }
}

pub struct LocalConnection {
    supervisor: Supervisor,
    /// Where the engine's data folder goes when settings name none. The
    /// folder is the engine's `--approot` and its working directory.
    approot_defaults: ApprootDefaults,
    /// Where the MCP server writes its audit log.
    audit_dir: PathBuf,
    settings: Arc<SettingsStore>,
    shared: Arc<Shared>,
    /// Serialises start and stop. Holds the engine process.
    lifecycle: tokio::sync::Mutex<Option<ManagedChild>>,
    /// The operator's session. One statement runs on it at a time.
    session: tokio::sync::Mutex<Option<PgSession>>,
    runs: Mutex<HashMap<String, Arc<Notify>>>,
}

impl LocalConnection {
    pub fn new(
        approot_defaults: ApprootDefaults,
        audit_dir: PathBuf,
        settings: Arc<SettingsStore>,
    ) -> HostResult<Self> {
        let supervisor = Supervisor::new().map_err(|err| HostError::Internal(err.to_string()))?;
        let (status, _) = watch::channel(EngineStatus::stopped());
        Ok(Self {
            supervisor,
            approot_defaults,
            audit_dir,
            settings,
            shared: Arc::new(Shared {
                status,
                endpoint: Mutex::new(None),
                launch: Mutex::new(None),
                generation: AtomicU64::new(0),
            }),
            lifecycle: tokio::sync::Mutex::new(None),
            session: tokio::sync::Mutex::new(None),
            runs: Mutex::new(HashMap::new()),
        })
    }

    fn endpoint(&self) -> HostResult<Endpoint> {
        lock(&self.shared.endpoint)
            .clone()
            .ok_or(HostError::EngineNotRunning)
    }

    /// Arguments for `stackql srv`. See the engine interface section of
    /// CLAUDE.md and `docs/spike-pgwire.md` for the reason behind each one.
    fn srv_args(&self, port: u16, approot: &Path, env_file: Option<&str>) -> Vec<OsString> {
        let mut args: Vec<OsString> = vec![
            "srv".into(),
            // The default is 0.0.0.0 and the listener has no authentication.
            "--pgsrv.address".into(),
            "127.0.0.1".into(),
            "--pgsrv.port".into(),
            port.to_string().into(),
            // The default is the working directory.
            "--approot".into(),
            approot.as_os_str().to_os_string(),
            // Without this an upstream API failure is an empty result with
            // the reason only on stderr. With it the reason arrives as a
            // notice on the connection that ran the statement.
            "--pgsrv.debug.enable".into(),
        ];
        if let Some(file) = env_file {
            args.push("--env.file".into());
            args.push(file.into());
        }
        args
    }

    /// Arguments for `stackql mcp`. See `docs/spike-mcp.md`.
    fn mcp_args(&self, mode: SafetyMode, approot: &Path, env_file: Option<&str>) -> Vec<OsString> {
        let config = serde_json::json!({
            "server": {
                "transport": "stdio",
                // The engine classifies each statement and enforces this.
                "mode": mode.as_str(),
                // The default is 30 seconds, which a paged provider query
                // can exceed.
                "request_timeout": "5m",
                "audit": {
                    "format": "jsonl",
                    // The default is the working directory.
                    "file": { "dir": self.audit_dir }
                }
            }
        });
        let mut args: Vec<OsString> = vec![
            "mcp".into(),
            // The default transport is HTTP.
            "--mcp.server.type=stdio".into(),
            "--approot".into(),
            approot.as_os_str().to_os_string(),
        ];
        if let Some(file) = env_file {
            args.push("--env.file".into());
            args.push(file.into());
        }
        args.push("--mcp.config".into());
        args.push(config.to_string().into());
        args
    }

    /// How the engine's MCP server is started in a safety mode, from the
    /// same binary and on the same data folder as the running engine.
    fn mcp_server_command(&self, mode: SafetyMode) -> HostResult<McpServerCommand> {
        let launch = lock(&self.shared.launch)
            .clone()
            .ok_or(HostError::EngineNotRunning)?;
        std::fs::create_dir_all(&self.audit_dir).map_err(|err| {
            HostError::Agent(format!(
                "Could not create the audit folder {}: {err}",
                self.audit_dir.display()
            ))
        })?;
        let settings = self.settings.get();
        Ok(McpServerCommand {
            args: self.mcp_args(mode, &launch.approot, settings.env_file.as_deref()),
            program: launch.binary,
            cwd: launch.approot,
        })
    }

    /// Starts a supervised child that speaks a protocol over its stdio.
    fn piped_child(
        &self,
        program: PathBuf,
        args: Vec<OsString>,
        cwd: PathBuf,
    ) -> HostResult<AgentChannel> {
        let spec = ChildSpec {
            program,
            args,
            // Same environment policy as the operator's engine. The model
            // never sees any of it: tool results are all it receives.
            env: EnvSpec {
                inherit: true,
                vars: Vec::new(),
            },
            cwd,
            stdio: StdioMode::Piped,
        };
        let mut child = self
            .supervisor
            .spawn(&spec)
            .map_err(|err| HostError::Agent(err.to_string()))?;
        let (Some(reader), Some(writer)) = (child.stdout.take(), child.stdin.take()) else {
            return Err(HostError::Agent(format!(
                "{} started without stdio pipes.",
                spec.program.display()
            )));
        };
        Ok(AgentChannel {
            reader: Box::new(reader),
            writer: Box::new(writer),
            diagnostics: child.stderr.clone(),
            keepalive: Box::new(child),
        })
    }

    async fn stop_engine(&self, child: &mut Option<ManagedChild>) {
        self.shared.generation.fetch_add(1, Ordering::SeqCst);
        *lock(&self.shared.endpoint) = None;
        *lock(&self.shared.launch) = None;
        // Drop the session first so its socket closes before the engine goes.
        if let Ok(mut session) = self.session.try_lock() {
            *session = None;
        }
        if let Some(mut running) = child.take() {
            running.stop().await;
        }
    }

    async fn start_engine(&self, child: &mut Option<ManagedChild>) -> EngineStatus {
        self.stop_engine(child).await;
        let generation = self.shared.generation.load(Ordering::SeqCst);
        let settings = self.settings.get();

        let mut status = EngineStatus {
            state: EngineState::Starting,
            ..EngineStatus::stopped()
        };
        self.shared.set_status(status.clone());

        let fail = |mut status: EngineStatus, error: String, log_tail: Vec<String>| {
            status.state = EngineState::Failed;
            status.error = Some(error);
            status.log_tail = log_tail;
            self.shared.set_status(status.clone());
            status
        };

        // 1. Find the binary.
        let inputs = Inputs::from_environment(settings.engine_path.as_ref().map(PathBuf::from));
        let Resolved { path, source } = match discovery::resolve(&inputs, |p| p.is_file()) {
            Ok(found) => found,
            Err(err) => return fail(status, err.to_string(), Vec::new()),
        };
        status.location = Some(path.display().to_string());
        status.location_source = Some(source.label().to_string());
        self.shared.set_status(status.clone());

        // 2. Check it is stackql and read its version.
        match discovery::read_version(&path).await {
            Ok(version) => status.version = Some(version.version),
            Err(err) => return fail(status, err, Vec::new()),
        }
        self.shared.set_status(status.clone());

        // 3. Choose its data folder. A folder named in settings is used or
        // reported as unusable. The defaults fall through to one that works.
        let chosen = match approot::resolve(
            settings.approot.as_deref().map(Path::new),
            &self.approot_defaults,
            approot::prepare,
        ) {
            Ok(chosen) => chosen,
            Err(err) => return fail(status, err.to_string(), Vec::new()),
        };
        status.data_folder = Some(chosen.path.display().to_string());
        status.data_folder_source = Some(chosen.source.label().to_string());
        status.data_folder_note = chosen.note;
        self.shared.set_status(status.clone());
        let approot = chosen.path;

        // 4. Start it on a free loopback port.
        let port = match pick_free_port() {
            Ok(port) => port,
            Err(err) => return fail(status, format!("No free port: {err}"), Vec::new()),
        };
        let spec = ChildSpec {
            program: path.clone(),
            args: self.srv_args(port, &approot, settings.env_file.as_deref()),
            // The engine reads provider credentials from its environment.
            // Until the keychain store exists, the app's environment is the
            // base and an operator-supplied --env.file adds to it. On macOS
            // an app started from Finder has a nearly empty environment, so
            // the env file is the dependable route there.
            env: EnvSpec {
                inherit: true,
                vars: Vec::new(),
            },
            cwd: approot.clone(),
            stdio: StdioMode::Detached,
        };
        let mut running = match self.supervisor.spawn(&spec) {
            Ok(running) => running,
            Err(err) => return fail(status, err.to_string(), Vec::new()),
        };

        // 5. Wait until it answers.
        status.endpoint = Some(format!("127.0.0.1:{port}"));
        match wait_ready(port, &running).await {
            Ok(reported) => {
                if !reported.is_empty() {
                    status.version = Some(reported);
                }
            }
            Err(reason) => {
                let tail = running.stderr.tail(LOG_TAIL_LINES);
                running.stop().await;
                return fail(status, reason, tail);
            }
        }

        // 6. Publish, and watch for it going away.
        *lock(&self.shared.endpoint) = Some(Endpoint {
            port,
            stderr: running.stderr.clone(),
        });
        *lock(&self.shared.launch) = Some(Launch {
            binary: path,
            approot,
        });
        status.state = EngineState::Running;
        self.shared.set_status(status.clone());

        let shared = self.shared.clone();
        let mut exit = running.exit_watch();
        let stderr = running.stderr.clone();
        let running_status = status.clone();
        tokio::spawn(async move {
            while exit.borrow().is_none() {
                if exit.changed().await.is_err() {
                    return;
                }
            }
            let info = exit.borrow().clone();
            let Some(info) = info else { return };
            if info.requested || shared.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            *lock(&shared.endpoint) = None;
            let code = info
                .code
                .map_or_else(|| "no exit code".to_string(), |c| format!("exit code {c}"));
            shared.set_status(EngineStatus {
                state: EngineState::Failed,
                error: Some(format!("The engine stopped unexpectedly ({code}).")),
                log_tail: stderr.tail(LOG_TAIL_LINES),
                endpoint: None,
                ..running_status
            });
        });

        *child = Some(running);
        status
    }
}

/// Polls until the engine answers `SHOW VERSION`, the engine exits, or time
/// runs out. Returns the version the engine reports.
async fn wait_ready(port: u16, child: &ManagedChild) -> Result<String, String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if let Some(exit) = child.exit_info() {
            let code = exit
                .code
                .map_or_else(|| "no exit code".to_string(), |c| format!("exit code {c}"));
            return Err(format!("The engine exited while starting ({code})."));
        }
        let last_error = match PgSession::connect_with_timeout(port, READY_ATTEMPT).await {
            Ok(mut session) => match session.fetch("SHOW VERSION").await {
                Ok(result) if result.rows.len() == 1 => {
                    let version = result
                        .column("version")
                        .and_then(|i| result.rows[0].get(i).cloned().flatten())
                        .unwrap_or_default();
                    return Ok(version);
                }
                Ok(_) => "SHOW VERSION returned an unexpected result.".to_string(),
                Err(err) => err.message,
            },
            Err(err) => err.message,
        };
        if Instant::now() >= deadline {
            return Err(format!(
                "The engine did not become ready within {} seconds. Last error: {last_error}",
                READY_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(READY_POLL).await;
    }
}

/// Removes a run from the registry when the run ends, however it ends.
struct RunGuard<'a> {
    runs: &'a Mutex<HashMap<String, Arc<Notify>>>,
    id: String,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        lock(self.runs).remove(&self.id);
    }
}

fn elapsed_ms(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)
}

impl Connection for LocalConnection {
    fn status(&self) -> EngineStatus {
        self.shared.status.borrow().clone()
    }

    fn watch_status(&self) -> watch::Receiver<EngineStatus> {
        self.shared.status.subscribe()
    }

    fn start(&self) -> BoxFuture<'_, EngineStatus> {
        async move {
            let mut child = self.lifecycle.lock().await;
            self.start_engine(&mut child).await
        }
        .boxed()
    }

    fn restart(&self) -> BoxFuture<'_, EngineStatus> {
        self.start()
    }

    fn shutdown(&self) -> BoxFuture<'_, ()> {
        async move {
            let mut child = self.lifecycle.lock().await;
            self.stop_engine(&mut child).await;
            self.shared.set_status(EngineStatus::stopped());
        }
        .boxed()
    }

    fn run(
        &self,
        run_id: String,
        sql: String,
        sink: EventSink,
    ) -> BoxFuture<'_, HostResult<RunSummary>> {
        async move {
            let endpoint = self.endpoint()?;
            let mut session = self.session.try_lock().map_err(|_| HostError::Busy)?;

            let abandon = Arc::new(Notify::new());
            lock(&self.runs).insert(run_id.clone(), abandon.clone());
            let _guard = RunGuard {
                runs: &self.runs,
                id: run_id,
            };

            let statements = split_statements(&sql);
            let total = statements.len();
            let started = Instant::now();
            let mut summary = RunSummary {
                statements: total,
                completed: 0,
                failed: false,
                abandoned: false,
                elapsed_ms: 0,
            };

            for (index, statement) in statements.into_iter().enumerate() {
                sink(QueryEvent::StatementStarted {
                    index,
                    total,
                    sql: statement.clone(),
                });
                let statement_started = Instant::now();
                let log_mark = endpoint.stderr.mark();

                // Reconnect if there is no session or the last one broke.
                if session.as_ref().is_none_or(PgSession::is_closed) {
                    *session = None;
                    match PgSession::connect(endpoint.port).await {
                        Ok(fresh) => *session = Some(fresh),
                        Err(error) => {
                            sink(QueryEvent::StatementFailed {
                                index,
                                error,
                                elapsed_ms: elapsed_ms(statement_started),
                            });
                            summary.failed = true;
                            break;
                        }
                    }
                }
                let Some(active) = session.as_mut() else {
                    break;
                };

                let mut forward = |event: StatementEvent| {
                    sink(match event {
                        StatementEvent::Columns(columns) => QueryEvent::Columns { index, columns },
                        StatementEvent::Rows(rows) => QueryEvent::Rows { index, rows },
                        StatementEvent::Notice(notice) => QueryEvent::Notice { index, notice },
                    });
                };
                let outcome: Option<Result<u64, QueryError>> = tokio::select! {
                    result = active.run(&statement, &mut forward) => Some(result),
                    () = abandon.notified() => None,
                };

                let lines = endpoint.stderr.since(log_mark);
                if !lines.is_empty() {
                    sink(QueryEvent::EngineLog { index, lines });
                }

                match outcome {
                    Some(Ok(row_count)) => {
                        sink(QueryEvent::StatementFinished {
                            index,
                            row_count,
                            elapsed_ms: elapsed_ms(statement_started),
                        });
                        summary.completed += 1;
                    }
                    Some(Err(error)) => {
                        if error.connection_lost {
                            *session = None;
                        }
                        sink(QueryEvent::StatementFailed {
                            index,
                            error,
                            elapsed_ms: elapsed_ms(statement_started),
                        });
                        summary.failed = true;
                        break;
                    }
                    None => {
                        // The statement is still running in the engine. All
                        // the host can do is let go of the connection.
                        *session = None;
                        summary.abandoned = true;
                        break;
                    }
                }
            }

            summary.elapsed_ms = elapsed_ms(started);
            Ok(summary)
        }
        .boxed()
    }

    fn abandon(&self, run_id: &str) -> bool {
        match lock(&self.runs).get(run_id) {
            Some(notify) => {
                // notify_one keeps a permit if the run is between statements,
                // so the next wait sees it.
                notify.notify_one();
                true
            }
            None => false,
        }
    }

    fn fetch(&self, sql: String) -> BoxFuture<'_, HostResult<ResultSet>> {
        async move {
            let endpoint = self.endpoint()?;
            let mut session = PgSession::connect(endpoint.port)
                .await
                .map_err(|err| HostError::Query(err.message))?;
            session
                .fetch(&sql)
                .await
                .map_err(|err| HostError::Query(err.message))
        }
        .boxed()
    }

    fn open_agent_channel(&self, mode: SafetyMode) -> BoxFuture<'_, HostResult<AgentChannel>> {
        async move {
            let server = self.mcp_server_command(mode)?;
            // stdout and stdin carry protocol frames and nothing else.
            self.piped_child(server.program, server.args, server.cwd)
        }
        .boxed()
    }

    fn open_delegate_channel<'a>(
        &'a self,
        mode: SafetyMode,
        build: DelegateBuilder<'a>,
    ) -> BoxFuture<'a, HostResult<AgentChannel>> {
        async move {
            let command = build(self.mcp_server_command(mode)?)?;
            self.piped_child(command.program, command.args, command.cwd)
        }
        .boxed()
    }

    fn audit_dir(&self) -> Option<PathBuf> {
        Some(self.audit_dir.clone())
    }
}
