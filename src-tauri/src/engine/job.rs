//! Windows job object that ties child processes to the life of the app.
//!
//! The job is created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The app holds
//! the only handle. When the app exits for any reason, including a crash or a
//! forced termination, the OS closes that handle and terminates every process
//! in the job. Nothing in the app has to run for that to happen.

use std::io;
use std::os::windows::io::RawHandle;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};

pub struct Job {
    handle: HANDLE,
}

// SAFETY: a job object handle is a kernel object reference. The kernel
// synchronises access to it, and this type only passes the handle to system
// calls, so it can be shared and sent across threads.
unsafe impl Send for Job {}
// SAFETY: as above.
unsafe impl Sync for Job {}

impl Job {
    /// Creates an anonymous job whose processes die when its last handle closes.
    pub fn new() -> io::Result<Self> {
        // SAFETY: both arguments may be null: default security attributes and
        // an unnamed job.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // Wrap the handle first so it is closed if the next call fails.
        let job = Self { handle };

        // SAFETY: the struct is plain data for which all-zero is a valid value.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
            .map_err(|_| io::Error::other("job limit information size does not fit in u32"))?;
        // SAFETY: `info` is a live, correctly sized struct of the type named
        // by the information class, and the handle is a valid job handle.
        let ok = unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                size,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    /// Puts a running process into the job. Processes it starts later join
    /// the job as well.
    pub fn assign(&self, process: RawHandle) -> io::Result<()> {
        // SAFETY: the job handle is valid for the life of `self`. The caller
        // passes a process handle obtained from a live child.
        let ok = unsafe { AssignProcessToJobObject(self.handle, process as HANDLE) };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: the handle was returned by CreateJobObjectW and is closed
        // exactly once, here.
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use super::*;

    fn long_running_child() -> std::process::Child {
        // `ping -n 60` runs for about a minute and needs no console input.
        Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    fn wait_for_exit(child: &mut std::process::Child, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if child.try_wait().unwrap().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn a_process_in_another_job_can_join_an_empty_job_but_not_a_used_one() {
        // The child starts out in a job of its own, as a packaged app does.
        let theirs = Job::new().unwrap();
        let mut child = long_running_child();
        theirs.assign(child.as_raw_handle()).unwrap();

        // A job that already has a member will not take it.
        let used = Job::new().unwrap();
        let mut member = long_running_child();
        used.assign(member.as_raw_handle()).unwrap();
        assert!(
            used.assign(child.as_raw_handle()).is_err(),
            "a used job took a process from another job"
        );

        // An empty one will, and closing it still kills the process.
        let empty = Job::new().unwrap();
        empty.assign(child.as_raw_handle()).unwrap();
        drop(empty);
        assert!(
            wait_for_exit(&mut child, Duration::from_secs(5)),
            "the process outlived the job it was put in"
        );

        drop(used);
        assert!(wait_for_exit(&mut member, Duration::from_secs(5)));
        drop(theirs);
    }

    #[test]
    fn closing_the_job_kills_its_processes() {
        let job = Job::new().unwrap();
        let mut child = long_running_child();
        job.assign(child.as_raw_handle()).unwrap();
        assert!(
            child.try_wait().unwrap().is_none(),
            "child should be running"
        );

        // Dropping the job closes the only handle, which is exactly what the
        // OS does when the app is terminated.
        drop(job);

        assert!(
            wait_for_exit(&mut child, Duration::from_secs(5)),
            "child should die when the job handle closes"
        );
    }

    #[test]
    fn a_process_outside_the_job_survives_it() {
        let job = Job::new().unwrap();
        let mut child = long_running_child();
        drop(job);
        assert!(!wait_for_exit(&mut child, Duration::from_millis(300)));
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
