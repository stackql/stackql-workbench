//! Typed IPC: the commands the webview can call and the events it can hear.
//!
//! This is the whole surface between the webview and the host. The webview
//! side is `src/host/`, the only place in the webview that touches Tauri.

use std::collections::HashMap;
use std::sync::Arc;

use tauri::State;
use tauri::ipc::Channel;

use crate::config::{Settings, SettingsStore};
use crate::connection::{Connection, EngineStatus, EventSink};
use crate::error::{HostError, HostResult};
use crate::icons::{ProviderIcon, ProviderIcons};
use crate::query::explorer::{self, Field, Method, MethodField, Provider, Resource, Service};
use crate::query::result::{QueryEvent, RunSummary};

/// Emitted whenever the engine status changes. The payload is `EngineStatus`.
pub const ENGINE_STATUS_EVENT: &str = "engine-status";

pub struct AppState {
    pub connection: Arc<dyn Connection>,
    pub settings: Arc<SettingsStore>,
    pub icons: Arc<ProviderIcons>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub settings: Settings,
    /// Set when the settings file could not be read at startup.
    pub warning: Option<String>,
}

#[tauri::command]
pub async fn engine_status(state: State<'_, AppState>) -> HostResult<EngineStatus> {
    Ok(state.connection.status())
}

#[tauri::command]
pub async fn engine_restart(state: State<'_, AppState>) -> HostResult<EngineStatus> {
    Ok(state.connection.restart().await)
}

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> HostResult<SettingsView> {
    Ok(SettingsView {
        settings: state.settings.get(),
        warning: state.settings.load_warning().map(str::to_string),
    })
}

/// Saves settings. If a setting the engine depends on changed, the engine is
/// restarted so the change takes effect.
#[tauri::command]
pub async fn settings_save(state: State<'_, AppState>, settings: Settings) -> HostResult<Settings> {
    let before = state.settings.get();
    let saved = state.settings.replace(settings)?;
    if before.engine_path != saved.engine_path || before.env_file != saved.env_file {
        state.connection.restart().await;
    }
    Ok(saved)
}

/// Runs the statements in `sql` on the operator's session. Events stream
/// over `on_event` while the command is pending. The command resolves when
/// the run ends.
#[tauri::command]
pub async fn query_run(
    state: State<'_, AppState>,
    run_id: String,
    sql: String,
    on_event: Channel<QueryEvent>,
) -> HostResult<RunSummary> {
    let sink: EventSink = Box::new(move |event| {
        // A send only fails when the webview has gone away.
        let _ = on_event.send(event);
    });
    state.connection.run(run_id, sql, sink).await
}

/// Stops waiting for a run. The engine has no cancel, so the statement may
/// still complete there.
#[tauri::command]
pub async fn query_abandon(state: State<'_, AppState>, run_id: String) -> HostResult<bool> {
    Ok(state.connection.abandon(&run_id))
}

/// Puts text on the system clipboard. Write only: the webview cannot read
/// the clipboard through the host.
///
/// Not async, so it runs on the main thread, which is where macOS expects
/// pasteboard access.
#[tauri::command]
pub fn clipboard_write_text(text: String) -> HostResult<()> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|err| HostError::Internal(format!("Could not open the clipboard: {err}")))?;
    clipboard
        .set_text(text)
        .map_err(|err| HostError::Internal(format!("Could not copy to the clipboard: {err}")))
}

/// Icons for the named providers, as `data:` URLs. Providers without an icon
/// are left out, and the explorer shows its letter badge for them.
#[tauri::command]
pub async fn provider_icons(
    state: State<'_, AppState>,
    providers: Vec<String>,
) -> HostResult<HashMap<String, ProviderIcon>> {
    Ok(state.icons.icons(&providers).await)
}

#[tauri::command]
pub async fn explorer_providers(state: State<'_, AppState>) -> HostResult<Vec<Provider>> {
    let result = state
        .connection
        .fetch(explorer::PROVIDERS_SQL.to_string())
        .await?;
    explorer::map_providers(&result)
}

#[tauri::command]
pub async fn explorer_services(
    state: State<'_, AppState>,
    provider: String,
) -> HostResult<Vec<Service>> {
    let sql = explorer::services_sql(&provider)?;
    explorer::map_services(&state.connection.fetch(sql).await?)
}

#[tauri::command]
pub async fn explorer_resources(
    state: State<'_, AppState>,
    provider: String,
    service: String,
) -> HostResult<Vec<Resource>> {
    let sql = explorer::resources_sql(&provider, &service)?;
    explorer::map_resources(&state.connection.fetch(sql).await?)
}

#[tauri::command]
pub async fn explorer_methods(
    state: State<'_, AppState>,
    provider: String,
    service: String,
    resource: String,
) -> HostResult<Vec<Method>> {
    let sql = explorer::methods_sql(&provider, &service, &resource)?;
    explorer::map_methods(&state.connection.fetch(sql).await?)
}

#[tauri::command]
pub async fn explorer_fields(
    state: State<'_, AppState>,
    provider: String,
    service: String,
    resource: String,
) -> HostResult<Vec<Field>> {
    let sql = explorer::fields_sql(&provider, &service, &resource)?;
    explorer::map_fields(&state.connection.fetch(sql).await?)
}

#[tauri::command]
pub async fn explorer_method_fields(
    state: State<'_, AppState>,
    provider: String,
    service: String,
    resource: String,
    method: String,
) -> HostResult<Vec<MethodField>> {
    let sql = explorer::method_fields_sql(&provider, &service, &resource, &method)?;
    explorer::map_method_fields(&state.connection.fetch(sql).await?)
}
