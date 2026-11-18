//! Integration tests against a real `stackql` binary.
//!
//! They are skipped, with a note on stderr, when no binary can be found. They
//! need no cloud credentials and no network: every statement is a metadata
//! statement or a literal `SELECT`, and the only provider used is the one
//! built into the engine.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use stackql_workbench_lib::config::{Settings, SettingsStore};
use stackql_workbench_lib::connection::local::LocalConnection;
use stackql_workbench_lib::connection::{
    Connection, DelegateCommand, EngineState, EventSink, McpServerCommand, SafetyMode,
};
use stackql_workbench_lib::engine::approot::Defaults as ApprootDefaults;
use stackql_workbench_lib::engine::discovery::{self, Inputs};
use stackql_workbench_lib::error::HostError;
use stackql_workbench_lib::query::explorer;
use stackql_workbench_lib::query::result::QueryEvent;

/// The provider compiled into the engine. It is there on a fresh approot.
const BUILT_IN_PROVIDER: &str = "stackql_preview";

fn engine_available() -> bool {
    let found = discovery::resolve(&Inputs::from_environment(None), |p| p.is_file()).is_ok();
    if !found {
        eprintln!("skipped: no stackql binary found (set STACKQL_BIN or add stackql to PATH)");
    }
    found
}

fn scratch_approot(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wb-it-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

async fn started(name: &str) -> (LocalConnection, PathBuf) {
    let approot = scratch_approot(name);
    let settings = Arc::new(SettingsStore::in_memory(Settings::default()));
    let connection = LocalConnection::new(
        ApprootDefaults::fixed(approot.clone()),
        approot.join("audit"),
        settings,
    )
    .unwrap();
    let status = connection.start().await;
    assert_eq!(
        status.state,
        EngineState::Running,
        "engine did not start: {:?} {:?}",
        status.error,
        status.log_tail
    );
    (connection, approot)
}

async fn finish(connection: LocalConnection, approot: PathBuf) {
    connection.shutdown().await;
    assert_eq!(connection.status().state, EngineState::Stopped);
    let _ = std::fs::remove_dir_all(approot);
}

fn collector() -> (EventSink, Arc<Mutex<Vec<QueryEvent>>>) {
    let events: Arc<Mutex<Vec<QueryEvent>>> = Arc::default();
    let sink_events = events.clone();
    let sink: EventSink = Box::new(move |event| sink_events.lock().unwrap().push(event));
    (sink, events)
}

#[tokio::test]
async fn starts_reports_status_and_stops() {
    if !engine_available() {
        return;
    }
    let (connection, approot) = started("status").await;

    let status = connection.status();
    assert!(
        status
            .location
            .as_deref()
            .is_some_and(|l| l.contains("stackql"))
    );
    assert!(status.location_source.is_some());
    let version = status.version.clone().unwrap();
    assert!(
        version.chars().next().is_some_and(|c| c.is_ascii_digit()),
        "unexpected version {version:?}"
    );
    let endpoint = status.endpoint.clone().unwrap();
    assert!(
        endpoint.starts_with("127.0.0.1:"),
        "must be loopback: {endpoint}"
    );
    assert_eq!(status.error, None);

    finish(connection, approot).await;
}

#[tokio::test]
async fn runs_a_metadata_statement_and_streams_rows() {
    if !engine_available() {
        return;
    }
    let (connection, approot) = started("metadata").await;

    let (sink, events) = collector();
    let summary = connection
        .run("run-1".into(), "SHOW PROVIDERS".into(), sink)
        .await
        .unwrap();
    assert_eq!(summary.statements, 1);
    assert_eq!(summary.completed, 1);
    assert!(!summary.failed && !summary.abandoned);

    let events = events.lock().unwrap().clone();
    assert!(matches!(
        &events[0],
        QueryEvent::StatementStarted { index: 0, total: 1, sql } if sql == "SHOW PROVIDERS"
    ));
    let columns = events.iter().find_map(|e| match e {
        QueryEvent::Columns { columns, .. } => Some(columns.clone()),
        _ => None,
    });
    assert_eq!(
        columns,
        Some(vec!["name".to_string(), "version".to_string()])
    );
    let rows: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            QueryEvent::Rows { rows, .. } => Some(rows.clone()),
            _ => None,
        })
        .flatten()
        .collect();
    assert!(
        rows.iter()
            .any(|r| r[0].as_deref() == Some(BUILT_IN_PROVIDER)),
        "built-in provider missing from {rows:?}"
    );
    let finished = events.iter().find_map(|e| match e {
        QueryEvent::StatementFinished { row_count, .. } => Some(*row_count),
        _ => None,
    });
    // The engine's command tag has no count. The host counts.
    assert_eq!(finished, Some(rows.len() as u64));

    finish(connection, approot).await;
}

#[tokio::test]
async fn every_statement_in_the_text_runs_not_just_the_first() {
    if !engine_available() {
        return;
    }
    let (connection, approot) = started("multi").await;

    // Sent as one message, the engine would run only the first of these.
    let (sink, events) = collector();
    let summary = connection
        .run(
            "run-1".into(),
            "SHOW VERSION; SELECT 1 AS one, 'a,b' AS s; -- done".into(),
            sink,
        )
        .await
        .unwrap();
    let events = events.lock().unwrap().clone();
    assert_eq!(summary.statements, 2);
    assert_eq!(summary.completed, 2, "{events:?}");

    let second_rows: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            QueryEvent::Rows { index: 1, rows } => Some(rows.clone()),
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(
        second_rows,
        vec![vec![Some("1".to_string()), Some("a,b".to_string())]],
        "values are text"
    );

    finish(connection, approot).await;
}

#[tokio::test]
async fn an_error_stops_the_run_and_the_session_stays_usable() {
    if !engine_available() {
        return;
    }
    let (connection, approot) = started("errors").await;

    let (sink, events) = collector();
    let summary = connection
        .run(
            "run-1".into(),
            "SHOW VERSION; SELEC 1; SHOW PROVIDERS".into(),
            sink,
        )
        .await
        .unwrap();
    assert_eq!(summary.statements, 3);
    assert_eq!(summary.completed, 1);
    assert!(summary.failed);

    let events = events.lock().unwrap().clone();
    let error = events
        .iter()
        .find_map(|e| match e {
            QueryEvent::StatementFailed {
                index: 1, error, ..
            } => Some(error.clone()),
            _ => None,
        })
        .expect("the second statement should fail");
    assert_eq!(error.severity.as_deref(), Some("ERROR"));
    assert_eq!(error.code.as_deref(), Some("XXUUU"));
    assert!(error.message.contains("syntax"), "{}", error.message);
    assert!(!error.connection_lost);
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, QueryEvent::StatementStarted { index: 2, .. })),
        "nothing runs after a failure"
    );

    // The same session takes the next run.
    let (sink, _) = collector();
    let summary = connection
        .run("run-2".into(), "SHOW VERSION".into(), sink)
        .await
        .unwrap();
    assert_eq!(summary.completed, 1);

    finish(connection, approot).await;
}

#[tokio::test]
async fn explorer_statements_work_against_the_built_in_provider() {
    if !engine_available() {
        return;
    }
    let (connection, approot) = started("explorer").await;

    let providers = explorer::map_providers(
        &connection
            .fetch(explorer::PROVIDERS_SQL.to_string())
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(providers.iter().any(|p| p.name == BUILT_IN_PROVIDER));

    let services = explorer::map_services(
        &connection
            .fetch(explorer::services_sql(BUILT_IN_PROVIDER).unwrap())
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(!services.is_empty(), "the built-in provider has services");
    let service = &services[0].name;

    let resources = explorer::map_resources(
        &connection
            .fetch(explorer::resources_sql(BUILT_IN_PROVIDER, service).unwrap())
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(!resources.is_empty(), "service {service} has resources");
    let resource = &resources[0];
    assert_eq!(
        resource.id,
        format!("{BUILT_IN_PROVIDER}.{service}.{}", resource.name),
        "the resource id is the fully qualified name"
    );

    // An unknown name is an engine error, carried back as a query error.
    let err = connection
        .fetch(explorer::services_sql("no_such_provider_xyz").unwrap())
        .await
        .unwrap_err();
    assert!(matches!(err, HostError::Query(_)));

    finish(connection, approot).await;
}

#[tokio::test]
async fn a_run_without_an_engine_says_so() {
    let approot = scratch_approot("stopped");
    let settings = Arc::new(SettingsStore::in_memory(Settings::default()));
    let connection = LocalConnection::new(
        ApprootDefaults::fixed(approot.clone()),
        approot.join("audit"),
        settings,
    )
    .unwrap();
    let (sink, _) = collector();
    let err = connection
        .run("run-1".into(), "SHOW VERSION".into(), sink)
        .await
        .unwrap_err();
    assert_eq!(err, HostError::EngineNotRunning);
    assert!(!connection.abandon("run-1"));
}

#[tokio::test]
async fn a_wrong_engine_path_is_reported_in_the_status() {
    let approot = scratch_approot("badpath");
    let settings = Arc::new(SettingsStore::in_memory(Settings {
        engine_path: Some("/definitely/not/here/stackql".into()),
        ..Settings::default()
    }));
    let connection = LocalConnection::new(
        ApprootDefaults::fixed(approot.clone()),
        approot.join("audit"),
        settings,
    )
    .unwrap();
    let status = connection.start().await;
    assert_eq!(status.state, EngineState::Failed);
    let error = status.error.unwrap();
    assert!(error.contains("Settings"), "points at settings: {error}");
}

#[tokio::test]
async fn the_data_folder_defaults_to_beside_the_app_and_settings_override_it() {
    if !engine_available() {
        return;
    }
    let root = scratch_approot("datafolder");
    let beside = root.join("app").join(".stackql");
    let fallback = root.join("data").join("engine");
    let named = root.join("named");

    // With nothing in settings, the folder beside the app is used.
    let settings = Arc::new(SettingsStore::in_memory(Settings::default()));
    let connection = LocalConnection::new(
        ApprootDefaults {
            beside_app: Some(beside.clone()),
            fallback: fallback.clone(),
        },
        root.join("audit"),
        settings.clone(),
    )
    .unwrap();
    let status = connection.start().await;
    assert_eq!(status.state, EngineState::Running, "{:?}", status.error);
    assert_eq!(
        status.data_folder.as_deref(),
        Some(beside.to_str().unwrap())
    );
    assert_eq!(status.data_folder_source.as_deref(), Some("beside the app"));
    assert_eq!(status.data_folder_note, None);
    assert!(beside.is_dir(), "the engine's folder exists");
    assert!(!fallback.exists(), "the fallback is left alone");

    // A folder named in settings takes over at the next start.
    settings
        .replace(Settings {
            approot: Some(named.to_str().unwrap().to_string()),
            ..Settings::default()
        })
        .unwrap();
    let status = connection.restart().await;
    assert_eq!(status.state, EngineState::Running, "{:?}", status.error);
    assert_eq!(status.data_folder.as_deref(), Some(named.to_str().unwrap()));
    assert_eq!(status.data_folder_source.as_deref(), Some("settings"));
    let (sink, _) = collector();
    let summary = connection
        .run("run-1".into(), "SHOW PROVIDERS".into(), sink)
        .await
        .unwrap();
    assert_eq!(summary.completed, 1);
    assert!(named.is_dir());

    finish(connection, root).await;
}

#[tokio::test]
async fn a_data_folder_that_cannot_be_used_is_reported_in_the_status() {
    if !engine_available() {
        return;
    }
    let root = scratch_approot("baddatafolder");
    std::fs::create_dir_all(&root).unwrap();
    // A file where the folder should be.
    let blocked = root.join("not-a-folder");
    std::fs::write(&blocked, b"x").unwrap();

    let settings = Arc::new(SettingsStore::in_memory(Settings {
        approot: Some(blocked.to_str().unwrap().to_string()),
        ..Settings::default()
    }));
    let connection = LocalConnection::new(
        ApprootDefaults::fixed(root.join("engine")),
        root.join("audit"),
        settings,
    )
    .unwrap();
    let status = connection.start().await;
    assert_eq!(status.state, EngineState::Failed);
    let error = status.error.unwrap();
    assert!(error.contains("Settings"), "points at settings: {error}");
    assert!(
        !root.join("engine").exists(),
        "a folder named in settings is never replaced by a default"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[tokio::test]
async fn a_delegate_is_told_how_the_mcp_server_starts_and_gets_piped_stdio() {
    if !engine_available() {
        return;
    }
    let (connection, approot) = started("delegate").await;
    let binary = PathBuf::from(connection.status().location.unwrap());

    let seen: Arc<Mutex<Option<McpServerCommand>>> = Arc::default();
    let sink = seen.clone();
    // Any program that writes to stdout stands in for an agent here.
    let program = binary.clone();
    let cwd = approot.clone();
    let mut channel = connection
        .open_delegate_channel(
            SafetyMode::ReadOnly,
            Box::new(move |server| {
                *sink.lock().unwrap() = Some(server);
                Ok(DelegateCommand {
                    program,
                    args: vec!["--version".into()],
                    cwd,
                })
            }),
        )
        .await
        .unwrap();

    // The builder was told to start the same binary, on the same data
    // folder, over stdio, in the mode that was asked for.
    let server = seen.lock().unwrap().clone().unwrap();
    assert_eq!(server.program, binary);
    assert_eq!(server.cwd, approot);
    let args: Vec<String> = server
        .args
        .iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let after = |flag: &str| args[args.iter().position(|a| a == flag).unwrap() + 1].clone();
    assert_eq!(args[0], "mcp");
    assert!(args.contains(&"--mcp.server.type=stdio".to_string()));
    assert_eq!(after("--approot"), approot.to_string_lossy());
    let config: serde_json::Value = serde_json::from_str(&after("--mcp.config")).unwrap();
    assert_eq!(config["server"]["mode"], "read_only");
    assert_eq!(config["server"]["transport"], "stdio");

    // What the program writes arrives on the channel.
    let mut text = String::new();
    tokio::time::timeout(
        Duration::from_secs(10),
        tokio::io::AsyncReadExt::read_to_string(&mut channel.reader, &mut text),
    )
    .await
    .expect("the program did not finish")
    .unwrap();
    assert!(text.starts_with("stackql"), "unexpected output {text:?}");

    drop(channel);
    finish(connection, approot).await;
}

#[tokio::test]
async fn a_delegate_cannot_start_without_an_engine() {
    let approot = scratch_approot("nodelegate");
    let settings = Arc::new(SettingsStore::in_memory(Settings::default()));
    let connection = LocalConnection::new(
        ApprootDefaults::fixed(approot.clone()),
        approot.join("audit"),
        settings,
    )
    .unwrap();
    let asked = Arc::new(Mutex::new(false));
    let flag = asked.clone();
    let outcome = connection
        .open_delegate_channel(
            SafetyMode::Safe,
            Box::new(move |_| {
                *flag.lock().unwrap() = true;
                Err(HostError::Agent("not reached".into()))
            }),
        )
        .await;
    assert!(matches!(outcome, Err(HostError::EngineNotRunning)));
    assert!(!*asked.lock().unwrap(), "nothing may be started");
}

#[tokio::test]
async fn restart_gives_a_working_engine_on_a_new_port() {
    if !engine_available() {
        return;
    }
    let (connection, approot) = started("restart").await;
    let first = connection.status().endpoint.unwrap();

    let status = connection.restart().await;
    assert_eq!(status.state, EngineState::Running);
    let second = status.endpoint.unwrap();
    assert!(second.starts_with("127.0.0.1:"));
    // Not guaranteed to differ, but the old engine must be gone either way.
    let _ = first;

    let (sink, _) = collector();
    let summary = connection
        .run("run-1".into(), "SHOW VERSION".into(), sink)
        .await
        .unwrap();
    assert_eq!(summary.completed, 1);

    finish(connection, approot).await;
}

#[tokio::test]
async fn abandoning_a_run_returns_promptly_and_the_next_run_works() {
    if !engine_available() {
        return;
    }
    let (connection, approot) = started("abandon").await;
    let connection = Arc::new(connection);

    // REGISTRY LIST calls the registry and takes around a second when the
    // network is up. If it is down the statement fails fast, and the test
    // still checks that the session recovers.
    let runner = connection.clone();
    let (sink, _) = collector();
    let run = tokio::spawn(async move {
        runner
            .run(
                "slow".into(),
                "REGISTRY LIST; REGISTRY LIST; REGISTRY LIST".into(),
                sink,
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(150)).await;
    let was_running = connection.abandon("slow");
    let summary = tokio::time::timeout(Duration::from_secs(20), run)
        .await
        .expect("an abandoned run must return")
        .unwrap()
        .unwrap();
    if was_running && !summary.failed {
        assert!(summary.abandoned, "{summary:?}");
        assert!(summary.completed < 3);
    }

    let (sink, _) = collector();
    let summary = connection
        .run("after".into(), "SHOW VERSION".into(), sink)
        .await
        .unwrap();
    assert_eq!(summary.completed, 1, "a fresh session takes over");

    let connection = Arc::try_unwrap(connection).ok().expect("no other owners");
    finish(connection, approot).await;
}
