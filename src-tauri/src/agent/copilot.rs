//! How the GitHub Copilot CLI is started as a delegated agent.
//!
//! The CLI is the operator's own install, with the operator's own sign-in.
//! This module never touches that sign-in. It only decides the command
//! line, so that the agent works against this app's engine and nothing
//! else. Every choice here was tested. See `docs/spike-acp.md`.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::delegate::Profile;
use crate::connection::McpServerCommand;

/// The name the engine's MCP server is given in the CLI's configuration.
/// An entry of the same name in the operator's own configuration is
/// replaced by this one for the session, so the two never run side by side.
pub const SERVER_NAME: &str = "stackql";

pub const PROFILE: Profile = Profile {
    name: "GitHub Copilot",
    sign_in_hint: "Run `copilot login` in a terminal, then send the message again.",
    tool_prefix: "stackql-",
    vendor_key: "github.com/copilot",
    // Without these the CLI gives a subagent's calls an id and no name.
    session_events: &["subagent.started"],
    // The CLI has three kinds of subagent. Under the tool list this app
    // gives it, the general-purpose kind has the engine's tools and runs on
    // the model the operator chose, the task kind has them and runs on a
    // model the CLI picks, and the explore kind has none of them. A
    // subagent started in the background needs tools to be read back that
    // the agent does not have here. All of it was tested.
    subagent_hint: "- With the task tool here, set agent_type to general-purpose and mode to sync, \
and start the subagents in the same step so that they run together.\n\
- Do not use the explore agent type, which does not have the stackql tools, or background mode.",
};

/// The CLI's tool for starting a subagent. A subagent gets the same tools
/// as the agent that starts it: the engine's, and this one.
pub const SUBAGENT_TOOL: &str = "task";

/// File names the CLI may have on this platform, best first.
fn program_names() -> &'static [&'static str] {
    if cfg!(windows) {
        // The npm install is a .cmd shim. Other installs are an .exe.
        &["copilot.exe", "copilot.cmd"]
    } else {
        &["copilot"]
    }
}

/// Whether there is a program at the path. This does not follow links,
/// because a Windows app execution alias is a link that cannot be followed
/// and can still be run.
pub fn program_exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| !meta.is_dir())
}

/// Finds the CLI. A location the operator set is used or reported as wrong.
/// Otherwise `PATH` is searched.
pub fn find_program(
    explicit: Option<&Path>,
    path_var: Option<&OsStr>,
    exists: impl Fn(&Path) -> bool,
) -> Result<PathBuf, String> {
    if let Some(path) = explicit {
        return if exists(path) {
            Ok(path.to_path_buf())
        } else {
            Err(format!(
                "The Copilot CLI location in Settings does not point to a file: {}. Correct it, or clear it to search PATH.",
                path.display()
            ))
        };
    }
    if let Some(path_var) = path_var {
        for dir in std::env::split_paths(path_var) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            for name in program_names() {
                let candidate = dir.join(name);
                if exists(&candidate) {
                    return Ok(candidate);
                }
            }
        }
    }
    Err(
        "The GitHub Copilot CLI was not found on PATH. Install it and run `copilot login`, or set its location in Settings."
            .to_string(),
    )
}

/// The names the CLI gives the engine's tools: the server name, a hyphen,
/// the tool name.
pub fn tool_ids(tools: &[String]) -> Vec<String> {
    tools
        .iter()
        .map(|tool| format!("{SERVER_NAME}-{tool}"))
        .collect()
}

/// The MCP configuration file that names the engine's MCP server.
pub fn mcp_config(server: &McpServerCommand) -> Result<Value, String> {
    let text = |value: &OsStr| {
        value.to_str().map(str::to_string).ok_or_else(|| {
            format!(
                "A path the engine is started with is not valid Unicode: {}",
                value.to_string_lossy()
            )
        })
    };
    let args = server
        .args
        .iter()
        .map(|arg| text(arg))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "local",
                "command": text(server.program.as_os_str())?,
                "args": args,
                "cwd": text(server.cwd.as_os_str())?,
                "tools": ["*"]
            }
        }
    }))
}

/// The arguments for `copilot`, given the configuration file and the tools
/// the model may use. With `subagents` the model may also split work across
/// subagents. They are held to the same list of tools.
pub fn launch_args(config_file: &Path, tool_ids: &[String], subagents: bool) -> Vec<OsString> {
    let mut config = OsString::from("@");
    config.push(config_file);
    let mut args: Vec<OsString> = vec![
        "--acp".into(),
        // No tools on GitHub itself. This chat is about the engine.
        "--disable-builtin-mcps".into(),
        // No instructions picked up from files on disk.
        "--no-custom-instructions".into(),
        // The model asks in its reply, not through a form this app has no
        // place for.
        "--no-ask-user".into(),
        // The engine's guidance for a model, sent with the MCP handshake.
        "--allow-all-mcp-server-instructions".into(),
        "--additional-mcp-config".into(),
        config,
        // The engine decides what may run. The CLI's own prompt for each
        // tool call would add a second gate that knows less.
        format!("--allow-tool={SERVER_NAME}").into(),
        // The model sees the engine's tools and nothing else: no shell, no
        // files, no other MCP server the operator has configured.
        "--available-tools".into(),
    ];
    args.extend(tool_ids.iter().map(OsString::from));
    if subagents {
        args.push(SUBAGENT_TOOL.into());
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(explicit: Option<&str>, path: &str, present: &[&str]) -> Result<PathBuf, String> {
        let present: Vec<PathBuf> = present.iter().map(PathBuf::from).collect();
        find_program(
            explicit.map(Path::new),
            Some(OsStr::new(path)),
            |candidate| present.iter().any(|p| p == candidate),
        )
    }

    fn join(dirs: &[&str]) -> String {
        std::env::join_paths(dirs)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn a_location_from_settings_is_used_as_given() {
        let got = found(Some("/opt/tools/copilot"), "", &["/opt/tools/copilot"]).unwrap();
        assert_eq!(got, PathBuf::from("/opt/tools/copilot"));
    }

    #[test]
    fn a_wrong_location_from_settings_is_an_error_and_path_is_not_searched() {
        let name = program_names()[0];
        let on_path = Path::new("/usr/bin").join(name);
        let err = found(
            Some("/nowhere/copilot"),
            &join(&["/usr/bin"]),
            &[on_path.to_str().unwrap()],
        )
        .unwrap_err();
        assert!(err.contains("Settings"), "{err}");
    }

    #[test]
    fn the_first_directory_on_path_that_has_it_wins() {
        let name = program_names()[0];
        let first = Path::new("/a").join(name);
        let second = Path::new("/b").join(name);
        let got = found(
            None,
            &join(&["/empty", "/a", "/b"]),
            &[first.to_str().unwrap(), second.to_str().unwrap()],
        )
        .unwrap();
        assert_eq!(got, first);
    }

    #[test]
    fn nothing_on_path_says_how_to_fix_it() {
        let err = found(None, &join(&["/a", "/b"]), &[]).unwrap_err();
        assert!(err.contains("copilot login"), "{err}");
        assert!(err.contains("Settings"), "{err}");
    }

    #[test]
    fn tools_are_named_with_the_server_prefix() {
        assert_eq!(
            tool_ids(&["run_select_query".to_string(), "list_providers".to_string()]),
            vec!["stackql-run_select_query", "stackql-list_providers"]
        );
        assert!(tool_ids(&[]).is_empty());
    }

    #[test]
    fn the_config_names_one_server_started_the_way_the_engine_says() {
        let server = McpServerCommand {
            program: PathBuf::from("/usr/local/bin/stackql"),
            args: vec!["mcp".into(), "--mcp.config".into(), r#"{"a":"b c"}"#.into()],
            cwd: PathBuf::from("/data/approot"),
        };
        let config = mcp_config(&server).unwrap();
        let servers = config["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 1);
        let entry = &servers[SERVER_NAME];
        assert_eq!(entry["type"], "local");
        assert_eq!(entry["command"], "/usr/local/bin/stackql");
        assert_eq!(entry["args"][2], r#"{"a":"b c"}"#);
        assert_eq!(entry["cwd"], "/data/approot");
    }

    #[test]
    fn the_command_line_limits_the_agent_to_the_engine() {
        let args = launch_args(
            Path::new("/data/copilot/mcp-config.json"),
            &tool_ids(&["run_select_query".to_string(), "server_info".to_string()]),
            false,
        );
        let args: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();

        assert_eq!(args[0], "--acp");
        let at = |flag: &str| args.iter().position(|a| a == flag).unwrap();
        assert_eq!(
            args[at("--additional-mcp-config") + 1],
            "@/data/copilot/mcp-config.json"
        );
        assert!(args.contains(&"--allow-tool=stackql".to_string()));
        assert!(args.contains(&"--disable-builtin-mcps".to_string()));
        // The tool list is last, because the flag takes every word after it.
        assert_eq!(
            &args[at("--available-tools") + 1..],
            ["stackql-run_select_query", "stackql-server_info"]
        );
        // Nothing here may widen what the agent can do.
        for forbidden in ["--allow-all", "--yolo", "--allow-all-tools", "--autopilot"] {
            assert!(!args.iter().any(|a| a == forbidden), "{forbidden} is set");
        }
    }

    #[test]
    fn the_agent_is_told_which_kind_of_subagent_can_do_the_work() {
        let hint = PROFILE.subagent_hint;
        assert!(hint.contains("general-purpose"));
        assert!(hint.contains("mode to sync"));
        assert!(hint.contains("explore"));
        assert!(hint.contains("background"));
    }

    #[test]
    fn subagents_add_one_tool_and_nothing_else() {
        let ids = tool_ids(&["run_select_query".to_string()]);
        let file = Path::new("/data/copilot/mcp-config.json");
        let text = |args: Vec<OsString>| -> Vec<String> {
            args.iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        };
        let without = text(launch_args(file, &ids, false));
        let with = text(launch_args(file, &ids, true));

        assert!(!without.contains(&"task".to_string()));
        // The same command line, with the subagent tool on the end of the
        // list of tools the model may use.
        let mut expected = without.clone();
        expected.push("task".to_string());
        assert_eq!(with, expected);
        let at = with.iter().position(|a| a == "--available-tools").unwrap();
        assert_eq!(&with[at + 1..], ["stackql-run_select_query", "task"]);
    }
}
