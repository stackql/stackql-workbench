//! StackQL Workbench host.
//!
//! The host owns every process, connection and secret. The webview reaches it
//! only through the typed IPC commands and events defined in [`ipc`].

pub mod activity;
pub mod agent;
pub mod config;
pub mod connection;
pub mod engine;
pub mod error;
pub mod icons;
pub mod ipc;
pub mod query;
pub mod secrets;
pub mod util;

use std::sync::Arc;

use tauri::{Emitter, Manager, RunEvent};

use crate::activity::History;
use crate::agent::runtime::AgentRuntime;
use crate::config::SettingsStore;
use crate::connection::Connection;
use crate::connection::local::LocalConnection;
use crate::engine::approot::Defaults as ApprootDefaults;
use crate::icons::ProviderIcons;
use crate::ipc::AppState;
use crate::secrets::{KeychainStore, MemoryStore, SecretStore};

fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let config_dir = app.path().app_config_dir()?;
    let data_dir = app.path().app_data_dir()?;
    let cache_dir = app.path().app_cache_dir()?;

    let settings = Arc::new(SettingsStore::load(config_dir.join("settings.json")));
    // The engine's provider cache goes in a folder beside this executable,
    // or under the app data directory when that place cannot be written to.
    // The operator can name another folder in settings. The engine's own
    // default would be whatever directory the app was started from.
    let approot_defaults = ApprootDefaults::for_executable(
        std::env::current_exe().ok().as_deref(),
        data_dir.join("engine"),
    );
    let connection: Arc<dyn Connection> = Arc::new(LocalConnection::new(
        approot_defaults,
        data_dir.join("audit"),
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

    // API keys live in the OS keychain. If it cannot be opened, keys are
    // held in memory for this run and the settings pane says so.
    let (secrets, keychain_available): (Arc<dyn SecretStore>, bool) = match KeychainStore::open() {
        Ok(store) => (Arc::new(store), true),
        Err(_) => (Arc::new(MemoryStore::default()), false),
    };

    app.manage(AppState {
        agent: Arc::new(AgentRuntime::new(connection.clone())),
        connection,
        settings,
        icons: Arc::new(ProviderIcons::new(cache_dir.join("provider-icons"))),
        secrets,
        keychain_available,
        history: Arc::new(History::new(data_dir.join("history.jsonl"))),
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
            ipc::clipboard_write_text,
            ipc::provider_icons,
            ipc::explorer_providers,
            ipc::explorer_services,
            ipc::explorer_resources,
            ipc::explorer_methods,
            ipc::explorer_fields,
            ipc::explorer_method_fields,
            ipc::agent_config_get,
            ipc::agent_config_save,
            ipc::agent_config_clear,
            ipc::agent_set_safety_mode,
            ipc::agent_send,
            ipc::agent_approve,
            ipc::agent_stop,
            ipc::agent_reset,
            ipc::activity_list,
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
