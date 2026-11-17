//! API keys and tokens, kept in the OS keychain.
//!
//! Secrets never go into settings files, logs, the webview or `localStorage`.
//! The webview can ask whether a secret is set and can replace or remove it.
//! It can never read one back.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{HostError, HostResult};
use crate::util::lock;

/// The keychain service name every entry is stored under.
const SERVICE: &str = "io.stackql.workbench";

pub trait SecretStore: Send + Sync {
    /// Reads a secret. `None` means it has never been set.
    fn get(&self, name: &str) -> HostResult<Option<String>>;
    fn set(&self, name: &str, value: &str) -> HostResult<()>;
    /// Removes a secret. Removing one that is not there is not an error.
    fn delete(&self, name: &str) -> HostResult<()>;
}

/// The OS keychain: Credential Manager on Windows, Keychain on macOS.
pub struct KeychainStore {
    _private: (),
}

impl KeychainStore {
    /// Installs the platform credential store and returns a handle to it.
    pub fn open() -> HostResult<Self> {
        install_platform_store()?;
        Ok(Self { _private: () })
    }

    fn entry(name: &str) -> HostResult<keyring_core::Entry> {
        keyring_core::Entry::new(SERVICE, name).map_err(|err| fail("open", name, &err))
    }
}

#[cfg(windows)]
fn install_platform_store() -> HostResult<()> {
    let store = windows_native_keyring_store::Store::new()
        .map_err(|err| HostError::Secrets(format!("Could not open Credential Manager: {err}")))?;
    keyring_core::set_default_store(store);
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_platform_store() -> HostResult<()> {
    let store = apple_native_keyring_store::keychain::Store::new()
        .map_err(|err| HostError::Secrets(format!("Could not open the Keychain: {err}")))?;
    keyring_core::set_default_store(store);
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn install_platform_store() -> HostResult<()> {
    Err(HostError::Secrets(
        "No OS keychain is available on this platform.".to_string(),
    ))
}

/// Builds an error that names the secret but never includes its value.
fn fail(action: &str, name: &str, err: &dyn std::fmt::Display) -> HostError {
    HostError::Secrets(format!(
        "Could not {action} '{name}' in the OS keychain: {err}"
    ))
}

impl SecretStore for KeychainStore {
    fn get(&self, name: &str) -> HostResult<Option<String>> {
        match Self::entry(name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(err) => Err(fail("read", name, &err)),
        }
    }

    fn set(&self, name: &str, value: &str) -> HostResult<()> {
        Self::entry(name)?
            .set_password(value)
            .map_err(|err| fail("store", name, &err))
    }

    fn delete(&self, name: &str) -> HostResult<()> {
        match Self::entry(name)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(err) => Err(fail("remove", name, &err)),
        }
    }
}

/// Keeps secrets in memory. For tests, and as the fallback when the OS
/// keychain cannot be opened, in which case a key lasts until the app closes.
#[derive(Default)]
pub struct MemoryStore {
    values: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemoryStore {
    fn get(&self, name: &str) -> HostResult<Option<String>> {
        Ok(lock(&self.values).get(name).cloned())
    }

    fn set(&self, name: &str, value: &str) -> HostResult<()> {
        lock(&self.values).insert(name.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, name: &str) -> HostResult<()> {
        lock(&self.values).remove(name);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_round_trips() {
        let store = MemoryStore::default();
        assert_eq!(store.get("k").unwrap(), None);
        store.set("k", "v1").unwrap();
        assert_eq!(store.get("k").unwrap().as_deref(), Some("v1"));
        store.set("k", "v2").unwrap();
        assert_eq!(store.get("k").unwrap().as_deref(), Some("v2"));
        store.delete("k").unwrap();
        assert_eq!(store.get("k").unwrap(), None);
        // Removing something that is not there is fine.
        store.delete("k").unwrap();
    }

    #[test]
    fn errors_name_the_secret_but_never_carry_a_value() {
        let err = fail("store", "inference.gemini.api_key", &"access denied");
        let text = err.to_string();
        assert!(text.contains("inference.gemini.api_key"));
        assert!(text.contains("access denied"));
    }

    /// Exercises the real OS keychain. It writes and removes one throwaway
    /// entry. Skipped where the keychain cannot be opened, for example on a
    /// headless build machine.
    #[test]
    fn os_keychain_round_trips() {
        let Ok(store) = KeychainStore::open() else {
            eprintln!("skipped: no OS keychain available");
            return;
        };
        let name = format!("test.round_trip.{}", std::process::id());
        let value = "not-a-real-secret";
        if store.set(&name, value).is_err() {
            eprintln!("skipped: the OS keychain refused a write");
            return;
        }
        assert_eq!(store.get(&name).unwrap().as_deref(), Some(value));
        store.delete(&name).unwrap();
        assert_eq!(store.get(&name).unwrap(), None);
        store.delete(&name).unwrap();
    }
}
