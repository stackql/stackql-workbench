//! StackQL Workbench host.
//!
//! The host owns every process, connection and secret. The webview reaches it
//! only through the typed IPC commands and events defined in [`ipc`].

pub mod config;
pub mod connection;
pub mod engine;
pub mod error;
pub mod ipc;
pub mod query;
pub mod util;

use std::sync::Arc;

use tauri::{Emitter, Manager, RunEvent};

use crate::config::SettingsStore;
use crate::connection::Connection;
use crate::connection::local::LocalConnection;
use crate::ipc::AppState;

fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let config_dir = app.path().app_config_dir()?;
    let data_dir = app.path().app_data_dir()?;

    let settings = Arc::new(SettingsStore::load(config_dir.join("settings.json")));
    // The engine's provider cache lives under the app data directory. Its
    // default would be whatever directory the app was started from.
    let connection: Arc<dyn Connection> = Arc::new(LocalConnection::new(
        data_dir.join("engine"),
        settings.clone(),
    )?);

    // Forward every status change to the webview.
    let handle = app.handle().clone();
    let mut status = connection.watch_status();
    tauri::async_runtime::spawn(async move {
        loop {
            let current = status.borrow_and_update().clone();
            let _ = handle.emit(ipc::ENGINE_STATUS_EVENT, current);
            if status.changed().await.is_err() {
                break;
            }
        }
    });

    // Bring the engine up without holding up the window.
    let starting = connection.clone();
    tauri::async_runtime::spawn(async move {
        starting.start().await;
    });

    app.manage(AppState {
        connection,
        settings,
    });
    Ok(())
}

/// Starts the app. Does not return until the app exits.
pub fn run() {
    let built = tauri::Builder::default()
        .setup(|app| setup(app))
        .invoke_handler(tauri::generate_handler![
            ipc::engine_status,
            ipc::engine_restart,
            ipc::settings_get,
            ipc::settings_save,
            ipc::query_run,
            ipc::query_abandon,
            ipc::explorer_providers,
            ipc::explorer_services,
            ipc::explorer_resources,
            ipc::explorer_methods,
            ipc::explorer_fields,
            ipc::explorer_method_fields,
        ])
        .build(tauri::generate_context!());

    let app = match built {
        Ok(app) => app,
        Err(err) => {
            eprintln!("stackql-workbench failed to start: {err}");
            std::process::exit(1);
        }
    };

    app.run(|handle, event| {
        // A clean exit stops the engine here. A crash or a force quit is
        // covered by the supervisor, which does not rely on this code running.
        if let RunEvent::Exit = event
            && let Some(state) = handle.try_state::<AppState>()
        {
            let connection = state.connection.clone();
            tauri::async_runtime::block_on(async move {
                connection.shutdown().await;
            });
        }
    });
}
