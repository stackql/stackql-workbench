//! The metadata statements behind the explorer tree, and the mapping from
//! their results to typed items.
//!
//! Statements are built here from validated, quoted identifiers. Names that
//! arrive from the webview are never interpolated as they are.
//!
//! Column names and shapes were read from the real engine and are recorded
//! in `docs/spike-pgwire.md`.

use serde::Serialize;

use super::result::{ResultSet, Row};
use crate::error::{HostError, HostResult};

const MAX_IDENTIFIER_CHARS: usize = 256;

/// Validates a provider, service, resource or method name and returns it in
/// double quotes.
///
/// The engine accepts double-quoted identifiers in every statement used
/// here. Quoting always, instead of only when needed, means a name can never
/// be read as a keyword. Names from the engine are made of letters, digits,
/// underscores, hyphens and dots. Anything else is refused, which rules out
/// quotes, semicolons, whitespace and control characters.
pub fn quote_identifier(name: &str) -> HostResult<String> {
    if name.is_empty() {
        return Err(HostError::InvalidIdentifier("The name is empty.".into()));
    }
    if name.chars().count() > MAX_IDENTIFIER_CHARS {
        return Err(HostError::InvalidIdentifier("The name is too long.".into()));
    }
    let valid = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if !valid {
        return Err(HostError::InvalidIdentifier(format!(
            "'{}' is not a valid name. Names may contain letters, digits, underscores, hyphens and dots.",
            name.escape_default()
        )));
    }
    Ok(format!("\"{name}\""))
}

fn qualified(parts: &[&str]) -> HostResult<String> {
    let quoted: HostResult<Vec<String>> = parts.iter().map(|p| quote_identifier(p)).collect();
    Ok(quoted?.join("."))
}

pub const PROVIDERS_SQL: &str = "SHOW PROVIDERS";

pub fn services_sql(provider: &str) -> HostResult<String> {
    Ok(format!(
        "SHOW EXTENDED SERVICES IN {}",
        qualified(&[provider])?
    ))
}

pub fn resources_sql(provider: &str, service: &str) -> HostResult<String> {
    Ok(format!(
        "SHOW EXTENDED RESOURCES IN {}",
        qualified(&[provider, service])?
    ))
}

pub fn methods_sql(provider: &str, service: &str, resource: &str) -> HostResult<String> {
    Ok(format!(
        "SHOW EXTENDED METHODS IN {}",
        qualified(&[provider, service, resource])?
    ))
}

pub fn fields_sql(provider: &str, service: &str, resource: &str) -> HostResult<String> {
    Ok(format!(
        "DESCRIBE EXTENDED {}",
        qualified(&[provider, service, resource])?
    ))
}

pub fn method_fields_sql(
    provider: &str,
    service: &str,
    resource: &str,
    method: &str,
) -> HostResult<String> {
    // The keyword order matters: DESCRIBE EXTENDED METHOD is a syntax error.
    Ok(format!(
        "DESCRIBE METHOD EXTENDED {}",
        qualified(&[provider, service, resource, method])?
    ))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    /// The name to use in statements.
    pub name: String,
    /// `<name>:<version>`. Not a path.
    pub id: String,
    pub title: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resource {
    pub name: String,
    /// The fully qualified name, `<provider>.<service>.<resource>`.
    pub id: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Method {
    pub name: String,
    /// `SELECT`, `INSERT`, `UPDATE`, `REPLACE`, `DELETE` or `EXEC`.
    pub sql_verb: String,
    pub required_params: Vec<String>,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub name: String,
    /// May be empty, for example for some view columns.
    #[serde(rename = "type")]
    pub type_name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MethodField {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    /// `input_required`, `input_optional` or `output`.
    pub param_type: String,
    pub shape: String,
    pub description: String,
}

/// Reads columns by name, so a change in column order does not break the
/// explorer. A missing required column is an error. A missing optional
/// column reads as empty.
struct Reader<'a> {
    result: &'a ResultSet,
    statement: &'static str,
}

impl<'a> Reader<'a> {
    fn new(result: &'a ResultSet, statement: &'static str) -> Self {
        Self { result, statement }
    }

    fn required(&self, name: &str) -> HostResult<usize> {
        self.result.column(name).ok_or_else(|| {
            HostError::Query(format!(
                "{} returned an unexpected shape: no '{name}' column. Columns were: {}.",
                self.statement,
                self.result.columns.join(", ")
            ))
        })
    }

    fn optional(&self, name: &str) -> Option<usize> {
        self.result.column(name)
    }
}

fn cell(row: &Row, index: usize) -> String {
    row.get(index).cloned().flatten().unwrap_or_default()
}

fn opt_cell(row: &Row, index: Option<usize>) -> String {
    index.map(|i| cell(row, i)).unwrap_or_default()
}

pub fn map_providers(result: &ResultSet) -> HostResult<Vec<Provider>> {
    let reader = Reader::new(result, "SHOW PROVIDERS");
    let name = reader.required("name")?;
    let version = reader.optional("version");
    Ok(result
        .rows
        .iter()
        .map(|row| Provider {
            name: cell(row, name),
            version: opt_cell(row, version),
        })
        .collect())
}

pub fn map_services(result: &ResultSet) -> HostResult<Vec<Service>> {
    let reader = Reader::new(result, "SHOW SERVICES");
    let name = reader.required("name")?;
    let id = reader.optional("id");
    let title = reader.optional("title");
    let description = reader.optional("description");
    Ok(result
        .rows
        .iter()
        .map(|row| Service {
            name: cell(row, name),
            id: opt_cell(row, id),
            title: opt_cell(row, title),
            description: opt_cell(row, description),
        })
        .collect())
}

pub fn map_resources(result: &ResultSet) -> HostResult<Vec<Resource>> {
    let reader = Reader::new(result, "SHOW RESOURCES");
    let name = reader.required("name")?;
    let id = reader.optional("id");
    let description = reader.optional("description");
    Ok(result
        .rows
        .iter()
        .map(|row| Resource {
            name: cell(row, name),
            id: opt_cell(row, id),
            description: opt_cell(row, description),
        })
        .collect())
}

pub fn map_methods(result: &ResultSet) -> HostResult<Vec<Method>> {
    let reader = Reader::new(result, "SHOW METHODS");
    let name = reader.required("MethodName")?;
    let verb = reader.optional("SQLVerb");
    let params = reader.optional("RequiredParams");
    let description = reader.optional("description");
    Ok(result
        .rows
        .iter()
        .map(|row| Method {
            name: cell(row, name),
            sql_verb: opt_cell(row, verb),
            required_params: opt_cell(row, params)
                .split(',')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(str::to_string)
                .collect(),
            description: opt_cell(row, description),
        })
        .collect())
}

pub fn map_fields(result: &ResultSet) -> HostResult<Vec<Field>> {
    let reader = Reader::new(result, "DESCRIBE");
    let name = reader.required("name")?;
    let type_name = reader.optional("type");
    let description = reader.optional("description");
    Ok(result
        .rows
        .iter()
        .map(|row| Field {
            name: cell(row, name),
            type_name: opt_cell(row, type_name),
            description: opt_cell(row, description),
        })
        .collect())
}

pub fn map_method_fields(result: &ResultSet) -> HostResult<Vec<MethodField>> {
    let reader = Reader::new(result, "DESCRIBE METHOD");
    let name = reader.required("name")?;
    let param_type = reader.required("param_type")?;
    let type_name = reader.optional("type");
    let shape = reader.optional("shape");
    let description = reader.optional("description");
    Ok(result
        .rows
        .iter()
        .map(|row| MethodField {
            name: cell(row, name),
            type_name: opt_cell(row, type_name),
            param_type: cell(row, param_type),
            shape: opt_cell(row, shape),
            description: opt_cell(row, description),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(columns: &[&str], rows: &[&[&str]]) -> ResultSet {
        ResultSet {
            columns: columns.iter().map(|c| (*c).to_string()).collect(),
            rows: rows
                .iter()
                .map(|r| r.iter().map(|v| Some((*v).to_string())).collect())
                .collect(),
            notices: Vec::new(),
        }
    }

    #[test]
    fn plain_names_are_quoted() {
        assert_eq!(quote_identifier("github").unwrap(), "\"github\"");
        assert_eq!(quote_identifier("vw_info").unwrap(), "\"vw_info\"");
        assert_eq!(quote_identifier("openssl-3.1").unwrap(), "\"openssl-3.1\"");
    }

    #[test]
    fn names_that_could_break_out_of_a_statement_are_refused() {
        for bad in [
            "",
            "a b",
            "a;b",
            "a\"b",
            "a'b",
            "a`b",
            "a\nb",
            "a--b; DROP",
            "a/*b*/",
            "a\\b",
            "naïve",
        ] {
            assert!(
                matches!(quote_identifier(bad), Err(HostError::InvalidIdentifier(_))),
                "{bad:?} should be refused"
            );
        }
        assert!(quote_identifier(&"x".repeat(MAX_IDENTIFIER_CHARS + 1)).is_err());
    }

    #[test]
    fn statements_use_quoted_qualified_names() {
        assert_eq!(
            services_sql("github").unwrap(),
            "SHOW EXTENDED SERVICES IN \"github\""
        );
        assert_eq!(
            resources_sql("github", "repos").unwrap(),
            "SHOW EXTENDED RESOURCES IN \"github\".\"repos\""
        );
        assert_eq!(
            methods_sql("github", "repos", "repos").unwrap(),
            "SHOW EXTENDED METHODS IN \"github\".\"repos\".\"repos\""
        );
        assert_eq!(
            fields_sql("homebrew", "formula", "vw_info").unwrap(),
            "DESCRIBE EXTENDED \"homebrew\".\"formula\".\"vw_info\""
        );
        assert_eq!(
            method_fields_sql("homebrew", "formula", "formula", "get_formula").unwrap(),
            "DESCRIBE METHOD EXTENDED \"homebrew\".\"formula\".\"formula\".\"get_formula\""
        );
    }

    #[test]
    fn a_bad_part_fails_the_whole_statement() {
        assert!(resources_sql("github", "repos; SELECT 1").is_err());
        assert!(method_fields_sql("a", "b", "c", "").is_err());
    }

    #[test]
    fn providers_are_mapped() {
        let rs = result(
            &["name", "version"],
            &[
                &["github", "v26.08.00448"],
                &["stackql_preview", "internal"],
            ],
        );
        assert_eq!(
            map_providers(&rs).unwrap(),
            vec![
                Provider {
                    name: "github".into(),
                    version: "v26.08.00448".into()
                },
                Provider {
                    name: "stackql_preview".into(),
                    version: "internal".into()
                },
            ]
        );
    }

    #[test]
    fn services_are_mapped_by_column_name_not_position() {
        // The engine's order is id, name, title, description, version, preferred.
        let rs = result(
            &["id", "name", "title", "description", "version", "preferred"],
            &[&[
                "formula:v25.01.00292",
                "formula",
                "Homebrew Formulae API",
                "API For Accessing Homebrew Formulae Information.",
                "v25.01.00292",
                "true",
            ]],
        );
        let services = map_services(&rs).unwrap();
        assert_eq!(services[0].name, "formula");
        assert_eq!(services[0].id, "formula:v25.01.00292");
        assert_eq!(services[0].title, "Homebrew Formulae API");

        // A different order gives the same result.
        let reordered = result(&["title", "name", "id"], &[&["T", "formula", "formula:v1"]]);
        let services = map_services(&reordered).unwrap();
        assert_eq!(services[0].name, "formula");
        assert_eq!(services[0].title, "T");
        assert_eq!(services[0].description, "");
    }

    #[test]
    fn resources_are_mapped() {
        let rs = result(
            &["name", "id", "description"],
            &[&["formula", "homebrew.formula.formula", ""]],
        );
        assert_eq!(
            map_resources(&rs).unwrap(),
            vec![Resource {
                name: "formula".into(),
                id: "homebrew.formula.formula".into(),
                description: String::new(),
            }]
        );
    }

    #[test]
    fn methods_split_required_params() {
        let rs = result(
            &["MethodName", "RequiredParams", "SQLVerb", "description"],
            &[
                &["list_for_org", "org", "SELECT", "repos/list-for-org"],
                &["list_public", "", "SELECT", "repos/list-public"],
                &["create_fork", "owner, repo", "INSERT", "repos/create-fork"],
            ],
        );
        let methods = map_methods(&rs).unwrap();
        assert_eq!(methods[0].required_params, vec!["org"]);
        assert_eq!(methods[1].required_params, Vec::<String>::new());
        assert_eq!(methods[2].required_params, vec!["owner", "repo"]);
        assert_eq!(methods[2].sql_verb, "INSERT");
    }

    #[test]
    fn fields_are_mapped_and_serialise_type_as_type() {
        let rs = result(
            &["name", "type", "description"],
            &[&["name", "string", ""], &["formula_name", "", ""]],
        );
        let fields = map_fields(&rs).unwrap();
        assert_eq!(fields[0].type_name, "string");
        assert_eq!(fields[1].type_name, "");
        assert_eq!(
            serde_json::to_value(&fields[0]).unwrap(),
            serde_json::json!({ "name": "name", "type": "string", "description": "" })
        );
    }

    #[test]
    fn method_fields_are_mapped() {
        let rs = result(
            &["name", "type", "param_type", "shape", "description"],
            &[
                &["formula_name", "string", "input_required", "string", ""],
                &["aliases", "array", "output", "array", ""],
            ],
        );
        let fields = map_method_fields(&rs).unwrap();
        assert_eq!(fields[0].param_type, "input_required");
        assert_eq!(fields[1].param_type, "output");
        assert_eq!(
            serde_json::to_value(&fields[0]).unwrap(),
            serde_json::json!({
                "name": "formula_name",
                "type": "string",
                "paramType": "input_required",
                "shape": "string",
                "description": ""
            })
        );
    }

    #[test]
    fn a_missing_required_column_is_reported_with_what_was_there() {
        let rs = result(&["title"], &[&["x"]]);
        let err = map_services(&rs).unwrap_err();
        let HostError::Query(message) = err else {
            panic!("expected a query error");
        };
        assert!(message.contains("'name'"));
        assert!(message.contains("title"));
    }

    #[test]
    fn nulls_and_short_rows_read_as_empty() {
        let rs = ResultSet {
            columns: vec!["name".into(), "version".into()],
            rows: vec![vec![Some("only-name".into())], vec![Some("x".into()), None]],
            notices: Vec::new(),
        };
        let providers = map_providers(&rs).unwrap();
        assert_eq!(providers[0].version, "");
        assert_eq!(providers[1].version, "");
    }

    #[test]
    fn an_empty_result_maps_to_an_empty_list() {
        let rs = result(&["name", "version"], &[]);
        assert_eq!(map_providers(&rs).unwrap(), Vec::new());
    }
}
