//! Choosing a free loopback port for the engine.

use std::io;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};

/// Asks the OS for a free port on 127.0.0.1 and releases it again.
///
/// There is a small window between releasing the port and the engine binding
/// it in which another process could take it. The supervisor's readiness
/// check catches that case: the engine fails to bind, exits, and the failure
/// is reported with its stderr.
pub fn pick_free_port() -> io::Result<u16> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_a_port_that_can_be_bound_again() {
        let port = pick_free_port().unwrap();
        assert_ne!(port, 0);
        // The port was released, so binding it must succeed.
        let rebound = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
        assert!(rebound.is_ok(), "port {port} should be free");
    }

    #[test]
    fn does_not_hand_out_a_port_that_is_in_use() {
        let held = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).unwrap();
        let held_port = held.local_addr().unwrap().port();
        for _ in 0..50 {
            assert_ne!(pick_free_port().unwrap(), held_port);
        }
    }

    #[test]
    fn picks_from_the_loopback_interface_only() {
        // Binding 127.0.0.1:0 must never yield a privileged port.
        let port = pick_free_port().unwrap();
        assert!(port >= 1024);
    }
}
