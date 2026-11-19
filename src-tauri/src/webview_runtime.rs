//! The page renderer on Windows, and using one that ships with the app.
//!
//! The window is drawn by Microsoft's WebView2 runtime. It is not part of
//! the executable and cannot be: it is a browser engine of several hundred
//! megabytes. Windows 11 has it built in, and Windows 10 gets it with Edge,
//! but it is still something the system has to supply.
//!
//! An installer that wants the app to stand on its own puts Microsoft's
//! Fixed Version runtime in a folder beside the executable. When that folder
//! is there the app uses it and never looks at what the system has. When it
//! is not, the system's runtime is used, as before. Nothing is configured:
//! the folder being there is the whole switch.
//!
//! macOS has no such thing to ship. Its renderer is part of the system.

use std::path::{Path, PathBuf};

/// The folder beside the executable that holds a runtime shipped with the
/// app. Microsoft's own name for the folder carries a version and an
/// architecture, so an installer renames it to this.
pub const FOLDER_NAME: &str = "WebView2Runtime";

/// The program every WebView2 runtime folder has. Its presence is how a
/// folder is told from an empty or half-copied one.
const RUNTIME_PROGRAM: &str = "msedgewebview2.exe";

/// The variable the WebView2 loader reads for a runtime to use in place of
/// the installed one.
pub const FOLDER_VARIABLE: &str = "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER";

/// The runtime folder beside an executable, if there is a usable one.
/// `is_file` is injected so tests can describe a file system.
pub fn beside(exe: &Path, is_file: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let folder = exe.parent()?.join(FOLDER_NAME);
    is_file(&folder.join(RUNTIME_PROGRAM)).then_some(folder)
}

/// Points the webview at the runtime beside this executable, when there is
/// one, and returns its folder. Does nothing and returns `None` otherwise,
/// and on every platform but Windows.
///
/// This must be the first thing the program does: the loader reads the
/// variable when the first window is made, and a variable may only be set
/// while no other thread can be reading the environment.
///
/// A runtime beside the app is used even if the variable was already set.
/// What shipped with the app is what the app was tested with, which is the
/// same rule the engine follows.
pub fn use_bundled() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().ok()?;
        let folder = beside(&exe, |path| path.is_file())?;
        // SAFETY: called from `run` before anything else, so no other thread
        // exists yet that could read or write the environment.
        unsafe { std::env::set_var(FOLDER_VARIABLE, &folder) };
        Some(folder)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_runtime_beside_the_app_is_found() {
        let exe = Path::new("/apps/StackQL/stackql-workbench.exe");
        let program = Path::new("/apps/StackQL")
            .join(FOLDER_NAME)
            .join(RUNTIME_PROGRAM);
        let found = beside(exe, |path| path == program);
        assert_eq!(found, Some(Path::new("/apps/StackQL").join(FOLDER_NAME)));
    }

    #[test]
    fn no_folder_means_the_system_runtime() {
        let exe = Path::new("/apps/StackQL/stackql-workbench.exe");
        assert_eq!(beside(exe, |_| false), None);
    }

    #[test]
    fn a_folder_without_the_runtime_program_is_not_a_runtime() {
        // An empty folder, or one a copy did not finish, must not be handed
        // to the loader: it would fail where the system's runtime works.
        let exe = Path::new("/apps/StackQL/stackql-workbench.exe");
        let stray = Path::new("/apps/StackQL")
            .join(FOLDER_NAME)
            .join("readme.txt");
        assert_eq!(beside(exe, |path| path == stray), None);
    }

    #[test]
    fn a_runtime_somewhere_else_is_not_this_apps() {
        let exe = Path::new("/apps/StackQL/stackql-workbench.exe");
        let elsewhere = Path::new("/apps/Other")
            .join(FOLDER_NAME)
            .join(RUNTIME_PROGRAM);
        assert_eq!(beside(exe, |path| path == elsewhere), None);
    }
}
