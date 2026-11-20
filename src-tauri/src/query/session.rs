//! One pg wire connection to the engine.
//!
//! Simple query protocol only. See `docs/spike-pgwire.md` for why: the
//! extended protocol does not work through `tokio-postgres` against this
//! server.

use std::time::Duration;

use futures_util::StreamExt;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_postgres::config::SslMode;
use tokio_postgres::{AsyncMessage, Client, Config, NoTls, SimpleQueryMessage};

use super::result::{Batcher, Notice, NoticeTracker, QueryError, ResultSet, Row};

/// How long one connect attempt may take. On Windows a connect to a loopback
/// port that is not listening yet is retried inside the OS for about half a
/// second, so each attempt needs its own limit.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);

/// What a statement produces while it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatementEvent {
    Columns(Vec<String>),
    Rows(Vec<Row>),
    Notice(Notice),
}

pub struct PgSession {
    client: Client,
    notices: mpsc::UnboundedReceiver<Notice>,
    tracker: NoticeTracker,
    driver: JoinHandle<()>,
}

impl PgSession {
    /// Connects to the engine on loopback. The server asks for no password
    /// and offers no TLS.
    pub async fn connect(port: u16) -> Result<Self, QueryError> {
        Self::connect_with_timeout(port, CONNECT_TIMEOUT).await
    }

    pub async fn connect_with_timeout(port: u16, limit: Duration) -> Result<Self, QueryError> {
        let mut config = Config::new();
        config
            .host("127.0.0.1")
            .port(port)
            .user("stackql")
            .dbname("stackql")
            .application_name("stackql-workbench")
            .ssl_mode(SslMode::Disable);

        let (client, mut connection) = tokio::time::timeout(limit, config.connect(NoTls))
            .await
            .map_err(|_| QueryError::from_client("Timed out connecting to the engine.", true))?
            .map_err(|err| {
                QueryError::from_client(format!("Could not connect to the engine: {err}"), true)
            })?;

        // The connection has to be polled for anything to happen. Polling it
        // through poll_message, not as a plain future, is what exposes
        // notices.
        let (tx, notices) = mpsc::unbounded_channel();
        let driver = tokio::spawn(async move {
            let mut messages = futures_util::stream::poll_fn(move |cx| connection.poll_message(cx));
            while let Some(message) = messages.next().await {
                match message {
                    Ok(AsyncMessage::Notice(notice)) => {
                        let _ = tx.send(Notice {
                            severity: notice.severity().to_string(),
                            code: notice.code().code().to_string(),
                            message: notice.message().to_string(),
                            detail: notice.detail().map(str::to_string),
                        });
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        });

        Ok(Self {
            client,
            notices,
            tracker: NoticeTracker::default(),
            driver,
        })
    }

    pub fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    /// Runs one statement and reports what it produces through `sink`.
    /// Returns the number of rows.
    ///
    /// Send exactly one statement. The engine ignores anything after the
    /// first statement in a message.
    pub async fn run(
        &mut self,
        sql: &str,
        sink: &mut (dyn FnMut(StatementEvent) + Send),
    ) -> Result<u64, QueryError> {
        let outcome = self.run_inner(sql, sink).await;
        // Notices are delivered on the connection before the statement's
        // final message, so by now they are all in the channel.
        while let Ok(notice) = self.notices.try_recv() {
            if let Some(fresh) = self.tracker.fresh(notice) {
                sink(StatementEvent::Notice(fresh));
            }
        }
        outcome
    }

    async fn run_inner(
        &mut self,
        sql: &str,
        sink: &mut (dyn FnMut(StatementEvent) + Send),
    ) -> Result<u64, QueryError> {
        let stream = self
            .client
            .simple_query_raw(sql)
            .await
            .map_err(|err| map_error(&err))?;
        let mut stream = std::pin::pin!(stream);
        let mut batcher = Batcher::default();

        while let Some(message) = stream.next().await {
            match message.map_err(|err| map_error(&err))? {
                SimpleQueryMessage::RowDescription(columns) => {
                    sink(StatementEvent::Columns(
                        columns.iter().map(|c| c.name().to_string()).collect(),
                    ));
                }
                SimpleQueryMessage::Row(row) => {
                    let mut values = Row::with_capacity(row.len());
                    for index in 0..row.len() {
                        let value = row.try_get(index).map_err(|err| map_error(&err))?;
                        values.push(value.map(str::to_string));
                    }
                    if let Some(batch) = batcher.push(values) {
                        sink(StatementEvent::Rows(batch));
                    }
                }
                // The tag is "OK" with no count, so there is nothing to read
                // from it. Rows are counted by the batcher.
                _ => {}
            }
        }

        if let Some(batch) = batcher.finish() {
            sink(StatementEvent::Rows(batch));
        }
        Ok(batcher.total())
    }

    /// Runs one statement and holds the whole result in memory. For metadata
    /// statements, which are small.
    pub async fn fetch(&mut self, sql: &str) -> Result<ResultSet, QueryError> {
        let mut result = ResultSet::default();
        let mut sink = |event: StatementEvent| match event {
            StatementEvent::Columns(columns) => result.columns = columns,
            StatementEvent::Rows(mut rows) => result.rows.append(&mut rows),
            StatementEvent::Notice(notice) => result.notices.push(notice),
        };
        self.run(sql, &mut sink).await?;
        Ok(result)
    }
}

impl Drop for PgSession {
    fn drop(&mut self) {
        // Close the socket now, even if a statement is still in flight. The
        // engine has no cancel and will finish the statement regardless.
        self.driver.abort();
    }
}

fn map_error(err: &tokio_postgres::Error) -> QueryError {
    match err.as_db_error() {
        Some(db) => QueryError::from_server(db.severity(), db.code().code(), db.message()),
        None => QueryError::from_client(err.to_string(), err.is_closed()),
    }
}
