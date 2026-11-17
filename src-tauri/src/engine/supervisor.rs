//! The one owner of every child process.
//!
//! Guarantees:
//!
//! - A child never outlives the app. On Windows every child is placed in a
//!   job object that the OS tears down when the app's handle closes. On Unix
//!   every child leads its own process group and has a watchdog that signals
//!   the group when the app dies. Both work when the app is force-quit.
//! - stderr of every child is captured.
//! - For a stdio child, stdin and stdout are handed to the caller untouched,
//!   because they carry protocol frames.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, watch};

use super::logbuf::LogBuffer;

#[derive(Debug, thiserror::Error)]
pub enum SupervisorError {
    #[error("Could not set up process supervision: {0}")]
    Setup(std::io::Error),
    #[error("Could not start {program}: {source}")]
    Spawn {
        program: String,
        source: std::io::Error,
    },
    #[error("Started {program} but could not tie it to the app, so it was stopped: {source}")]
    Tie {
        program: String,
        source: std::io::Error,
    },
}

/// How a child's stdin and stdout are connected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StdioMode {
    /// Both closed. For a server that is reached over a socket.
    Detached,
    /// Both piped to the caller. For a server that speaks over stdio.
    Piped,
}

/// The environment a child starts with. It is always built explicitly here,
/// never left to chance.
#[derive(Debug, Clone, Default)]
pub struct EnvSpec {
    /// Start from the app's own environment. On macOS an app launched from
    /// Finder has almost nothing in it, so this must not be relied on for
    /// credentials.
    pub inherit: bool,
    /// Variables set on top. Values are never logged.
    pub vars: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct ChildSpec {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: EnvSpec,
    pub cwd: PathBuf,
    pub stdio: StdioMode,
}

/// How a child ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    /// True when the supervisor stopped the child on request.
    pub requested: bool,
}

pub struct Supervisor {
    #[cfg(windows)]
    job: super::job::Job,
}

impl Supervisor {
    pub fn new() -> Result<Self, SupervisorError> {
        Ok(Self {
            #[cfg(windows)]
            job: super::job::Job::new().map_err(SupervisorError::Setup)?,
        })
    }

    /// Starts a child and ties its life to the app. Must be called from
    /// within the tokio runtime.
    pub fn spawn(&self, spec: &ChildSpec) -> Result<ManagedChild, SupervisorError> {
        let program = spec.program.display().to_string();
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .current_dir(&spec.cwd)
            .stderr(Stdio::piped())
            // Covers the case where the runtime drops the monitor task.
            .kill_on_drop(true);
        match spec.stdio {
            StdioMode::Detached => {
                cmd.stdin(Stdio::null()).stdout(Stdio::null());
            }
            StdioMode::Piped => {
                cmd.stdin(Stdio::piped()).stdout(Stdio::piped());
            }
        }
        if !spec.env.inherit {
            cmd.env_clear();
        }
        cmd.envs(spec.env.vars.iter().map(|(k, v)| (k, v)));
        super::hide_console_window(&mut cmd);
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd.spawn().map_err(|source| SupervisorError::Spawn {
            program: program.clone(),
            source,
        })?;

        #[cfg(windows)]
        if let Some(handle) = child.raw_handle()
            && let Err(source) = self.job.assign(handle)
        {
            let _ = child.start_kill();
            return Err(SupervisorError::Tie { program, source });
        }

        #[cfg(unix)]
        let watchdog = match child.id().map(super::watchdog::Watchdog::spawn) {
            Some(Ok(watchdog)) => Some(watchdog),
            Some(Err(source)) => {
                let _ = child.start_kill();
                return Err(SupervisorError::Tie { program, source });
            }
            // The child has already exited. There is nothing to watch.
            None => None,
        };

        let pid = child.id();
        let stderr = LogBuffer::default();
        if let Some(pipe) = child.stderr.take() {
            let sink = stderr.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(pipe).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    sink.push(&line);
                }
            });
        }
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();

        let (exit_tx, exit_rx) = watch::channel(None);
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let info = tokio::select! {
                status = child.wait() => ExitInfo {
                    code: status.ok().and_then(|s| s.code()),
                    requested: false,
                },
                // Resolves on an explicit stop and also when the owner drops
                // the handle. Either way the child must go.
                _ = stop_rx => {
                    let _ = child.kill().await;
                    ExitInfo { code: None, requested: true }
                }
            };
            #[cfg(unix)]
            if let Some(watchdog) = watchdog {
                watchdog.disarm().await;
            }
            let _ = exit_tx.send(Some(info));
        });

        Ok(ManagedChild {
            pid,
            stderr,
            stdin,
            stdout,
            exit: exit_rx,
            stop: Some(stop_tx),
        })
    }
}

/// A running child. Dropping it stops the child.
pub struct ManagedChild {
    pub pid: Option<u32>,
    pub stderr: LogBuffer,
    /// Present for `StdioMode::Piped` until the caller takes it.
    pub stdin: Option<ChildStdin>,
    /// Present for `StdioMode::Piped` until the caller takes it.
    pub stdout: Option<ChildStdout>,
    exit: watch::Receiver<Option<ExitInfo>>,
    stop: Option<oneshot::Sender<()>>,
}

impl ManagedChild {
    /// How the child ended, if it has.
    pub fn exit_info(&self) -> Option<ExitInfo> {
        self.exit.borrow().clone()
    }

    /// A receiver that changes when the child exits.
    pub fn exit_watch(&self) -> watch::Receiver<Option<ExitInfo>> {
        self.exit.clone()
    }

    /// Stops the child and waits for it to be gone.
    pub async fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        let mut exit = self.exit.clone();
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            while exit.borrow().is_none() {
                if exit.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    fn spec(program: &str, args: &[&str]) -> ChildSpec {
        ChildSpec {
            program: PathBuf::from(program),
            args: args.iter().map(OsString::from).collect(),
            env: EnvSpec {
                inherit: true,
                vars: Vec::new(),
            },
            cwd: std::env::temp_dir(),
            stdio: StdioMode::Detached,
        }
    }

    fn sleeper() -> ChildSpec {
        if cfg!(windows) {
            spec("ping", &["-n", "60", "127.0.0.1"])
        } else {
            spec("/bin/sleep", &["60"])
        }
    }

    fn shell(script: &str) -> ChildSpec {
        if cfg!(windows) {
            spec("cmd", &["/C", script])
        } else {
            spec("/bin/sh", &["-c", script])
        }
    }

    fn pid_alive(pid: u32) -> bool {
        if cfg!(windows) {
            let out = std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
        } else {
            std::process::Command::new("/bin/kill")
                .args(["-0", &pid.to_string()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        }
    }

    async fn gone_within(pid: u32, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if !pid_alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        false
    }

    #[tokio::test]
    async fn stop_ends_the_child() {
        let supervisor = Supervisor::new().unwrap();
        let mut child = supervisor.spawn(&sleeper()).unwrap();
        let pid = child.pid.unwrap();
        assert!(pid_alive(pid));

        child.stop().await;

        assert_eq!(
            child.exit_info(),
            Some(ExitInfo {
                code: None,
                requested: true
            })
        );
        assert!(gone_within(pid, Duration::from_secs(5)).await);
    }

    #[tokio::test]
    async fn dropping_the_handle_ends_the_child() {
        let supervisor = Supervisor::new().unwrap();
        let child = supervisor.spawn(&sleeper()).unwrap();
        let pid = child.pid.unwrap();
        drop(child);
        assert!(gone_within(pid, Duration::from_secs(5)).await);
    }

    #[tokio::test]
    async fn an_unexpected_exit_is_reported_with_its_code() {
        let supervisor = Supervisor::new().unwrap();
        let child = supervisor.spawn(&shell("exit 3")).unwrap();
        let mut exit = child.exit_watch();
        tokio::time::timeout(Duration::from_secs(10), async {
            while exit.borrow().is_none() {
                exit.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        assert_eq!(
            child.exit_info(),
            Some(ExitInfo {
                code: Some(3),
                requested: false
            })
        );
    }

    #[tokio::test]
    async fn stderr_is_captured() {
        let supervisor = Supervisor::new().unwrap();
        let child = supervisor
            .spawn(&shell("echo engine-said-this 1>&2"))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let lines = child.stderr.tail(10);
            if lines.iter().any(|l| l.contains("engine-said-this")) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "stderr line not captured: {lines:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn explicit_environment_does_not_leak_the_parent_environment() {
        let supervisor = Supervisor::new().unwrap();
        // A variable the parent certainly has, and the child must not see.
        let (parent_var, script) = if cfg!(windows) {
            (
                "USERNAME",
                "echo marker [%USERNAME%] [%WB_TEST_EXTRA%] 1>&2",
            )
        } else {
            ("HOME", "echo marker [$HOME] [$WB_TEST_EXTRA] 1>&2")
        };
        let Ok(parent_value) = std::env::var(parent_var) else {
            return;
        };
        let mut spec = shell(script);
        spec.env = EnvSpec {
            inherit: false,
            vars: vec![
                ("WB_TEST_EXTRA".to_string(), "set".to_string()),
                // cmd.exe does not start without this.
                (
                    "SystemRoot".to_string(),
                    std::env::var("SystemRoot").unwrap_or_default(),
                ),
            ],
        };
        let child = supervisor.spawn(&spec).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let lines = child.stderr.tail(10);
            if let Some(line) = lines.iter().find(|l| l.contains("marker")) {
                assert!(line.contains("[set]"), "explicit variable missing: {line}");
                assert!(
                    !line.contains(&format!("[{parent_value}]")),
                    "parent environment leaked into the child"
                );
                break;
            }
            assert!(Instant::now() < deadline, "no output: {lines:?}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn a_missing_program_is_a_spawn_error() {
        let supervisor = Supervisor::new().unwrap();
        let err = supervisor
            .spawn(&spec("definitely-not-a-real-program-xyz", &[]))
            .err()
            .unwrap();
        assert!(matches!(err, SupervisorError::Spawn { .. }));
    }

    /// Not a test in its own right. When the variable is set, this process
    /// plays the app: it supervises a child, prints the child's pid, and then
    /// waits to be killed.
    #[tokio::test]
    async fn helper_app_that_waits_to_be_killed() {
        if std::env::var_os("WB_SUPERVISOR_HELPER").is_none() {
            return;
        }
        let supervisor = Supervisor::new().unwrap();
        let child = supervisor.spawn(&sleeper()).unwrap();
        println!("CHILD_PID={}", child.pid.unwrap());
        tokio::time::sleep(Duration::from_secs(120)).await;
    }

    /// The force-quit guarantee, end to end: start a stand-in for the app,
    /// kill it without giving it a chance to clean up, and check that the
    /// child it supervised is gone.
    #[tokio::test]
    async fn killing_the_app_kills_its_children() {
        use tokio::io::AsyncBufReadExt;

        let mut app = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "engine::supervisor::tests::helper_app_that_waits_to_be_killed",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("WB_SUPERVISOR_HELPER", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // If an assertion below fails, do not leave the helper behind.
            .kill_on_drop(true)
            .spawn()
            .unwrap();

        let stdout = app.stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();
        let child_pid: u32 = tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let line = lines
                    .next_line()
                    .await
                    .unwrap()
                    .expect("helper exited early");
                // The test harness prints the test name on the same line first.
                if let Some((_, pid)) = line.split_once("CHILD_PID=") {
                    return pid.trim().parse().unwrap();
                }
            }
        })
        .await
        .expect("helper did not report a child pid");
        assert!(pid_alive(child_pid), "supervised child should be running");

        // TerminateProcess on Windows, SIGKILL on Unix. No cleanup code runs.
        app.kill().await.unwrap();

        assert!(
            gone_within(child_pid, Duration::from_secs(10)).await,
            "supervised child {child_pid} outlived the app"
        );
    }
}
