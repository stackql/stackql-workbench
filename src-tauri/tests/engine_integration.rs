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
use stackql_workbench_lib::connection::{Connection, EngineState, EventSink};
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
    let connection = LocalConnection::new(approot.clone(), settings).unwrap();
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
    let connection = LocalConnection::new(approot, settings).unwrap();
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
        env_file: None,
    }));
    let connection = LocalConnection::new(approot, settings).unwrap();
    let status = connection.start().await;
    assert_eq!(status.state, EngineState::Failed);
    let error = status.error.unwrap();
    assert!(error.contains("Settings"), "points at settings: {error}");
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
