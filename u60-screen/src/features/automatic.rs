//! Ordinary settings commit when a choice or text edit completes. Commands
//! (sending, deleting, installing, PIN verification) remain explicit actions.
use super::*;
pub fn action(id: &str) -> Option<&'static str> {
    Some(match id {
        "quick-controls" | "mobile-modes" | "wifi-master" | "wifi2" | "wifi5" | "guest"
        | "charge" | "power-save" | "fast-boot" | "auto-sleep" | "ttl" | "oos" | "watchdog"
        | "tailscale-config" | "mobile-data" | "network-mode" | "usage" | "lan" | "firewall"
        | "nat" | "dmz" | "upnp" | "qos" | "vpn" | "dns-config" | "doh" | "usb" => "save",
        "proxy-service" => "settings",
        "proxy-groups" => "select",
        _ => return None,
    })
}
pub fn interruption(id: &str, page: &Page, _readings: &Data) -> bool {
    match id {
        // Only prompt for truly disruptive local changes (cutting cellular radio or
        // renumbering the LAN subnet). Ordinary switches apply directly on the
        // physical touchscreen since it connects over loopback and never drops out.
        "quick-controls" | "mobile-modes" => page
            .fields
            .iter()
            .any(|f| f.key == "airplane" && f.dirty() && f.value == "true"),
        "lan" => page
            .fields
            .iter()
            .any(|f| f.dirty() && matches!(f.key.as_str(), "lan_ipaddr" | "lan_netmask")),
        _ => false,
    }
}
