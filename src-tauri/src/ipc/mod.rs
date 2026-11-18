//! Typed IPC: the commands the webview can call and the events it can hear.
//!
//! This is the whole surface between the webview and the host. The webview
//! side is `src/host/`, the only place in the webview that touches Tauri.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::State;
use tauri::ipc::Channel;

use crate::activity::{Activity, History, HistoryEntry, read_audit};
use crate::agent::approvals::ApprovalDecision;
use crate::agent::backend::BackendKind;
use crate::agent::backends;
use crate::agent::runtime::{
    AgentEvent, AgentRuntime, DelegateInfo, DelegateRequest, Emit, TurnSummary,
};
use crate::config::{InferenceSettings, Settings, SettingsStore};
use crate::connection::{Connection, EngineStatus, EventSink, SafetyMode};
use crate::error::{HostError, HostResult};
use crate::icons::{ProviderIcon, ProviderIcons};
use crate::query::explorer::{self, Field, Method, MethodField, Provider, Resource, Service};
use crate::query::result::{QueryEvent, RunSummary};
use crate::secrets::SecretStore;
use crate::util::lock;

/// Emitted whenever the engine status changes. The payload is `EngineStatus`.
pub const ENGINE_STATUS_EVENT: &str = "engine-status";

pub struct AppState {
    pub connection: Arc<dyn Connection>,
    pub settings: Arc<SettingsStore>,
    pub icons: Arc<ProviderIcons>,
    pub agent: Arc<AgentRuntime>,
    pub secrets: Arc<dyn SecretStore>,
    /// False when the OS keychain could not be opened and keys are held in
    /// memory for this run only.
    pub keychain_available: bool,
    pub history: Arc<History>,
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

/// Saves the engine settings. If one of them changed, the engine is
/// restarted so the change takes effect. Chat settings are not touched here.
/// They have their own commands, because they come with a secret.
#[tauri::command]
pub async fn settings_save(state: State<'_, AppState>, settings: Settings) -> HostResult<Settings> {
    let before = state.settings.get();
    let saved = state.settings.replace(Settings {
        engine_path: settings.engine_path,
        env_file: settings.env_file,
        approot: settings.approot,
        ..before.clone()
    })?;
    if before.engine_path != saved.engine_path
        || before.env_file != saved.env_file
        || before.approot != saved.approot
    {
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
    let recorder = Arc::new(HistoryRecorder::new(state.history.clone()));
    let recording = recorder.clone();
    let sink: EventSink = Box::new(move |event| {
        recording.observe(&event);
        // A send only fails when the webview has gone away.
        let _ = on_event.send(event);
    });
    let summary = state.connection.run(run_id, sql, sink).await?;
    if summary.abandoned {
        recorder.abandoned();
    }
    Ok(summary)
}

/// Writes each statement of a run to the operator's history as it ends.
struct HistoryRecorder {
    history: Arc<History>,
    /// Statements that have started and not yet ended.
    open: Mutex<HashMap<usize, String>>,
}

impl HistoryRecorder {
    fn new(history: Arc<History>) -> Self {
        Self {
            history,
            open: Mutex::new(HashMap::new()),
        }
    }

    fn observe(&self, event: &QueryEvent) {
        match event {
            QueryEvent::StatementStarted { index, sql, .. } => {
                lock(&self.open).insert(*index, sql.clone());
            }
            QueryEvent::StatementFinished {
                index,
                row_count,
                elapsed_ms,
            } => {
                if let Some(sql) = lock(&self.open).remove(index) {
                    self.history.record(&HistoryEntry::now(
                        sql,
                        "ok",
                        Some(*row_count),
                        *elapsed_ms,
                    ));
                }
            }
            QueryEvent::StatementFailed {
                index,
                error,
                elapsed_ms,
            } => {
                if let Some(sql) = lock(&self.open).remove(index) {
                    self.history.record(
                        &HistoryEntry::now(sql, "error", None, *elapsed_ms)
                            .with_error(error.message.clone()),
                    );
                }
            }
            _ => {}
        }
    }

    /// The operator stopped waiting. Whatever was running is on record as
    /// abandoned, since the engine may still complete it.
    fn abandoned(&self) {
        for (_, sql) in lock(&self.open).drain() {
            self.history
                .record(&HistoryEntry::now(sql, "abandoned", None, 0));
        }
    }
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
    // The tree leaves the provider built into the engine out for now.
    Ok(explorer::visible_providers(explorer::map_providers(
        &result,
    )?))
}

/// What the registry offers. The engine asks the registry, so this needs
/// the network. It runs when the explorer loads and when the operator asks.
#[tauri::command]
pub async fn explorer_registry(state: State<'_, AppState>) -> HostResult<Vec<Provider>> {
    let result = state
        .connection
        .fetch(explorer::REGISTRY_LIST_SQL.to_string())
        .await?;
    Ok(explorer::visible_providers(explorer::map_registry(
        &result,
    )?))
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

/// What the webview may know about the chat configuration. The API key is
/// never part of it, only whether one is stored.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigView {
    /// `None` means chat is not configured and the chat pane stays hidden.
    pub inference: Option<InferenceSettings>,
    pub has_key: bool,
    pub safety_mode: SafetyMode,
    pub backends: Vec<BackendOption>,
    /// False when keys cannot be kept in the OS keychain on this machine.
    pub keychain_available: bool,
}

/// One backend the operator can choose, with what it defaults to.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendOption {
    pub kind: BackendKind,
    pub default_model: String,
    pub default_base_url: String,
    pub key_optional: bool,
    /// An agent the operator installed runs the model. There is no key and
    /// no address to enter, and no approval prompt.
    pub delegated: bool,
}

fn agent_config_view(state: &AppState) -> AgentConfigView {
    let settings = state.settings.get();
    let has_key = settings.inference.as_ref().is_some_and(|inference| {
        inference
            .kind
            .secret_name()
            .is_some_and(|name| state.secrets.get(name).is_ok_and(|key| key.is_some()))
    });
    let backends = BackendKind::ALL
        .into_iter()
        .map(|kind| BackendOption {
            kind,
            default_model: backends::default_model(kind).to_string(),
            default_base_url: backends::default_base_url(kind).to_string(),
            key_optional: kind.key_optional(),
            delegated: kind.is_delegated(),
        })
        .collect();
    AgentConfigView {
        inference: settings.inference,
        has_key,
        safety_mode: settings.safety_mode,
        backends,
        keychain_available: state.keychain_available,
    }
}

#[tauri::command]
pub async fn agent_config_get(state: State<'_, AppState>) -> HostResult<AgentConfigView> {
    Ok(agent_config_view(&state))
}

/// Saves the chat backend. A key, when given, goes to the OS keychain and
/// nowhere else. Leaving it out keeps the key that is already stored.
#[tauri::command]
pub async fn agent_config_save(
    state: State<'_, AppState>,
    inference: InferenceSettings,
    api_key: Option<String>,
) -> HostResult<AgentConfigView> {
    if let Some(key) = api_key.as_deref().map(str::trim).filter(|k| !k.is_empty())
        && let Some(name) = inference.kind.secret_name()
    {
        state.secrets.set(name, key)?;
    }
    let current = state.settings.get();
    state.settings.replace(Settings {
        inference: Some(inference),
        ..current
    })?;
    // A different model should not inherit a conversation it did not have.
    state.agent.reset().await;
    Ok(agent_config_view(&state))
}

/// Removes the chat backend and its stored key. The chat pane goes away and
/// the rest of the app carries on as before.
#[tauri::command]
pub async fn agent_config_clear(state: State<'_, AppState>) -> HostResult<AgentConfigView> {
    let current = state.settings.get();
    if let Some(name) = current
        .inference
        .as_ref()
        .and_then(|inference| inference.kind.secret_name())
    {
        state.secrets.delete(name)?;
    }
    state.settings.replace(Settings {
        inference: None,
        ..current
    })?;
    state.agent.reset().await;
    Ok(agent_config_view(&state))
}

/// Sets what the agent may do without asking. Takes effect on the next
/// message, when a new engine session is opened in that mode.
#[tauri::command]
pub async fn agent_set_safety_mode(
    state: State<'_, AppState>,
    mode: SafetyMode,
) -> HostResult<SafetyMode> {
    let current = state.settings.get();
    let saved = state.settings.replace(Settings {
        safety_mode: mode,
        ..current
    })?;
    Ok(saved.safety_mode)
}

/// Sends a message to the assistant. Events stream over `on_event` while
/// the command is pending. It resolves when the turn ends.
#[tauri::command]
pub async fn agent_send(
    state: State<'_, AppState>,
    text: String,
    on_event: Channel<AgentEvent>,
) -> HostResult<TurnSummary> {
    let settings = state.settings.get();
    let inference = settings.inference.ok_or_else(|| {
        HostError::Agent("Chat is not configured. Choose a backend in Settings.".to_string())
    })?;
    let emit: Emit = Arc::new(move |event| {
        let _ = on_event.send(event);
    });
    if inference.kind.is_delegated() {
        return state
            .agent
            .send_delegated(
                delegate_request(&inference),
                settings.safety_mode,
                text,
                emit,
            )
            .await;
    }
    let key = match inference.kind.secret_name() {
        Some(name) => state.secrets.get(name)?,
        None => None,
    };
    let backend =
        backends::build(&inference, key).map_err(|err| HostError::Agent(err.to_string()))?;
    state
        .agent
        .send(backend, settings.safety_mode, text, emit)
        .await
}

fn delegate_request(inference: &InferenceSettings) -> DelegateRequest {
    DelegateRequest {
        model: Some(inference.model.trim().to_string()).filter(|model| !model.is_empty()),
        program: inference.program.as_deref().map(std::path::PathBuf::from),
        subagents: inference.subagents,
    }
}

/// Asks a delegated agent for its version and the models it offers. This
/// starts the agent and opens a session, and sends no prompt. `program` is
/// the location in the settings form, which may not be saved yet.
#[tauri::command]
pub async fn agent_delegate_info(
    state: State<'_, AppState>,
    program: Option<String>,
) -> HostResult<DelegateInfo> {
    let request = DelegateRequest {
        model: None,
        program: program
            .map(|p| p.trim().trim_matches('"').to_string())
            .filter(|p| !p.is_empty())
            .map(std::path::PathBuf::from),
        // Nothing is asked of the agent here, so it needs no subagents.
        subagents: false,
    };
    state
        .agent
        .delegate_info(request, state.settings.get().safety_mode)
        .await
}

/// Delivers the operator's answer to an approval prompt.
#[tauri::command]
pub async fn agent_approve(
    state: State<'_, AppState>,
    approval_id: String,
    decision: ApprovalDecision,
) -> HostResult<bool> {
    Ok(state.agent.approvals().resolve(&approval_id, decision))
}

/// Stops the turn that is running. A statement the engine has already
/// started is not interrupted.
#[tauri::command]
pub async fn agent_stop(state: State<'_, AppState>) -> HostResult<bool> {
    Ok(state.agent.stop())
}

/// Starts a new conversation.
#[tauri::command]
pub async fn agent_reset(state: State<'_, AppState>) -> HostResult<()> {
    state.agent.reset().await;
    Ok(())
}

/// What was run recently, by the operator and by the agent.
#[tauri::command]
pub async fn activity_list(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> HostResult<Activity> {
    let limit = limit.unwrap_or(200).clamp(1, 2000);
    let agent = state
        .connection
        .audit_dir()
        .map(|dir| read_audit(&dir, limit))
        .unwrap_or_default();
    Ok(Activity {
        operator: state.history.list(limit),
        agent,
    })
}
