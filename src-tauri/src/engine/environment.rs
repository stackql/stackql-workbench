//! The environment a child process starts with.
//!
//! A process keeps the environment it was started with. On Windows the
//! user's and the machine's variables are kept in the registry, and one set
//! there after the app started, with `setx` or in the system settings, used
//! to reach no child until the app itself was started again. So each child
//! now gets the app's own environment with what the system holds applied on
//! top: a variable the app's environment lacks is added, and one changed or
//! removed in the system's settings since the app started is changed or
//! removed. Restarting the engine is then enough to pick up a credential set
//! that way.
//!
//! A variable the app was started with keeps its value unless the system's
//! settings change it after the app started. A value set in a terminal for
//! one launch therefore still wins over the stored one.
//!
//! On macOS there is no such store. An app started from Finder gets what
//! launchd gives it and never reads a shell profile, so there the child gets
//! the app's own environment, and a dotenv file named in Settings is how the
//! engine is handed credentials.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::sync::OnceLock;

/// Variables as name and value, in no particular order.
pub type Vars = Vec<(OsString, OsString)>;

/// What the system held when the app started. `None` inside means it could
/// not be read, or there is no such store on this platform.
static BASELINE: OnceLock<Option<Vars>> = OnceLock::new();

/// Notes what the system holds now, so later changes can be told apart from
/// how things were. Call it as the app starts, before any child.
pub fn capture_baseline() {
    let _ = BASELINE.get_or_init(system_variables);
}

/// The environment for a child: the app's own, with the system's variables
/// applied as the module describes.
pub fn for_child() -> Vars {
    let own: Vars = std::env::vars_os().collect();
    let Some(baseline) = BASELINE.get_or_init(system_variables) else {
        return own;
    };
    match system_variables() {
        Some(now) => apply_changes(own, baseline, &now),
        None => own,
    }
}

/// Names are compared as Windows compares them, without regard to case.
fn key(name: &OsStr) -> String {
    name.to_string_lossy().to_uppercase()
}

/// Applies what the system holds `now` to the app's own environment. A
/// variable missing from `own` is added. One present in `own` is replaced
/// only when the system's value has changed since `baseline`. One that was
/// in `baseline` and is gone now is removed, when `own` still has the value
/// it had then.
fn apply_changes(mut own: Vars, baseline: &Vars, now: &Vars) -> Vars {
    let before: HashMap<String, &OsString> = baseline
        .iter()
        .map(|(name, value)| (key(name), value))
        .collect();
    let mut present = std::collections::HashSet::new();
    for (name, value) in now {
        let k = key(name);
        present.insert(k.clone());
        let changed = before.get(&k).is_none_or(|old| *old != value);
        match own.iter().position(|(n, _)| key(n) == k) {
            None => own.push((name.clone(), value.clone())),
            Some(at) if changed => own[at].1 = value.clone(),
            Some(_) => {}
        }
    }
    for (k, old) in &before {
        if present.contains(k) {
            continue;
        }
        if let Some(at) = own.iter().position(|(n, v)| key(n) == *k && v == *old) {
            own.remove(at);
        }
    }
    own
}

/// Splits an environment block: strings of `name=value`, each ended by a
/// NUL, with an empty string after the last. Entries whose name starts with
/// `=` are the hidden per-drive folders of a console and are left out.
#[cfg_attr(not(windows), allow(dead_code))]
fn split_block(block: &[u16]) -> Vars {
    #[cfg(windows)]
    use std::os::windows::ffi::OsStringExt;
    #[cfg(windows)]
    let text = |units: &[u16]| OsString::from_wide(units);
    #[cfg(not(windows))]
    let text = |units: &[u16]| OsString::from(String::from_utf16_lossy(units));

    block
        .split(|&unit| unit == 0)
        .take_while(|entry| !entry.is_empty())
        .filter(|entry| entry.first() != Some(&u16::from(b'=')))
        .filter_map(|entry| {
            let eq = entry.iter().position(|&unit| unit == u16::from(b'='))?;
            Some((text(&entry[..eq]), text(&entry[eq + 1..])))
        })
        .collect()
}

/// The variables a process of this user started now would get: the
/// machine's and the user's, as the registry holds them at this moment,
/// expanded and with the two PATHs joined, as Windows builds them.
#[cfg(windows)]
fn system_variables() -> Option<Vars> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{TOKEN_DUPLICATE, TOKEN_QUERY};
    use windows_sys::Win32::System::Environment::{
        CreateEnvironmentBlock, DestroyEnvironmentBlock,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo handle that needs no
    // closing, and `token` is a valid place for the handle to go.
    let opened = unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE,
            &mut token,
        )
    };
    if opened == 0 {
        return None;
    }
    let mut block: *mut core::ffi::c_void = std::ptr::null_mut();
    // SAFETY: `token` was opened above with the access a primary token needs
    // here, and `block` is a valid place for the pointer to go. With FALSE
    // the block holds the system's variables, not this process's.
    let made = unsafe { CreateEnvironmentBlock(&mut block, token, 0) };
    // SAFETY: `token` is a handle this function opened and closes once.
    unsafe { CloseHandle(token) };
    if made == 0 || block.is_null() {
        return None;
    }
    let units = block.cast::<u16>().cast_const();
    let mut len = 0;
    // SAFETY: the block is UTF-16 strings, each ended by a NUL, with one more
    // NUL after the last. The scan stops at that pair and reads nothing past
    // it.
    unsafe {
        while !(*units.add(len) == 0 && (len == 0 || *units.add(len - 1) == 0)) {
            len += 1;
        }
    }
    // SAFETY: `len + 1` units were read above, all inside the block.
    let vars = split_block(unsafe { std::slice::from_raw_parts(units, len + 1) });
    // SAFETY: the block came from CreateEnvironmentBlock and is freed once.
    unsafe { DestroyEnvironmentBlock(block) };
    Some(vars)
}

#[cfg(not(windows))]
fn system_variables() -> Option<Vars> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vars {
        pairs
            .iter()
            .map(|(n, v)| (OsString::from(n), OsString::from(v)))
            .collect()
    }

    fn get<'a>(env: &'a Vars, name: &str) -> Option<&'a str> {
        env.iter()
            .find(|(n, _)| key(n) == key(OsStr::new(name)))
            .and_then(|(_, v)| v.to_str())
    }

    #[test]
    fn a_variable_set_after_the_app_started_reaches_the_child() {
        let own = vars(&[("PATH", "C:\\bin")]);
        let baseline = vars(&[("PATH", "C:\\bin")]);
        let now = vars(&[("PATH", "C:\\bin"), ("CLOUDFLARE_API_TOKEN", "new")]);
        let env = apply_changes(own, &baseline, &now);
        assert_eq!(get(&env, "CLOUDFLARE_API_TOKEN"), Some("new"));
        assert_eq!(get(&env, "PATH"), Some("C:\\bin"));
    }

    #[test]
    fn a_variable_changed_after_the_app_started_takes_its_new_value() {
        let own = vars(&[("TOKEN", "old")]);
        let baseline = vars(&[("TOKEN", "old")]);
        let now = vars(&[("TOKEN", "new")]);
        assert_eq!(
            get(&apply_changes(own, &baseline, &now), "TOKEN"),
            Some("new")
        );
    }

    #[test]
    fn a_variable_removed_after_the_app_started_is_removed() {
        let own = vars(&[("TOKEN", "old"), ("KEEP", "1")]);
        let baseline = vars(&[("TOKEN", "old"), ("KEEP", "1")]);
        let now = vars(&[("KEEP", "1")]);
        let env = apply_changes(own, &baseline, &now);
        assert_eq!(get(&env, "TOKEN"), None);
        assert_eq!(get(&env, "KEEP"), Some("1"));
    }

    #[test]
    fn a_value_the_app_was_started_with_wins_until_the_system_changes() {
        // Set in a terminal for this launch, over the stored value.
        let own = vars(&[("AWS_PROFILE", "dev"), ("ONLY_HERE", "x")]);
        let baseline = vars(&[("AWS_PROFILE", "prod")]);
        let unchanged = apply_changes(own.clone(), &baseline, &baseline);
        assert_eq!(get(&unchanged, "AWS_PROFILE"), Some("dev"));
        assert_eq!(get(&unchanged, "ONLY_HERE"), Some("x"));
        // A variable the system never held is not removed.
        let removed = apply_changes(own.clone(), &baseline, &vars(&[]));
        assert_eq!(get(&removed, "AWS_PROFILE"), Some("dev"));
        assert_eq!(get(&removed, "ONLY_HERE"), Some("x"));
        // Changed in the system's settings since: that is the newer word.
        let changed = apply_changes(own, &baseline, &vars(&[("AWS_PROFILE", "staging")]));
        assert_eq!(get(&changed, "AWS_PROFILE"), Some("staging"));
    }

    #[test]
    fn names_match_without_regard_to_case() {
        let own = vars(&[("Path", "C:\\old")]);
        let baseline = vars(&[("Path", "C:\\old")]);
        let now = vars(&[("PATH", "C:\\new")]);
        let env = apply_changes(own, &baseline, &now);
        assert_eq!(env.len(), 1, "{env:?}");
        assert_eq!(get(&env, "path"), Some("C:\\new"));
    }

    #[test]
    fn a_block_is_split_into_names_and_values() {
        let text = "=C:=C:\\work\0A=1\0B=x=y\0EMPTY=\0\0";
        let units: Vec<u16> = text.encode_utf16().collect();
        let env = split_block(&units);
        assert_eq!(env, vars(&[("A", "1"), ("B", "x=y"), ("EMPTY", "")]));
        assert!(split_block(&[0, 0]).is_empty());
    }

    /// Sets a throwaway user variable in the real registry, the way `setx`
    /// stores one, and checks the next read sees it while this process's
    /// own environment does not. The variable is removed again after.
    #[cfg(windows)]
    #[test]
    fn a_user_variable_stored_now_is_seen_without_restarting() {
        use std::process::Command;

        struct Remove(String);
        impl Drop for Remove {
            fn drop(&mut self) {
                let _ = Command::new("reg")
                    .args(["delete", "HKCU\\Environment", "/v", &self.0, "/f"])
                    .output();
            }
        }

        capture_baseline();
        let name = format!("STACKQL_WORKBENCH_PROBE_{}", std::process::id());
        let added = Command::new("reg")
            .args([
                "add",
                "HKCU\\Environment",
                "/v",
                &name,
                "/t",
                "REG_SZ",
                "/d",
                "probe-value",
                "/f",
            ])
            .output()
            .unwrap();
        assert!(added.status.success(), "{added:?}");
        let _cleanup = Remove(name.clone());

        assert!(std::env::var_os(&name).is_none());
        let env = for_child();
        assert_eq!(get(&env, &name), Some("probe-value"));
        // What the process had is still there.
        assert!(get(&env, "SystemRoot").is_some());
    }
}
