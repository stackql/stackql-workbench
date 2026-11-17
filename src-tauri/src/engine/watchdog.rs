//! Unix watchdog that kills a child's process group when the app dies.
//!
//! A process group alone is not enough on macOS: when the app receives
//! SIGKILL, nothing signals its children, and macOS has no parent-death
//! signal to ask for. So each supervised child gets a small watchdog process.
//!
//! The watchdog is `/bin/sh` reading from a pipe. The app holds the only
//! write end. While the app lives, the read blocks. When the app exits for
//! any reason, the kernel closes the write end, the read sees end of file,
//! and the watchdog signals the child's process group: SIGTERM first, then
//! SIGKILL two seconds later.
//!
//! Standard pipes are created close-on-exec, so no other child inherits the
//! write end and keeps the pipe open by accident.
//!
//! The watchdog runs in its own process group so that a terminal interrupt
//! aimed at the app's group does not take it out before it has done its job.
//!
//! Residual risk: if the child has already exited and the OS has reused its
//! process group id by the time the watchdog fires, the signal would go to
//! an unrelated group. The supervisor avoids this in the normal case by
//! stopping the watchdog itself before it lets go of a child.

use std::io;
use std::process::Stdio;

use tokio::process::{Child, ChildStdin, Command};

// `kill -s NAME -- -PGID` is the POSIX spelling. The shorter `kill -TERM --
// -PGID` is rejected by dash, which is /bin/sh on many Linux systems, so the
// form matters even though macOS ships a different shell.
const SCRIPT: &str = r#"cat >/dev/null 2>&1
kill -s TERM -- "-$0" 2>/dev/null
sleep 2
kill -s KILL -- "-$0" 2>/dev/null
exit 0"#;

pub struct Watchdog {
    process: Child,
    /// Held open for the life of the app. Closing it fires the watchdog.
    lifeline: Option<ChildStdin>,
}

impl Watchdog {
    /// Starts a watchdog for the process group `pgid`.
    pub fn spawn(pgid: u32) -> io::Result<Self> {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(SCRIPT)
            .arg(pgid.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(false);
        let mut process = cmd.spawn()?;
        let lifeline = process.stdin.take();
        if lifeline.is_none() {
            return Err(io::Error::other("watchdog has no stdin pipe"));
        }
        Ok(Self { process, lifeline })
    }

    /// Stops the watchdog without firing it. Call this after the supervised
    /// child has been stopped in the normal way.
    pub async fn disarm(mut self) {
        // Kill first, then drop the pipe, so the script never reaches `kill`.
        let _ = self.process.kill().await;
        self.lifeline.take();
    }

    /// Closes the pipe, which is what the kernel does when the app dies.
    #[cfg(test)]
    pub fn fire(&mut self) {
        self.lifeline.take();
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;

    async fn exited_within(child: &mut Child, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    fn sleeper() -> Child {
        Command::new("/bin/sleep")
            .arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap()
    }

    #[tokio::test]
    async fn closing_the_lifeline_kills_the_process_group() {
        let mut child = sleeper();
        let pgid = child.id().unwrap();
        let mut watchdog = Watchdog::spawn(pgid).unwrap();
        assert!(child.try_wait().unwrap().is_none());

        watchdog.fire();

        assert!(
            exited_within(&mut child, Duration::from_secs(5)).await,
            "child should die when the lifeline closes"
        );
    }

    #[tokio::test]
    async fn disarming_leaves_the_process_group_alone() {
        let mut child = sleeper();
        let pgid = child.id().unwrap();
        let watchdog = Watchdog::spawn(pgid).unwrap();

        watchdog.disarm().await;

        assert!(!exited_within(&mut child, Duration::from_millis(500)).await);
        child.kill().await.unwrap();
    }
}
