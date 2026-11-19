//! Engine discovery and process lifecycle.
//!
//! Nothing outside `connection::local` should need this module: code above
//! the `Connection` trait must not assume the engine is a child process.

pub mod approot;
pub mod discovery;
pub mod logbuf;
pub mod port;
pub mod supervisor;

#[cfg(windows)]
mod job;
#[cfg(unix)]
mod watchdog;

/// Whether a file is inside a macOS app bundle: one of the folders it sits in
/// is named `<something>.app`. An app that an installer put down runs from a
/// bundle. A build from this repository does not.
pub fn in_app_bundle(file: &std::path::Path) -> bool {
    file.ancestors()
        .skip(1)
        .any(|part| part.extension().is_some_and(|ext| ext == "app"))
}

/// Stops Windows from opening a console window for a console program started
/// by a GUI app. Does nothing on other platforms.
pub fn hide_console_window(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}
