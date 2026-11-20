//! MCP spike against a real `stackql mcp` over stdio.
//!
//! Starts the engine's MCP server as a child process, connects with `rmcp`
//! the way the host does (the host owns the process and hands the SDK the
//! pipes), and records what the agent runtime depends on: protocol revision
//! negotiation, the tool list, result shapes, how a mutation asks for
//! approval, and what lands in the audit log. The output is the evidence in
//! `docs/spike-mcp.md`.
//!
//! Run from `src-tauri`:
//!
//! ```text
//! cargo run --example mcp_spike -- [--bin <stackql>] [--approot <dir>]
//! ```
//!
//! No cloud credentials are used. The only mutation that is approved is
//! against a provider with no credentials configured, so it cannot succeed.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rmcp::model::{
    CallToolRequestParams, CallToolResult, ClientCapabilities, ClientConfig, ElicitRequestParams,
    ElicitResult, ElicitationAction, ElicitationCapability, FormElicitationCapability,
    Implementation, ProtocolVersion,
};
use rmcp::service::{RequestContext, RoleClient, RunningService};
use rmcp::{ClientHandler, ErrorData, ServiceExt};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

type AnyError = Box<dyn std::error::Error + Send + Sync>;

/// What the stand-in for the operator answers when asked to approve.
#[derive(Clone, Copy, Debug)]
enum Answer {
    Accept,
    Decline,
    Cancel,
}

#[derive(Clone)]
struct SpikeClient {
    version: ProtocolVersion,
    advertise_elicitation: bool,
    answer: Arc<Mutex<Answer>>,
    seen: Arc<Mutex<Vec<String>>>,
}

impl ClientHandler for SpikeClient {
    fn get_info(&self) -> ClientConfig {
        let mut capabilities = ClientCapabilities::default();
        if self.advertise_elicitation {
            let mut elicitation = ElicitationCapability::default();
            elicitation.form = Some(FormElicitationCapability::default());
            capabilities.elicitation = Some(elicitation);
        }
        ClientConfig::new(
            capabilities,
            Implementation::new("stackql-workbench-spike", env!("CARGO_PKG_VERSION")),
        )
        .with_protocol_version(self.version.clone())
    }

    async fn create_elicitation(
        &self,
        request: ElicitRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> Result<ElicitResult, ErrorData> {
        let json = serde_json::to_string_pretty(&request).unwrap_or_default();
        self.seen.lock().unwrap().push(json);
        let answer = *self.answer.lock().unwrap();
        Ok(match answer {
            Answer::Accept => {
                ElicitResult::new(ElicitationAction::Accept).with_content(serde_json::json!({}))
            }
            Answer::Decline => ElicitResult::new(ElicitationAction::Decline),
            Answer::Cancel => ElicitResult::new(ElicitationAction::Cancel),
        })
    }
}

struct Session {
    child: Child,
    service: RunningService<RoleClient, SpikeClient>,
    answer: Arc<Mutex<Answer>>,
    seen: Arc<Mutex<Vec<String>>>,
    stderr: Arc<Mutex<Vec<String>>>,
    connect_ms: u128,
}

async fn connect(
    bin: &Path,
    approot: &Path,
    audit_dir: &Path,
    mode: &str,
    version: ProtocolVersion,
    advertise_elicitation: bool,
) -> Result<Session, AnyError> {
    let config = serde_json::json!({
        "server": {
            "transport": "stdio",
            "mode": mode,
            "audit": { "format": "jsonl", "file": { "dir": audit_dir } }
        }
    });
    let started = Instant::now();
    let mut child = Command::new(bin)
        .arg("mcp")
        .arg("--mcp.server.type=stdio")
        .arg("--approot")
        .arg(approot)
        .arg("--mcp.config")
        .arg(config.to_string())
        .current_dir(approot)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr: Arc<Mutex<Vec<String>>> = Arc::default();
    if let Some(pipe) = child.stderr.take() {
        let sink = stderr.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(pipe).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                sink.lock().unwrap().push(line);
            }
        });
    }

    let answer = Arc::new(Mutex::new(Answer::Decline));
    let seen: Arc<Mutex<Vec<String>>> = Arc::default();
    let client = SpikeClient {
        version,
        advertise_elicitation,
        answer: answer.clone(),
        seen: seen.clone(),
    };
    // The host owns the process. The SDK only gets the two pipes.
    let service = client.serve((stdout, stdin)).await?;
    Ok(Session {
        child,
        service,
        answer,
        seen,
        stderr,
        connect_ms: started.elapsed().as_millis(),
    })
}

fn clip(text: &str, max: usize) -> String {
    let flat = text.replace(['\r', '\n'], " | ");
    if flat.chars().count() > max {
        let head: String = flat.chars().take(max).collect();
        format!("{head}... [{} chars]", flat.chars().count())
    } else {
        flat
    }
}

fn describe(result: &CallToolResult) -> String {
    let text: Vec<String> = result
        .content
        .iter()
        .filter_map(|block| block.as_text().map(|t| t.text.clone()))
        .collect();
    let structured = result
        .structured_content
        .as_ref()
        .map_or_else(|| "none".to_string(), |v| clip(&v.to_string(), 420));
    format!(
        "is_error={:?} content_blocks={} text={:?}\n      structured={structured}",
        result.is_error,
        result.content.len(),
        clip(&text.join("\n"), 320),
    )
}

async fn call(session: &Session, tool: &str, args: serde_json::Value) {
    let started = Instant::now();
    let mut params = CallToolRequestParams::new(tool.to_string());
    if let Some(object) = args.as_object() {
        params = params.with_arguments(object.clone());
    }
    let outcome =
        tokio::time::timeout(Duration::from_secs(60), session.service.call_tool(params)).await;
    let ms = started.elapsed().as_millis();
    println!("\n> {tool} {}", clip(&args.to_string(), 200));
    match outcome {
        Ok(Ok(result)) => println!("    [{ms} ms] {}", describe(&result)),
        Ok(Err(err)) => println!("    [{ms} ms] protocol error: {err}"),
        Err(_) => println!("    [{ms} ms] timed out"),
    }
    let mut seen = session.seen.lock().unwrap();
    for request in seen.drain(..) {
        println!("    elicitation request received:");
        for line in request.lines() {
            println!("      {line}");
        }
    }
}

async fn close(mut session: Session) {
    let reason = session.service.cancel().await;
    println!("\nclient closed: {reason:?}");
    let exit = tokio::time::timeout(Duration::from_secs(5), session.child.wait()).await;
    println!("server process after its stdin closed: {exit:?}");
    let _ = session.child.kill().await;
}

fn print_audit(dir: &Path) {
    println!("\n== audit log ==");
    let Ok(entries) = std::fs::read_dir(dir) else {
        println!("no audit directory at {}", dir.display());
        return;
    };
    let mut files: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    files.sort();
    for file in &files {
        let text = std::fs::read_to_string(file).unwrap_or_default();
        println!(
            "{} ({} lines)",
            file.file_name().unwrap_or_default().to_string_lossy(),
            text.lines().count()
        );
    }
    if let Some(last) = files.last() {
        let text = std::fs::read_to_string(last).unwrap_or_default();
        println!("last file, every record:");
        for line in text.lines() {
            println!("  {}", clip(line, 400));
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), AnyError> {
    let mut bin =
        std::env::var_os("STACKQL_BIN").map_or_else(|| PathBuf::from("stackql"), PathBuf::from);
    let mut approot = std::env::temp_dir().join("stackql-workbench-spike");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bin" => bin = PathBuf::from(args.next().ok_or("--bin needs a value")?),
            "--approot" => approot = PathBuf::from(args.next().ok_or("--approot needs a value")?),
            other => return Err(format!("unknown argument {other}").into()),
        }
    }
    std::fs::create_dir_all(&approot)?;
    let audit_dir = approot.join("audit-spike");
    let _ = std::fs::remove_dir_all(&audit_dir);
    std::fs::create_dir_all(&audit_dir)?;

    let version = Command::new(&bin).arg("--version").output().await?;
    println!(
        "engine: {}",
        String::from_utf8_lossy(&version.stdout)
            .lines()
            .next()
            .unwrap_or("")
    );
    println!("rmcp: 3.11");

    println!("\n== protocol revision negotiation ==");
    for offered in [
        ProtocolVersion::V_2024_11_05,
        ProtocolVersion::V_2025_06_18,
        ProtocolVersion::LATEST_WITH_INITIALIZE,
        ProtocolVersion::LATEST,
    ] {
        match tokio::time::timeout(
            Duration::from_secs(20),
            connect(&bin, &approot, &audit_dir, "safe", offered.clone(), true),
        )
        .await
        {
            Ok(Ok(session)) => {
                let info = session.service.peer_info();
                println!(
                    "offered {offered}: connected in {} ms, negotiated {:?}, server {:?}",
                    session.connect_ms,
                    info.as_ref().map(|i| i.protocol_version.to_string()),
                    info.as_ref()
                        .and_then(|i| i.server_info.as_ref())
                        .map(|s| format!("{} {}", s.name, s.version)),
                );
                let tools = session.service.list_all_tools().await;
                println!(
                    "  tools listed: {:?}",
                    tools.map(|t| t.len()).map_err(|e| e.to_string())
                );
                let _ = session.service.cancel().await;
            }
            Ok(Err(err)) => println!("offered {offered}: failed: {err}"),
            Err(_) => println!("offered {offered}: timed out"),
        }
    }

    println!("\n== session in safe mode, handshake lifecycle ==");
    let session = connect(
        &bin,
        &approot,
        &audit_dir,
        "safe",
        ProtocolVersion::LATEST_WITH_INITIALIZE,
        true,
    )
    .await?;
    if let Some(info) = session.service.peer_info() {
        println!("negotiated revision: {}", info.protocol_version);
        println!("server info: {:?}", info.server_info);
        println!(
            "capabilities: {}",
            clip(
                &serde_json::to_string(&info.capabilities).unwrap_or_default(),
                400
            )
        );
        println!(
            "instructions: {} chars, starting {:?}",
            info.instructions.as_deref().map_or(0, str::len),
            info.instructions.as_deref().map(|i| clip(i, 160))
        );
    }

    println!("\n== tools ==");
    let tools = session.service.list_all_tools().await?;
    for tool in &tools {
        let annotations = tool.annotations.as_ref().map(|a| {
            format!(
                "readOnly={:?} destructive={:?} idempotent={:?} openWorld={:?}",
                a.read_only_hint, a.destructive_hint, a.idempotent_hint, a.open_world_hint
            )
        });
        let schema = serde_json::Value::Object((*tool.input_schema).clone());
        let properties: Vec<String> = schema
            .get("properties")
            .and_then(|p| p.as_object())
            .map(|p| p.keys().cloned().collect())
            .unwrap_or_default();
        println!(
            "{:<24} title={:?} args={:?} required={} {}",
            tool.name,
            tool.title,
            properties,
            schema
                .get("required")
                .map_or_else(|| "[]".to_string(), ToString::to_string),
            annotations.unwrap_or_default(),
        );
    }
    if let Some(tool) = tools.iter().find(|t| t.name == "run_select_query") {
        println!(
            "run_select_query input schema: {}",
            serde_json::Value::Object((*tool.input_schema).clone())
        );
        println!(
            "run_select_query description: {:?}",
            tool.description.as_deref().map(|d| clip(d, 300))
        );
        println!(
            "run_select_query has an output schema: {}",
            tool.output_schema.is_some()
        );
    }

    println!("\n== read tools ==");
    call(&session, "server_info", serde_json::json!({})).await;
    call(&session, "list_providers", serde_json::json!({})).await;
    call(
        &session,
        "pull_provider",
        serde_json::json!({ "provider": "homebrew" }),
    )
    .await;
    call(
        &session,
        "list_services",
        serde_json::json!({ "provider": "homebrew" }),
    )
    .await;
    call(
        &session,
        "run_select_query",
        serde_json::json!({ "sql": "SELECT name, license, versions FROM homebrew.formula.formula WHERE formula_name = 'wget'" }),
    )
    .await;
    call(
        &session,
        "run_select_query",
        serde_json::json!({ "sql": "SELECT name FROM homebrew.formula.formula WHERE formula_name = 'wget' UNION ALL SELECT name FROM homebrew.formula.formula WHERE formula_name = 'jq'" }),
    )
    .await;

    println!("\n== failures on the read path ==");
    call(
        &session,
        "run_select_query",
        serde_json::json!({ "sql": "SELEC 1" }),
    )
    .await;
    call(
        &session,
        "run_select_query",
        serde_json::json!({ "sql": "SELECT name FROM homebrew.formula.formula WHERE formula_name = 'no-such-formula-xyz-123'" }),
    )
    .await;
    call(
        &session,
        "list_services",
        serde_json::json!({ "provider": "no_such_provider" }),
    )
    .await;
    call(&session, "run_select_query", serde_json::json!({})).await;
    call(&session, "no_such_tool", serde_json::json!({})).await;
    // A write sent to the read tool must be refused in every mode.
    call(
        &session,
        "run_select_query",
        serde_json::json!({ "sql": "DELETE FROM github.repos.repos WHERE owner = 'nobody-xyz' AND repo = 'nothing-xyz'" }),
    )
    .await;

    println!("\n== approval flow in safe mode ==");
    let delete = serde_json::json!({ "sql": "DELETE FROM github.repos.repos WHERE owner = 'nobody-xyz' AND repo = 'nothing-xyz'" });
    println!("-- operator declines");
    *session.answer.lock().unwrap() = Answer::Decline;
    call(&session, "run_mutation_query", delete.clone()).await;
    println!("-- operator cancels");
    *session.answer.lock().unwrap() = Answer::Cancel;
    call(&session, "run_mutation_query", delete.clone()).await;
    println!(
        "-- operator accepts (no credentials are configured, so the provider call cannot succeed)"
    );
    *session.answer.lock().unwrap() = Answer::Accept;
    call(&session, "run_mutation_query", delete.clone()).await;
    println!("-- lifecycle operation, declined");
    *session.answer.lock().unwrap() = Answer::Decline;
    call(
        &session,
        "run_lifecycle_operation",
        serde_json::json!({ "sql": "EXEC github.repos.repos.list_for_org @org = 'stackql'" }),
    )
    .await;

    let stderr = session.stderr.lock().unwrap().clone();
    println!("\nserver stderr lines: {}", stderr.len());
    for line in stderr.iter().take(6) {
        println!("  {}", clip(line, 200));
    }
    close(session).await;

    println!("\n== a client that does not advertise elicitation ==");
    let session = connect(
        &bin,
        &approot,
        &audit_dir,
        "safe",
        ProtocolVersion::LATEST_WITH_INITIALIZE,
        false,
    )
    .await?;
    call(&session, "run_mutation_query", delete.clone()).await;
    let _ = session.service.cancel().await;

    println!("\n== read_only mode ==");
    let session = connect(
        &bin,
        &approot,
        &audit_dir,
        "read_only",
        ProtocolVersion::LATEST_WITH_INITIALIZE,
        true,
    )
    .await?;
    call(&session, "server_info", serde_json::json!({})).await;
    call(&session, "run_mutation_query", delete.clone()).await;
    let _ = session.service.cancel().await;

    println!("\n== the newest revision (no handshake), approval by input_required round trip ==");
    match connect(
        &bin,
        &approot,
        &audit_dir,
        "safe",
        ProtocolVersion::LATEST,
        true,
    )
    .await
    {
        Ok(session) => {
            *session.answer.lock().unwrap() = Answer::Decline;
            call(&session, "list_providers", serde_json::json!({})).await;
            call(&session, "run_mutation_query", delete).await;
            let _ = session.service.cancel().await;
        }
        Err(err) => println!("could not connect on the newest revision: {err}"),
    }

    print_audit(&audit_dir);
    Ok(())
}
