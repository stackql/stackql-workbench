//! StackQL Workbench host.
//!
//! The host owns every process, connection and secret. The webview reaches it
//! only through the typed IPC commands and events defined in [`ipc`].

pub mod activity;
pub mod agent;
pub mod applog;
pub mod config;
pub mod connection;
pub mod engine;
pub mod error;
pub mod icons;
pub mod ipc;
pub mod library;
pub mod query;
pub mod secrets;
pub mod util;
pub mod webview_runtime;

use std::sync::Arc;

use tauri::{Emitter, Manager, RunEvent};

use crate::activity::History;
use crate::agent::runtime::AgentRuntime;
use crate::applog::AppLog;
use crate::config::SettingsStore;
use crate::connection::local::LocalConnection;
use crate::connection::{Connection, EngineState, EngineStatus};
use crate::engine::approot::Defaults as ApprootDefaults;
use crate::icons::ProviderIcons;
use crate::ipc::AppState;
use crate::library::Library;
use crate::secrets::{KeychainStore, MemoryStore, SecretStore};

fn setup(
    app: &tauri::App,
    bundled_webview: Option<&std::path::Path>,
) -> Result<(), Box<dyn std::error::Error>> {
    let config_dir = app.path().app_config_dir()?;
    let data_dir = app.path().app_data_dir()?;
    let cache_dir = app.path().app_cache_dir()?;

    let settings = Arc::new(SettingsStore::load(config_dir.join("settings.json")));
    // The engine's provider cache. An installed app sits where an ordinary
    // account cannot write, so it uses `.stackql` in the home folder, the
    // one the stackql command uses. A build from this repository keeps a
    // folder beside its executable. The last resort is a folder under the
    // local app data directory: it is a cache, so it does not belong in the
    // directory that follows a user between machines. The operator can name
    // another folder in settings. The engine's own default would be
    // whatever directory the app was started from.
    let approot_defaults = ApprootDefaults::for_executable(
        std::env::current_exe().ok().as_deref(),
        app.path().home_dir().ok().as_deref(),
        app.path().app_local_data_dir()?.join("engine"),
        |path| path.is_file(),
    );
    let connection: Arc<dyn Connection> = Arc::new(LocalConnection::new(
        approot_defaults,
        data_dir.join("audit"),
        settings.clone(),
    )?);

    // The app's own log, one file for each run. It is apart from the
    // engine's audit log, which the engine writes.
    let log = Arc::new(AppLog::start(&data_dir.join("logs")));
    // On Windows the page renderer is either the one shipped beside the app
    // or the system's. Which one is worth having on record.
    if cfg!(windows) {
        log.info(
            "webview_runtime",
            serde_json::json!({
                "source": if bundled_webview.is_some() { "beside the app" } else { "system" },
                "folder": bundled_webview.map(|folder| folder.display().to_string()),
            }),
        );
    }

    // Forward every status change to the webview, and note in the log when
    // the engine comes up or fails to.
    let handle = app.handle().clone();
    let mut status = connection.watch_status();
    let status_log = log.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_state = None;
        loop {
            let current = status.borrow_and_update().clone();
            if last_state != Some(current.state) {
                last_state = Some(current.state);
                log_engine_state(&status_log, &current);
            }
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
        agent: Arc::new(
            AgentRuntime::new(connection.clone())
                .with_delegate_dir(data_dir.join("agents").join("copilot")),
        ),
        connection,
        settings,
        icons: Arc::new(ProviderIcons::new(cache_dir.join("provider-icons"))),
        library: Arc::new(Library::new(cache_dir.join("query-library"))),
        secrets,
        keychain_available,
        history: Arc::new(History::new(data_dir.join("history.jsonl"))),
        log,
    });
    Ok(())
}

/// Writes a change of the engine's state to the app's log. A failure goes
/// in with its reason and the engine's last lines, which the banner also
/// shows. The environment the engine was given is never part of a status.
fn log_engine_state(log: &AppLog, status: &EngineStatus) {
    match status.state {
        EngineState::Running => log.info(
            "engine_running",
            serde_json::json!({
                "location": status.location,
                "foundVia": status.location_source,
                "version": status.version,
                "endpoint": status.endpoint,
                "dataFolder": status.data_folder,
                "dataFolderFrom": status.data_folder_source,
            }),
        ),
        EngineState::Failed => log.error(
            "engine_failed",
            serde_json::json!({
                "location": status.location,
                "error": status.error,
                "logTail": status.log_tail,
            }),
        ),
        EngineState::Stopped | EngineState::Starting => {}
    }
}

/// Starts the app. Does not return until the app exits.
pub fn run() {
    // First, before anything can start a thread: use the page renderer that
    // was shipped beside the app, when there is one.
    let bundled_webview = webview_runtime::use_bundled();
    // Then, before anything is started: without a page renderer there is no
    // window to say anything in, so say it in a dialog of the system's and
    // stop. This returns at once where a renderer is found.
    webview_runtime::require();

    let built = tauri::Builder::default()
        // The save dialog, used from the host only. The webview has no access to it.
        .plugin(tauri_plugin_dialog::init())
        // Opens the Help menu's links in the browser, from the host only.
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| setup(app, bundled_webview.as_deref()))
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
            ipc::explorer_registry,
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
            ipc::agent_delegate_info,
            ipc::activity_list,
            ipc::save::save_text_file,
            ipc::links::open_link,
            ipc::links::reveal_log,
            ipc::library_index,
            ipc::library_document,
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
