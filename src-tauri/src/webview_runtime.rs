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
//!
//! Where no runtime can be found there is no window to say so in. The app
//! checks before it starts anything, and says it in a dialog of the system's
//! own, with the address of Microsoft's page for the runtime. The installers
//! are left out of it: they neither ship the runtime nor install it.

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

/// Microsoft's page for the runtime, where it is downloaded from. It is the
/// one address the dialog below opens, and it is held here: what the dialog
/// passes back on a click is not used.
pub const DOWNLOAD_PAGE: &str = "https://developer.microsoft.com/en-us/microsoft-edge/webview2/";

/// The line the dialog leads with when no runtime can be found.
pub const NOTICE_HEADING: &str = "StackQL Workbench requires the Microsoft Edge WebView2 Runtime";

/// What follows the heading, as plain text with the address spelled out.
///
/// It is this one sentence and no more. The maintainer asked for that: the
/// operator needs to know what is missing and where to get it, not what the
/// runtime is for or where it was looked for.
pub fn notice_body() -> String {
    format!("See {DOWNLOAD_PAGE} for installation instructions.")
}

/// The body with the address marked as a link, in the form a task dialog
/// reads.
pub fn notice_markup() -> String {
    let link = format!("<A HREF=\"{DOWNLOAD_PAGE}\">{DOWNLOAD_PAGE}</A>");
    notice_body().replacen(DOWNLOAD_PAGE, &link, 1)
}

/// Stops the app, with a dialog that says why, when no page renderer can be
/// found. Does nothing where one is found, and on every platform but
/// Windows, where the renderer is part of the system.
///
/// Call it after [`use_bundled`] and before anything else is started. The
/// question asked is the one Tauri asks before it makes a window, so this
/// never stops an app that would have run. Without it the app would end in
/// a panic, behind a dialog of Tauri's that names no app.
///
/// The notice is the same whatever the reason no runtime could be used, a
/// folder beside the app that holds a broken one included.
pub fn require() {
    #[cfg(windows)]
    if tauri::webview_version().is_err() {
        dialog::show();
        std::process::exit(1);
    }
}

/// The dialog, drawn by Windows. No part of the app is running yet.
#[cfg(windows)]
mod dialog {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows_sys::Win32::UI::Controls::{
        TASKDIALOGCONFIG, TASKDIALOGCONFIG_0, TD_INFORMATION_ICON, TDCBF_CLOSE_BUTTON,
        TDF_ALLOW_DIALOG_CANCELLATION, TDF_ENABLE_HYPERLINKS, TDN_HYPERLINK_CLICKED,
        TaskDialogIndirect,
    };
    use windows_sys::core::HRESULT;

    use super::{DOWNLOAD_PAGE, NOTICE_HEADING, notice_body, notice_markup};

    const TITLE: &str = "StackQL Workbench";

    /// The width of the dialog, in the units Windows lays dialogs out in,
    /// which grow with the size of the system's text.
    const WIDTH: u32 = 360;

    /// Text as Windows takes it: UTF-16 with a zero at the end.
    fn wide(text: &str) -> Vec<u16> {
        OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Told by the dialog what happens in it. A click on the link opens the
    /// download page in the operator's browser. The address opened is the
    /// one this module holds, whatever the dialog passes.
    extern "system" fn on_event(
        _window: HWND,
        event: u32,
        _wparam: WPARAM,
        _lparam: LPARAM,
        _data: isize,
    ) -> HRESULT {
        if i32::try_from(event) == Ok(TDN_HYPERLINK_CLICKED) {
            // Nothing can be said if this fails: the address is in the text.
            let _ = tauri_plugin_opener::open_url(DOWNLOAD_PAGE, None::<&str>);
        }
        0
    }

    /// Shows the notice and returns when the operator closes it.
    pub fn show() {
        let title = wide(TITLE);
        let heading = wide(NOTICE_HEADING);
        let content = wide(&notice_markup());
        let config = TASKDIALOGCONFIG {
            cbSize: u32::try_from(size_of::<TASKDIALOGCONFIG>()).unwrap_or(0),
            dwFlags: TDF_ENABLE_HYPERLINKS | TDF_ALLOW_DIALOG_CANCELLATION,
            // Wide enough for the sentence to sit on one line. At the usual
            // width the address is broken in two.
            cxWidth: WIDTH,
            dwCommonButtons: TDCBF_CLOSE_BUTTON,
            pszWindowTitle: title.as_ptr(),
            Anonymous1: TASKDIALOGCONFIG_0 {
                pszMainIcon: TD_INFORMATION_ICON,
            },
            pszMainInstruction: heading.as_ptr(),
            pszContent: content.as_ptr(),
            pfCallback: Some(on_event),
            ..Default::default()
        };
        // SAFETY: `config` is a live struct of the size it states. Every
        // pointer in it is to a zero-ended buffer that outlives the call, or
        // is one of the system's own icon ids. The three places for results
        // may be null, which asks for none. The call returns only when the
        // dialog has closed, so the callback is not called after it.
        let outcome = unsafe {
            TaskDialogIndirect(&config, ptr::null_mut(), ptr::null_mut(), ptr::null_mut())
        };
        if outcome < 0 {
            // No dialog could be shown. A console, if there is one, is the
            // only place left to say it.
            eprintln!("{NOTICE_HEADING}\n{}", notice_body());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_notice_says_what_is_needed_and_where_to_get_it() {
        assert_eq!(
            NOTICE_HEADING,
            "StackQL Workbench requires the Microsoft Edge WebView2 Runtime"
        );
        assert_eq!(
            notice_body(),
            "See https://developer.microsoft.com/en-us/microsoft-edge/webview2/ \
             for installation instructions."
        );
    }

    #[test]
    fn the_notice_is_one_short_sentence_of_plain_text() {
        // It says what is missing and where to get it. What the runtime is
        // for, and where it was looked for, are left out on purpose.
        let body = notice_body();
        assert!(body.len() < 110, "{}", body.len());
        assert!(!body.contains('\n'));
        assert_eq!(body.matches(". ").count(), 0);
        assert!(body.is_ascii());
        assert!(NOTICE_HEADING.is_ascii());
        assert!(!body.contains('<'));
    }

    #[test]
    fn the_address_is_microsofts_and_is_given_once() {
        assert!(DOWNLOAD_PAGE.starts_with("https://developer.microsoft.com/"));
        assert_eq!(notice_body().matches(DOWNLOAD_PAGE).count(), 1);
        assert_eq!(notice_body().matches("https://").count(), 1);
    }

    #[test]
    fn the_link_in_the_dialog_is_the_address_in_the_text() {
        let markup = notice_markup();
        assert_eq!(
            markup,
            format!(
                "See <A HREF=\"{DOWNLOAD_PAGE}\">{DOWNLOAD_PAGE}</A> for installation \
                 instructions."
            )
        );
        assert_eq!(markup.matches("<A HREF=").count(), 1);
        assert_eq!(markup.matches("</A>").count(), 1);
    }

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
