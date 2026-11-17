//! pg wire spike against a real `stackql srv`.
//!
//! Starts the engine on a free loopback port with a scratch approot, then
//! probes the wire protocol twice: once with hand-built protocol frames, so
//! nothing is hidden by a client library, and once through `tokio-postgres`,
//! the client the host uses. The output is the evidence recorded in
//! `docs/spike-pgwire.md`.
//!
//! Run from `src-tauri`:
//!
//! ```text
//! cargo run --example pgwire_spike -- [--bin <stackql>] [--approot <dir>] [--only <section>]
//! ```
//!
//! No cloud credentials are used. Statements go to provider metadata and to
//! two providers that serve public data without authentication.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{StreamExt, future};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio_postgres::{AsyncMessage, Config, NoTls, SimpleQueryMessage};

type AnyError = Box<dyn std::error::Error + Send + Sync>;
type Log = Arc<Mutex<Vec<(Duration, &'static str, String)>>>;

const FORMULAS: &[&str] = &[
    "wget",
    "curl",
    "git",
    "jq",
    "go",
    "node",
    "rust",
    "cmake",
    "make",
    "sqlite",
    "zlib",
    "xz",
    "zstd",
    "readline",
    "ncurses",
    "gettext",
    "pcre2",
    "libyaml",
    "tree",
    "htop",
    "tmux",
    "vim",
    "nginx",
    "redis",
    "lua",
    "ruby",
    "perl",
    "php",
    "gcc",
    "llvm",
    "bash",
    "zsh",
    "fish",
    "less",
    "nano",
    "rsync",
    "gnupg",
    "pandoc",
    "ffmpeg",
    "imagemagick",
    "graphviz",
    "protobuf",
    "grpc",
    "boost",
    "openjdk",
    "maven",
    "gradle",
    "kotlin",
    "scala",
    "sbt",
    "leiningen",
    "clojure",
    "erlang",
    "elixir",
    "ghc",
    "ocaml",
    "opam",
    "nim",
    "zig",
    "deno",
];

struct Server {
    child: Child,
    port: u16,
    log: Log,
    started: Instant,
}

impl Server {
    async fn start(bin: &PathBuf, approot: &PathBuf, extra: &[&str]) -> Result<Self, AnyError> {
        // Bind to port 0 to have the OS pick a free port, then release it.
        let port = TcpListener::bind("127.0.0.1:0").await?.local_addr()?.port();
        let mut cmd = Command::new(bin);
        cmd.arg("srv")
            .args(["--pgsrv.address", "127.0.0.1"])
            .args(["--pgsrv.port", &port.to_string()])
            .arg("--approot")
            .arg(approot)
            .args(extra)
            .current_dir(approot)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let started = Instant::now();
        let mut child = cmd.spawn()?;
        let log: Log = Arc::default();
        if let Some(out) = child.stdout.take() {
            tokio::spawn(pump(out, "stdout", log.clone(), started));
        }
        if let Some(err) = child.stderr.take() {
            tokio::spawn(pump(err, "stderr", log.clone(), started));
        }
        Ok(Self {
            child,
            port,
            log,
            started,
        })
    }

    /// Returns the log lines captured since `mark` and the new mark.
    fn log_since(&self, mark: usize) -> (Vec<String>, usize) {
        let log = self.log.lock().unwrap();
        let lines = log[mark..]
            .iter()
            .map(|(at, stream, line)| format!("[{:>7.3}s {stream}] {line}", at.as_secs_f64()))
            .collect();
        (lines, log.len())
    }

    fn mark(&self) -> usize {
        self.log.lock().unwrap().len()
    }
}

async fn pump<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
    stream: &'static str,
    log: Log,
    started: Instant,
) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        log.lock().unwrap().push((started.elapsed(), stream, line));
    }
}

// --- raw protocol -----------------------------------------------------------

#[derive(Debug, Clone)]
struct Field {
    name: String,
    table_oid: u32,
    attnum: i16,
    type_oid: u32,
    typlen: i16,
    typmod: i32,
    format: i16,
}

#[derive(Debug, Default)]
struct RawResult {
    fields: Vec<Field>,
    row_descriptions: usize,
    rows: Vec<Vec<Option<String>>>,
    tags: Vec<String>,
    errors: Vec<BTreeMap<char, String>>,
    notices: Vec<BTreeMap<char, String>>,
    other: Vec<String>,
    ready: Option<char>,
    elapsed: Duration,
    first_row_at: Option<Duration>,
}

struct Raw {
    stream: TcpStream,
    pid: Option<i32>,
    secret: Option<i32>,
}

struct Msg {
    kind: u8,
    body: Vec<u8>,
}

fn cstr(body: &[u8], pos: &mut usize) -> String {
    let start = *pos;
    while *pos < body.len() && body[*pos] != 0 {
        *pos += 1;
    }
    let s = String::from_utf8_lossy(&body[start..*pos]).into_owned();
    *pos += 1;
    s
}

fn i16_at(body: &[u8], pos: &mut usize) -> i16 {
    let v = i16::from_be_bytes([body[*pos], body[*pos + 1]]);
    *pos += 2;
    v
}

fn i32_at(body: &[u8], pos: &mut usize) -> i32 {
    let v = i32::from_be_bytes([body[*pos], body[*pos + 1], body[*pos + 2], body[*pos + 3]]);
    *pos += 4;
    v
}

fn fields_of(body: &[u8]) -> BTreeMap<char, String> {
    let mut out = BTreeMap::new();
    let mut pos = 0;
    while pos < body.len() && body[pos] != 0 {
        let code = body[pos] as char;
        pos += 1;
        out.insert(code, cstr(body, &mut pos));
    }
    out
}

impl Raw {
    async fn read_msg(&mut self) -> Result<Msg, AnyError> {
        let kind = self.stream.read_u8().await?;
        let len = self.stream.read_i32().await?;
        let mut body = vec![0u8; usize::try_from(len - 4)?];
        self.stream.read_exact(&mut body).await?;
        Ok(Msg { kind, body })
    }

    /// Opens a socket and runs the startup handshake. Returns the connection
    /// and a description of every message the server sent before it was ready.
    async fn connect(port: u16, params: &[(&str, &str)]) -> Result<(Self, Vec<String>), AnyError> {
        let stream = TcpStream::connect(("127.0.0.1", port)).await?;
        let mut raw = Self {
            stream,
            pid: None,
            secret: None,
        };
        let mut body = Vec::new();
        body.extend_from_slice(&196_608i32.to_be_bytes()); // protocol 3.0
        for (k, v) in params {
            body.extend_from_slice(k.as_bytes());
            body.push(0);
            body.extend_from_slice(v.as_bytes());
            body.push(0);
        }
        body.push(0);
        let mut frame = Vec::new();
        frame.extend_from_slice(&i32::try_from(body.len() + 4)?.to_be_bytes());
        frame.extend_from_slice(&body);
        raw.stream.write_all(&frame).await?;

        let mut seen = Vec::new();
        loop {
            let msg = raw.read_msg().await?;
            let mut pos = 0;
            match msg.kind {
                b'R' => {
                    let code = i32_at(&msg.body, &mut pos);
                    seen.push(format!("Authentication code={code} (0 = AuthenticationOk)"));
                }
                b'S' => {
                    let k = cstr(&msg.body, &mut pos);
                    let v = cstr(&msg.body, &mut pos);
                    seen.push(format!("ParameterStatus {k}={v}"));
                }
                b'K' => {
                    let pid = i32_at(&msg.body, &mut pos);
                    let secret = i32_at(&msg.body, &mut pos);
                    raw.pid = Some(pid);
                    raw.secret = Some(secret);
                    seen.push(format!("BackendKeyData pid={pid} secret={secret}"));
                }
                b'N' => seen.push(format!("NoticeResponse {:?}", fields_of(&msg.body))),
                b'E' => {
                    seen.push(format!("ErrorResponse {:?}", fields_of(&msg.body)));
                    break;
                }
                b'Z' => {
                    seen.push(format!("ReadyForQuery status={}", msg.body[0] as char));
                    break;
                }
                other => seen.push(format!(
                    "message '{}' ({} bytes)",
                    other as char,
                    msg.body.len()
                )),
            }
        }
        Ok((raw, seen))
    }

    async fn send(&mut self, kind: u8, body: &[u8]) -> Result<(), AnyError> {
        let mut frame = vec![kind];
        frame.extend_from_slice(&i32::try_from(body.len() + 4)?.to_be_bytes());
        frame.extend_from_slice(body);
        self.stream.write_all(&frame).await?;
        Ok(())
    }

    /// Reads backend messages until ReadyForQuery.
    async fn collect(&mut self, started: Instant) -> Result<RawResult, AnyError> {
        let mut res = RawResult::default();
        loop {
            let msg = self.read_msg().await?;
            let mut pos = 0;
            match msg.kind {
                b'T' => {
                    res.row_descriptions += 1;
                    let n = i16_at(&msg.body, &mut pos);
                    res.fields.clear();
                    for _ in 0..n {
                        let name = cstr(&msg.body, &mut pos);
                        let table_oid = i32_at(&msg.body, &mut pos).cast_unsigned();
                        let attnum = i16_at(&msg.body, &mut pos);
                        let type_oid = i32_at(&msg.body, &mut pos).cast_unsigned();
                        let typlen = i16_at(&msg.body, &mut pos);
                        let typmod = i32_at(&msg.body, &mut pos);
                        let format = i16_at(&msg.body, &mut pos);
                        res.fields.push(Field {
                            name,
                            table_oid,
                            attnum,
                            type_oid,
                            typlen,
                            typmod,
                            format,
                        });
                    }
                }
                b'D' => {
                    res.first_row_at.get_or_insert(started.elapsed());
                    let n = i16_at(&msg.body, &mut pos);
                    let mut row = Vec::new();
                    for _ in 0..n {
                        let len = i32_at(&msg.body, &mut pos);
                        if len < 0 {
                            row.push(None);
                        } else {
                            let len = usize::try_from(len)?;
                            let bytes = &msg.body[pos..pos + len];
                            pos += len;
                            row.push(Some(String::from_utf8_lossy(bytes).into_owned()));
                        }
                    }
                    res.rows.push(row);
                }
                b'C' => res.tags.push(cstr(&msg.body, &mut pos)),
                b'E' => res.errors.push(fields_of(&msg.body)),
                b'N' => res.notices.push(fields_of(&msg.body)),
                b'I' => res.other.push("EmptyQueryResponse".into()),
                b'1' => res.other.push("ParseComplete".into()),
                b'2' => res.other.push("BindComplete".into()),
                b'3' => res.other.push("CloseComplete".into()),
                b'n' => res.other.push("NoData".into()),
                b't' => {
                    let n = i16_at(&msg.body, &mut pos);
                    let oids: Vec<i32> = (0..n).map(|_| i32_at(&msg.body, &mut pos)).collect();
                    res.other.push(format!("ParameterDescription {oids:?}"));
                }
                b's' => res.other.push("PortalSuspended".into()),
                b'Z' => {
                    res.ready = Some(msg.body[0] as char);
                    break;
                }
                other => res.other.push(format!("message '{}'", other as char)),
            }
        }
        res.elapsed = started.elapsed();
        Ok(res)
    }

    async fn simple(&mut self, sql: &str) -> Result<RawResult, AnyError> {
        let started = Instant::now();
        let mut body = sql.as_bytes().to_vec();
        body.push(0);
        self.send(b'Q', &body).await?;
        self.collect(started).await
    }
}

fn clip(s: &str, max: usize) -> String {
    let flat = s.replace(['\r', '\n'], " ");
    if flat.chars().count() > max {
        let head: String = flat.chars().take(max).collect();
        format!("{head}... [{} chars]", flat.chars().count())
    } else {
        flat
    }
}

fn print_result(sql: &str, res: &RawResult, sample_rows: usize) {
    println!("\n> {}", clip(sql, 200));
    println!(
        "  elapsed {:.0} ms, first row at {}, RowDescription messages {}, rows {}, tags {:?}, ready {:?}",
        res.elapsed.as_secs_f64() * 1000.0,
        res.first_row_at.map_or("-".to_string(), |d| format!(
            "{:.0} ms",
            d.as_secs_f64() * 1000.0
        )),
        res.row_descriptions,
        res.rows.len(),
        res.tags,
        res.ready
    );
    for f in &res.fields {
        println!(
            "  column {:<16} type_oid={:<5} typlen={:<3} typmod={:<3} format={} table_oid={} attnum={}",
            f.name, f.type_oid, f.typlen, f.typmod, f.format, f.table_oid, f.attnum
        );
    }
    for row in res.rows.iter().take(sample_rows) {
        let cells: Vec<String> = row
            .iter()
            .map(|c| c.as_ref().map_or("NULL".to_string(), |v| clip(v, 60)))
            .collect();
        println!("  row    {cells:?}");
    }
    for e in &res.errors {
        let shown: BTreeMap<char, String> = e.iter().map(|(k, v)| (*k, clip(v, 240))).collect();
        println!("  ERROR  {shown:?}");
    }
    for n in &res.notices {
        let shown: BTreeMap<char, String> = n.iter().map(|(k, v)| (*k, clip(v, 240))).collect();
        println!("  NOTICE {shown:?}");
    }
    if !res.other.is_empty() {
        println!("  other  {:?}", res.other);
    }
}

fn print_server_log(server: &Server, mark: usize) -> usize {
    let (lines, next) = server.log_since(mark);
    for line in lines.iter().take(12) {
        println!("  srv    {}", clip(line, 260));
    }
    if lines.len() > 12 {
        println!("  srv    ... {} more lines", lines.len() - 12);
    }
    next
}

async fn pg(port: u16) -> Result<(tokio_postgres::Client, Arc<Mutex<Vec<String>>>), AnyError> {
    let mut cfg = Config::new();
    cfg.host("127.0.0.1")
        .port(port)
        .user("stackql")
        .dbname("stackql")
        .application_name("stackql-workbench-spike")
        .connect_timeout(Duration::from_secs(5));
    let (client, mut connection) = cfg.connect(NoTls).await?;
    let notices: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = notices.clone();
    tokio::spawn(async move {
        // Drive the connection through poll_message so notices are visible.
        let mut messages = futures_util::stream::poll_fn(move |cx| connection.poll_message(cx));
        while let Some(msg) = messages.next().await {
            match msg {
                Ok(AsyncMessage::Notice(n)) => sink.lock().unwrap().push(format!(
                    "severity={} code={} message={}",
                    n.severity(),
                    n.code().code(),
                    n.message()
                )),
                Ok(_) => {}
                Err(e) => {
                    sink.lock().unwrap().push(format!("connection error: {e}"));
                    break;
                }
            }
        }
    });
    Ok((client, notices))
}

fn describe_pg_error(e: &tokio_postgres::Error) -> String {
    match e.as_db_error() {
        Some(db) => format!(
            "DbError severity={} code={} message={:?} detail={:?} hint={:?} position={:?} where={:?} routine={:?}",
            db.severity(),
            db.code().code(),
            clip(db.message(), 200),
            db.detail().map(|d| clip(d, 120)),
            db.hint(),
            db.position(),
            db.where_(),
            db.routine()
        ),
        None => format!("non-db error: {e} (closed={})", e.is_closed()),
    }
}

fn union_of(names: &[&str]) -> String {
    names
        .iter()
        .map(|n| format!("SELECT name FROM homebrew.formula.formula WHERE formula_name = '{n}'"))
        .collect::<Vec<_>>()
        .join(" UNION ALL ")
}

// --- sections ---------------------------------------------------------------

async fn section_readiness(bin: &PathBuf, approot: &PathBuf) -> Result<(), AnyError> {
    println!("\n== readiness ==");
    for run in 1..=5 {
        let mut server = Server::start(bin, approot, &[]).await?;
        let mut tcp_at = None;
        let mut ready_at = None;
        let mut query_at = None;
        let mut attempts = 0u32;
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            attempts += 1;
            // Bound each attempt: on Windows a refused loopback connect is retried
            // by the OS for about half a second, which would hide the real figure.
            let attempt = tokio::time::timeout(
                Duration::from_millis(40),
                TcpStream::connect(("127.0.0.1", server.port)),
            )
            .await;
            if matches!(attempt, Ok(Ok(_))) {
                tcp_at.get_or_insert(server.started.elapsed());
                if let Ok((mut raw, _)) = Raw::connect(server.port, &[("user", "stackql")]).await {
                    ready_at.get_or_insert(server.started.elapsed());
                    if let Ok(res) = raw.simple("SHOW VERSION").await
                        && res.errors.is_empty()
                        && !res.rows.is_empty()
                    {
                        query_at = Some(server.started.elapsed());
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let ms = |d: Option<Duration>| {
            d.map_or("never".to_string(), |d| {
                format!("{:.0} ms", d.as_secs_f64() * 1000.0)
            })
        };
        println!(
            "run {run}: tcp accept {}, handshake ready {}, first SHOW VERSION result {}, attempts {attempts}",
            ms(tcp_at),
            ms(ready_at),
            ms(query_at)
        );
        if run == 1 {
            print_server_log(&server, 0);
        }
        server.child.kill().await?;
    }
    Ok(())
}

async fn section_handshake(server: &Server) -> Result<(), AnyError> {
    println!("\n== startup, auth and TLS negotiation ==");

    // SSLRequest: length 8, code 80877103. The reply is one byte.
    let mut s = TcpStream::connect(("127.0.0.1", server.port)).await?;
    let mut frame = Vec::new();
    frame.extend_from_slice(&8i32.to_be_bytes());
    frame.extend_from_slice(&80_877_103i32.to_be_bytes());
    s.write_all(&frame).await?;
    let mut reply = [0u8; 1];
    match tokio::time::timeout(Duration::from_secs(3), s.read_exact(&mut reply)).await {
        Ok(Ok(_)) => println!(
            "SSLRequest reply: '{}' (S = TLS, N = no TLS)",
            reply[0] as char
        ),
        Ok(Err(e)) => println!("SSLRequest reply: read error {e}"),
        Err(_) => println!("SSLRequest reply: none within 3 s"),
    }

    for params in [
        vec![("user", "stackql"), ("database", "stackql")],
        vec![("user", "anyone")],
        vec![
            ("user", "stackql"),
            ("database", "nonexistent_db"),
            ("application_name", "spike"),
            ("client_encoding", "UTF8"),
        ],
        vec![],
    ] {
        match Raw::connect(server.port, &params).await {
            Ok((_, seen)) => {
                println!("startup params {params:?}:");
                for line in seen {
                    println!("  {line}");
                }
            }
            Err(e) => println!("startup params {params:?}: failed: {e}"),
        }
    }

    // A password is not requested, so check that one is not required either.
    let mut cfg = Config::new();
    cfg.host("127.0.0.1").port(server.port).user("stackql");
    match cfg.connect(NoTls).await {
        Ok((client, connection)) => {
            println!(
                "tokio-postgres connect (user only, NoTls): ok, server_version={:?}, client_encoding={:?}",
                connection.parameter("server_version"),
                connection.parameter("client_encoding")
            );
            tokio::spawn(connection);
            println!("  is_closed={}", client.is_closed());
        }
        Err(e) => println!("tokio-postgres connect failed: {}", describe_pg_error(&e)),
    }
    Ok(())
}

async fn section_metadata(server: &Server) -> Result<(), AnyError> {
    println!("\n== metadata statements: column names, types and shapes ==");
    let (mut raw, _) = Raw::connect(server.port, &[("user", "stackql")]).await?;
    let statements = [
        "SHOW VERSION",
        "SHOW EXTENDED VERSION",
        "SHOW PROVIDERS",
        "SHOW EXTENDED PROVIDERS",
        "REGISTRY LIST",
        "REGISTRY PULL homebrew",
        "REGISTRY PULL github",
        "SHOW PROVIDERS",
        "SHOW SERVICES IN homebrew",
        "SHOW EXTENDED SERVICES IN homebrew",
        "SHOW SERVICES IN github LIKE '%repo%'",
        "SHOW RESOURCES IN homebrew.formula",
        "SHOW EXTENDED RESOURCES IN homebrew.formula",
        "SHOW METHODS IN homebrew.formula.formula",
        "SHOW EXTENDED METHODS IN homebrew.formula.formula",
        "SHOW EXTENDED METHODS IN github.repos.repos",
        "DESCRIBE homebrew.formula.formula",
        "DESCRIBE EXTENDED homebrew.formula.formula",
        "DESCRIBE METHOD homebrew.formula.formula.get_formula",
        "DESCRIBE EXTENDED METHOD homebrew.formula.formula.get_formula",
        "DESCRIBE METHOD EXTENDED homebrew.formula.formula.get_formula",
        "DESCRIBE homebrew.formula.vw_versions",
    ];
    for sql in statements {
        let mark = server.mark();
        let res = raw.simple(sql).await?;
        print_result(sql, &res, 3);
        print_server_log(server, mark);
    }
    Ok(())
}

async fn section_values(server: &Server) -> Result<(), AnyError> {
    println!("\n== value types: are values text? ==");
    let (mut raw, _) = Raw::connect(server.port, &[("user", "stackql")]).await?;
    for sql in [
        "SELECT 1 AS one, 'x' AS s, 1.5 AS f, NULL AS n, 1 = 1 AS b",
        "SELECT name, deprecated, versions, aliases, revision, tap FROM homebrew.formula.formula WHERE formula_name = 'wget'",
        "SELECT name, id, private, stargazers_count, created_at, owner, topics, license FROM github.repos.repos WHERE org = 'stackql' LIMIT 2",
        "SELECT count(*) AS n FROM github.repos.repos WHERE org = 'stackql'",
        "SELECT name FROM homebrew.formula.formula WHERE formula_name = 'wget' AND 1 = 0",
    ] {
        let res = raw.simple(sql).await?;
        print_result(sql, &res, 2);
    }
    Ok(())
}

async fn section_protocols(server: &Server) -> Result<(), AnyError> {
    println!("\n== query protocols ==");
    let (client, notices) = pg(server.port).await?;

    println!("-- simple protocol through tokio-postgres");
    match client.simple_query("SHOW PROVIDERS").await {
        Ok(msgs) => {
            for m in &msgs {
                match m {
                    SimpleQueryMessage::RowDescription(cols) => println!(
                        "  RowDescription {:?}",
                        cols.iter()
                            .map(|c| c.name().to_string())
                            .collect::<Vec<_>>()
                    ),
                    SimpleQueryMessage::Row(r) => println!(
                        "  Row {:?}",
                        (0..r.len()).map(|i| r.get(i)).collect::<Vec<_>>()
                    ),
                    SimpleQueryMessage::CommandComplete(n) => println!("  CommandComplete {n}"),
                    _ => println!("  other message"),
                }
            }
        }
        Err(e) => println!("  simple_query failed: {}", describe_pg_error(&e)),
    }

    println!("-- simple protocol, several statements in one message");
    let (mut raw, _) = Raw::connect(server.port, &[("user", "stackql")]).await?;
    for sql in [
        "SHOW VERSION; SHOW PROVIDERS;",
        "SHOW VERSION; SELEC 1; SHOW PROVIDERS;",
        "",
        ";",
        "-- only a comment",
        "SHOW VERSION -- trailing comment",
        "SHOW VERSION;",
    ] {
        let res = raw.simple(sql).await?;
        print_result(sql, &res, 1);
    }

    println!("-- simple_query_raw: do rows arrive incrementally?");
    let started = Instant::now();
    match client.simple_query_raw(&union_of(&FORMULAS[..12])).await {
        Ok(stream) => {
            let mut stream = std::pin::pin!(stream);
            while let Some(item) = stream.next().await {
                let at = started.elapsed().as_millis();
                match item {
                    Ok(SimpleQueryMessage::RowDescription(_)) => {
                        println!("  {at:>5} ms RowDescription")
                    }
                    Ok(SimpleQueryMessage::Row(r)) => println!("  {at:>5} ms Row {:?}", r.get(0)),
                    Ok(SimpleQueryMessage::CommandComplete(n)) => {
                        println!("  {at:>5} ms CommandComplete {n}");
                    }
                    Ok(_) => println!("  {at:>5} ms other"),
                    Err(e) => println!("  {at:>5} ms error {}", describe_pg_error(&e)),
                }
            }
        }
        Err(e) => println!("  simple_query_raw failed: {}", describe_pg_error(&e)),
    }

    println!("-- extended protocol: prepare (Parse, Describe, Sync)");
    for sql in [
        "SHOW PROVIDERS",
        "SELECT name, versions FROM homebrew.formula.formula WHERE formula_name = 'wget'",
        "SELECT name FROM homebrew.formula.formula WHERE formula_name = $1",
    ] {
        match tokio::time::timeout(Duration::from_secs(20), client.prepare(sql)).await {
            Ok(Ok(stmt)) => println!(
                "  prepare ok: {} -> params {:?}, columns {:?}",
                clip(sql, 80),
                stmt.params(),
                stmt.columns()
                    .iter()
                    .map(|c| format!("{}:{}", c.name(), c.type_()))
                    .collect::<Vec<_>>()
            ),
            Ok(Err(e)) => println!(
                "  prepare failed: {} -> {}",
                clip(sql, 80),
                describe_pg_error(&e)
            ),
            Err(_) => println!("  prepare timed out: {}", clip(sql, 80)),
        }
    }

    println!("-- extended protocol: query without parameters");
    match tokio::time::timeout(Duration::from_secs(20), client.query("SHOW PROVIDERS", &[])).await {
        Ok(Ok(rows)) => {
            println!("  query ok: {} rows", rows.len());
            for row in rows.iter().take(2) {
                let cols: Vec<String> = row
                    .columns()
                    .iter()
                    .enumerate()
                    .map(|(i, c)| {
                        let v: Result<Option<String>, _> = row.try_get(i);
                        format!("{}:{}={v:?}", c.name(), c.type_())
                    })
                    .collect();
                println!("  row {cols:?}");
            }
        }
        Ok(Err(e)) => println!("  query failed: {}", describe_pg_error(&e)),
        Err(_) => println!("  query timed out"),
    }

    println!("-- extended protocol: query with a text parameter");
    let sql = "SELECT name, full_name FROM homebrew.formula.formula WHERE formula_name = $1";
    match tokio::time::timeout(Duration::from_secs(20), client.query(sql, &[&"jq"])).await {
        Ok(Ok(rows)) => {
            println!("  query ok: {} rows", rows.len());
            for row in &rows {
                let v: Result<Option<String>, _> = row.try_get(0);
                println!("  row name={v:?}");
            }
        }
        Ok(Err(e)) => println!("  query failed: {}", describe_pg_error(&e)),
        Err(_) => println!("  query timed out"),
    }

    println!("-- extended protocol: query_typed (no separate prepare round trip)");
    let typed = client
        .query_typed(sql, &[(&"wget", tokio_postgres::types::Type::TEXT)])
        .await;
    match typed {
        Ok(rows) => println!("  query_typed ok: {} rows", rows.len()),
        Err(e) => println!("  query_typed failed: {}", describe_pg_error(&e)),
    }

    println!("-- raw extended protocol frames for one statement");
    let (mut raw, _) = Raw::connect(server.port, &[("user", "stackql")]).await?;
    let started = Instant::now();
    let mut parse = Vec::new();
    parse.push(0); // unnamed statement
    parse.extend_from_slice(b"SHOW PROVIDERS\0");
    parse.extend_from_slice(&0i16.to_be_bytes());
    raw.send(b'P', &parse).await?;
    raw.send(b'D', b"S\0").await?; // describe statement
    let mut bind = vec![0, 0]; // unnamed portal, unnamed statement
    bind.extend_from_slice(&0i16.to_be_bytes()); // parameter format codes
    bind.extend_from_slice(&0i16.to_be_bytes()); // parameters
    bind.extend_from_slice(&0i16.to_be_bytes()); // result format codes
    raw.send(b'B', &bind).await?;
    raw.send(b'D', b"P\0").await?; // describe portal
    let mut exec = vec![0];
    exec.extend_from_slice(&0i32.to_be_bytes());
    raw.send(b'E', &exec).await?;
    raw.send(b'S', &[]).await?;
    match tokio::time::timeout(Duration::from_secs(10), raw.collect(started)).await {
        Ok(Ok(res)) => print_result(
            "Parse/Describe/Bind/Describe/Execute/Sync SHOW PROVIDERS",
            &res,
            2,
        ),
        Ok(Err(e)) => println!("  raw extended failed: {e}"),
        Err(_) => println!("  raw extended timed out"),
    }

    println!(
        "notices seen on the tokio-postgres connection: {:?}",
        notices.lock().unwrap()
    );
    Ok(())
}

async fn section_errors(server: &Server) -> Result<(), AnyError> {
    println!("\n== errors: fields and codes ==");
    let (mut raw, _) = Raw::connect(server.port, &[("user", "stackql")]).await?;
    let statements = [
        "SELEC 1",
        "SHOW SERVICES IN nosuchprovider",
        "SHOW RESOURCES IN homebrew.nosuchservice",
        "SELECT * FROM homebrew.nosuch.thing WHERE x = 1",
        "SELECT name FROM homebrew.formula.formula",
        "SELECT nosuchcolumn FROM homebrew.formula.formula WHERE formula_name = 'wget'",
        "DESCRIBE homebrew.formula.nosuchresource",
        "REGISTRY PULL nosuchprovider",
    ];
    for sql in statements {
        let mark = server.mark();
        let res = raw.simple(sql).await?;
        print_result(sql, &res, 1);
        print_server_log(server, mark);
    }
    let res = raw.simple("SHOW VERSION").await?;
    println!(
        "\nconnection still usable after the errors: {}",
        res.errors.is_empty() && res.rows.len() == 1
    );

    println!("-- the same errors through tokio-postgres");
    let (client, notices) = pg(server.port).await?;
    for sql in ["SELEC 1", "SHOW SERVICES IN nosuchprovider"] {
        match client.simple_query(sql).await {
            Ok(m) => println!("  {sql}: ok with {} messages", m.len()),
            Err(e) => println!("  {sql}: {}", describe_pg_error(&e)),
        }
    }
    println!("  client.is_closed after errors: {}", client.is_closed());
    println!("  notices: {:?}", notices.lock().unwrap());
    Ok(())
}

async fn section_upstream(bin: &PathBuf, approot: &PathBuf) -> Result<(), AnyError> {
    println!("\n== upstream provider failures ==");
    for (label, extra) in [
        ("default flags", vec![]),
        ("--pgsrv.debug.enable", vec!["--pgsrv.debug.enable"]),
        ("--pgsrv.loglevel DEBUG", vec!["--pgsrv.loglevel", "DEBUG"]),
        ("--http.log.enabled", vec!["--http.log.enabled"]),
    ] {
        println!("\n-- server started with {label}");
        let mut server = Server::start(bin, approot, &extra).await?;
        wait_ready(&server).await?;
        let (mut raw, _) = Raw::connect(server.port, &[("user", "stackql")]).await?;
        let (client, notices) = pg(server.port).await?;
        for sql in [
            // 404 from the upstream API.
            "SELECT name FROM homebrew.formula.formula WHERE formula_name = 'no-such-formula-xyz-123'",
            // One good branch and one failing branch.
            "SELECT name FROM homebrew.formula.formula WHERE formula_name = 'wget' UNION ALL SELECT name FROM homebrew.formula.formula WHERE formula_name = 'no-such-formula-xyz-123'",
            // A provider that needs credentials for this resource, none configured.
            "SELECT login FROM github.users.users",
            "SELECT id FROM github.repos.repos WHERE org = 'no-such-org-xyz-9871236'",
        ] {
            let mark = server.mark();
            let res = raw.simple(sql).await?;
            print_result(sql, &res, 2);
            print_server_log(&server, mark);
            match client.simple_query(sql).await {
                Ok(m) => println!("  tokio-postgres: ok with {} messages", m.len()),
                Err(e) => println!("  tokio-postgres: {}", describe_pg_error(&e)),
            }
        }
        println!(
            "  notices via tokio-postgres poll_message: {:?}",
            notices.lock().unwrap()
        );
        server.child.kill().await?;
    }
    Ok(())
}

async fn section_concurrency(server: &Server) -> Result<(), AnyError> {
    println!("\n== concurrent connections ==");
    let mut conns = Vec::new();
    for _ in 0..4 {
        let (raw, _) = Raw::connect(server.port, &[("user", "stackql")]).await?;
        conns.push(raw);
    }
    println!(
        "backend key data per connection: {:?}",
        conns.iter().map(|c| (c.pid, c.secret)).collect::<Vec<_>>()
    );

    // The same slow statement alone, then on four connections at once.
    let slow = union_of(&FORMULAS[..8]);
    let alone = conns[0].simple(&slow).await?;
    println!(
        "one connection, 8 upstream calls: {:.0} ms, rows {}",
        alone.elapsed.as_secs_f64() * 1000.0,
        alone.rows.len()
    );

    let started = Instant::now();
    let results = future::join_all(conns.iter_mut().enumerate().map(|(i, c)| {
        let sql = union_of(&FORMULAS[i * 8..i * 8 + 8]);
        async move { (i, c.simple(&sql).await) }
    }))
    .await;
    println!(
        "four connections at once, wall time {:.0} ms",
        started.elapsed().as_secs_f64() * 1000.0
    );
    for (i, res) in results {
        let res = res?;
        let names: Vec<String> = res.rows.iter().filter_map(|r| r[0].clone()).collect();
        println!(
            "  conn {i}: {:.0} ms, rows {}, correct rows {}, errors {}",
            res.elapsed.as_secs_f64() * 1000.0,
            res.rows.len(),
            names == FORMULAS[i * 8..i * 8 + 8],
            res.errors.len()
        );
    }

    // A fast metadata statement while another connection is busy.
    let (mut a, mut b) = {
        let mut it = conns.into_iter();
        (it.next().unwrap(), it.next().unwrap())
    };
    let started = Instant::now();
    let slow = union_of(&FORMULAS[20..40]);
    let (slow_res, fast_res) = tokio::join!(a.simple(&slow), async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let res = b.simple("SHOW PROVIDERS").await;
        (res, started.elapsed())
    });
    let slow_res = slow_res?;
    let (fast_res, fast_done) = fast_res;
    let fast_res = fast_res?;
    println!(
        "metadata statement issued 300 ms into a {:.0} ms statement on another connection: finished at {:.0} ms (took {:.0} ms)",
        slow_res.elapsed.as_secs_f64() * 1000.0,
        fast_done.as_secs_f64() * 1000.0,
        fast_res.elapsed.as_secs_f64() * 1000.0
    );

    println!("-- session independence");
    // An error on one connection must not affect another.
    let bad = a.simple("SELEC 1").await?;
    let good = b.simple("SHOW VERSION").await?;
    println!(
        "error on A (errors {}), then B still fine: {}",
        bad.errors.len(),
        good.errors.is_empty() && good.rows.len() == 1
    );
    // Session-scoped settings, if the engine accepts them.
    for sql in [
        "SET SESSION \"$.auth.github.type\" = 'null_auth'",
        "SHOW TRANSACTION ISOLATION LEVEL",
        "BEGIN",
        "COMMIT",
        "CREATE TABLE spike_t (id int)",
        "SELECT * FROM spike_t",
    ] {
        let res = a.simple(sql).await?;
        print_result(&format!("[A] {sql}"), &res, 2);
    }
    let res = b.simple("SELECT * FROM spike_t").await?;
    print_result("[B] SELECT * FROM spike_t", &res, 2);
    // Closing one connection must not affect the other.
    drop(a);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let res = b.simple("SHOW VERSION").await?;
    println!(
        "B after A closed: rows {}, errors {}",
        res.rows.len(),
        res.errors.len()
    );
    Ok(())
}

/// Counts upstream HTTP requests the engine logged, split at `cut`.
fn http_calls(server: &Server, mark: usize, cut: Duration) -> (usize, usize) {
    let log = server.log.lock().unwrap();
    let mut before = 0;
    let mut after = 0;
    for (at, _, line) in &log[mark..] {
        if line.contains("http request url")
            || line.contains("http request") && line.contains("GET")
        {
            if *at <= cut {
                before += 1;
            } else {
                after += 1;
            }
        }
    }
    (before, after)
}

async fn section_cancel(bin: &PathBuf, approot: &PathBuf) -> Result<(), AnyError> {
    println!("\n== cancel ==");
    // --http.log.enabled makes the engine log each upstream request, which shows
    // whether work continues after a cancel or a dropped connection.
    let mut server = Server::start(bin, approot, &["--http.log.enabled"]).await?;
    wait_ready(&server).await?;
    let slow = union_of(FORMULAS);
    let cancel_after = Duration::from_millis(250);

    println!(
        "-- baseline: {} upstream calls, not cancelled",
        FORMULAS.len()
    );
    let (mut raw, seen) = Raw::connect(server.port, &[("user", "stackql")]).await?;
    println!(
        "  BackendKeyData in handshake: {}",
        seen.iter().any(|l| l.starts_with("BackendKeyData"))
    );
    let mark = server.mark();
    let base = raw.simple(&slow).await?;
    let (lines, _) = server.log_since(mark);
    println!(
        "  elapsed {:.0} ms, first row at {:?} ms, rows {}, errors {}, engine log lines {}",
        base.elapsed.as_secs_f64() * 1000.0,
        base.first_row_at.map(|d| d.as_millis()),
        base.rows.len(),
        base.errors.len(),
        lines.len()
    );
    for line in lines.iter().take(3) {
        println!("  srv    {}", clip(line, 200));
    }

    println!(
        "-- tokio-postgres cancel_token().cancel_query sent {} ms in",
        cancel_after.as_millis()
    );
    let (client, _) = pg(server.port).await?;
    let token = client.cancel_token();
    let mark = server.mark();
    let cut = server.started.elapsed() + cancel_after;
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(cancel_after).await;
        token.cancel_query(NoTls).await.map_err(|e| e.to_string())
    });
    let started = Instant::now();
    let outcome = client.simple_query(&slow).await;
    let elapsed = started.elapsed();
    println!("  cancel_query result: {:?}", canceller.await?);
    match outcome {
        Ok(msgs) => println!(
            "  statement completed normally in {:.0} ms with {} messages",
            elapsed.as_secs_f64() * 1000.0,
            msgs.len()
        ),
        Err(e) => println!(
            "  statement failed after {:.0} ms: {}",
            elapsed.as_secs_f64() * 1000.0,
            describe_pg_error(&e)
        ),
    }
    let (before, after) = http_calls(&server, mark, cut);
    println!("  upstream requests logged before the cancel: {before}, after: {after}");

    println!(
        "-- closing the client socket {} ms into the statement",
        cancel_after.as_millis()
    );
    let (mut raw, _) = Raw::connect(server.port, &[("user", "stackql")]).await?;
    let mut body = slow.as_bytes().to_vec();
    body.push(0);
    let mark = server.mark();
    let cut = server.started.elapsed() + cancel_after;
    raw.send(b'Q', &body).await?;
    tokio::time::sleep(cancel_after).await;
    drop(raw);
    // Give the engine time to finish, or not, whatever it was doing.
    tokio::time::sleep(base.elapsed + Duration::from_secs(2)).await;
    let (before, after) = http_calls(&server, mark, cut);
    println!("  upstream requests logged before the close: {before}, after: {after}");
    let (mut probe, _) = Raw::connect(server.port, &[("user", "stackql")]).await?;
    let res = probe.simple("SHOW VERSION").await?;
    println!(
        "  engine still serving new connections: {}",
        res.rows.len() == 1
    );

    println!(
        "-- dropping the tokio-postgres client {} ms into the statement",
        cancel_after.as_millis()
    );
    let (client, _) = pg(server.port).await?;
    let mark = server.mark();
    let cut = server.started.elapsed() + cancel_after;
    let slow_owned = slow.clone();
    let task = tokio::spawn(async move { client.simple_query(&slow_owned).await.map(|m| m.len()) });
    tokio::time::sleep(cancel_after).await;
    task.abort();
    tokio::time::sleep(base.elapsed + Duration::from_secs(2)).await;
    let (before, after) = http_calls(&server, mark, cut);
    println!("  upstream requests logged before the drop: {before}, after: {after}");

    server.child.kill().await?;
    Ok(())
}

async fn section_notices(bin: &PathBuf, approot: &PathBuf) -> Result<(), AnyError> {
    println!("\n== notices under --pgsrv.debug.enable ==");
    let mut server = Server::start(bin, approot, &["--pgsrv.debug.enable"]).await?;
    wait_ready(&server).await?;
    let bad1 =
        "SELECT name FROM homebrew.formula.formula WHERE formula_name = 'no-such-formula-aaa'";
    let bad2 = "SELECT id FROM github.repos.repos WHERE org = 'no-such-org-xyz-9871236'";
    let good = "SELECT name FROM homebrew.formula.formula WHERE formula_name = 'wget'";
    let summarise = |label: &str, res: &RawResult| {
        let details: Vec<String> = res
            .notices
            .iter()
            .map(|n| {
                let d = n.get(&'D').cloned().unwrap_or_default();
                format!(
                    "detail {} chars, 'status code' occurrences {}, starts {:?}",
                    d.chars().count(),
                    d.matches("http response status code").count(),
                    clip(&d, 48)
                )
            })
            .collect();
        println!(
            "  {label}: rows {}, tags {:?}, errors {}, notices {} {:?}",
            res.rows.len(),
            res.tags,
            res.errors.len(),
            res.notices.len(),
            details
        );
    };
    let (mut a, _) = Raw::connect(server.port, &[("user", "stackql")]).await?;
    let (mut b, _) = Raw::connect(server.port, &[("user", "stackql")]).await?;
    summarise("A SHOW PROVIDERS", &a.simple("SHOW PROVIDERS").await?);
    summarise("A good select", &a.simple(good).await?);
    summarise("A failing select 1", &a.simple(bad1).await?);
    summarise("A SHOW PROVIDERS", &a.simple("SHOW PROVIDERS").await?);
    summarise("A good select", &a.simple(good).await?);
    summarise("A failing select 2", &a.simple(bad2).await?);
    summarise("A syntax error", &a.simple("SELEC 1").await?);
    summarise("A REGISTRY LIST", &a.simple("REGISTRY LIST").await?);
    summarise(
        "B failing select 2 (fresh connection)",
        &b.simple(bad2).await?,
    );
    summarise("B SHOW PROVIDERS", &b.simple("SHOW PROVIDERS").await?);
    let (mut c, _) = Raw::connect(server.port, &[("user", "stackql")]).await?;
    summarise(
        "C good select (new connection after failures elsewhere)",
        &c.simple(good).await?,
    );
    let (lines, _) = server.log_since(0);
    println!(
        "  engine stderr/stdout lines captured with the flag on: {}",
        lines.len()
    );
    for line in lines.iter().take(4) {
        println!("  srv    {}", clip(line, 160));
    }
    server.child.kill().await?;
    Ok(())
}

async fn wait_ready(server: &Server) -> Result<(), AnyError> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok((mut raw, _)) = Raw::connect(server.port, &[("user", "stackql")]).await
            && let Ok(res) = raw.simple("SHOW VERSION").await
            && res.errors.is_empty()
            && !res.rows.is_empty()
        {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err("engine did not become ready within 30 s".into());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[tokio::main]
async fn main() -> Result<(), AnyError> {
    let mut bin =
        std::env::var_os("STACKQL_BIN").map_or_else(|| PathBuf::from("stackql"), PathBuf::from);
    let mut approot = std::env::temp_dir().join("stackql-workbench-spike");
    let mut only: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bin" => bin = PathBuf::from(args.next().ok_or("--bin needs a value")?),
            "--approot" => approot = PathBuf::from(args.next().ok_or("--approot needs a value")?),
            "--only" => only = Some(args.next().ok_or("--only needs a value")?),
            other => return Err(format!("unknown argument {other}").into()),
        }
    }
    std::fs::create_dir_all(&approot)?;
    let wants = |name: &str| only.as_deref().is_none_or(|o| o == name);

    let version = Command::new(&bin).arg("--version").output().await?;
    println!(
        "engine: {}",
        String::from_utf8_lossy(&version.stdout)
            .lines()
            .next()
            .unwrap_or("")
    );
    println!("os: {} {}", std::env::consts::OS, std::env::consts::ARCH);

    if wants("readiness") {
        section_readiness(&bin, &approot).await?;
    }

    let mut server = Server::start(&bin, &approot, &[]).await?;
    wait_ready(&server).await?;
    println!(
        "\nserver for the remaining sections: 127.0.0.1:{}",
        server.port
    );

    if wants("handshake") {
        section_handshake(&server).await?;
    }
    if wants("metadata") {
        section_metadata(&server).await?;
    }
    if wants("values") {
        section_values(&server).await?;
    }
    if wants("protocols") {
        section_protocols(&server).await?;
    }
    if wants("errors") {
        section_errors(&server).await?;
    }
    if wants("concurrency") {
        section_concurrency(&server).await?;
    }
    let (lines, _) = server.log_since(0);
    println!("\nserver output lines captured in total: {}", lines.len());
    server.child.kill().await?;

    if wants("cancel") {
        section_cancel(&bin, &approot).await?;
    }
    if wants("upstream") {
        section_upstream(&bin, &approot).await?;
    }
    if wants("notices") {
        section_notices(&bin, &approot).await?;
    }
    Ok(())
}
