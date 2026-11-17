//! StackQL Workbench host.
//!
//! The host owns every process, connection and secret. The webview reaches it
//! only through the typed IPC commands and events defined in [`ipc`].

/// Starts the app. Does not return until the app exits.
pub fn run() {
    let result = tauri::Builder::default().run(tauri::generate_context!());
    if let Err(err) = result {
        eprintln!("stackql-workbench failed to start: {err}");
        std::process::exit(1);
    }
}
