use serde_json::{json, Value};
use std::{fs, io::{Read, Seek, SeekFrom}, process::Command};

const UNAVAILABLE: &str = "OpenWrt information unavailable";

pub fn read(page: &str) -> (u16, Value) {
    let data = match page {
        "system-log" => system_log(),
        "kernel-log" => logs("/bin/dmesg | /bin/busybox tail -n 200"),
        "mounts" => mounts(),
        "packages" => packages(),
        _ => return (404, crate::server::error_body("Unknown OpenWrt page")),
    };
    match data {
        Ok(data) => (200, json!({"ok": true, "data": data})),
        Err(_) => (503, crate::server::error_body(UNAVAILABLE)),
    }
}

fn system_log() -> std::io::Result<Value> {
    let mut file = fs::File::open("/logfs/syslog")?;
    let start = file.metadata()?.len().saturating_sub(96 * 1024);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(96 * 1024).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<_> = text.lines().rev().take(200).collect();
    lines.reverse();
    Ok(json!({"text": lines.join("\n")}))
}

fn logs(script: &str) -> std::io::Result<Value> {
    // Only fixed read-only commands are passed here by read().
    let output = Command::new("/bin/sh").args(["-o", "pipefail", "-c", script]).output()?;
    if !output.status.success() {
        return Err(std::io::Error::other(UNAVAILABLE));
    }
    let start = output.stdout.len().saturating_sub(96 * 1024);
    Ok(json!({"text": String::from_utf8_lossy(&output.stdout[start..])}))
}

fn mounts() -> std::io::Result<Value> {
    let data = fs::read_to_string("/proc/self/mountinfo")?;
    let mounts: Vec<_> = data.lines().filter_map(|line| {
        let (before, after) = line.split_once(" - ")?;
        let mut fields = before.split_ascii_whitespace().skip(4);
        let target = fields.next()?;
        let readonly = fields.next()?.split(',').any(|v| v == "ro");
        let mut fields = after.split_ascii_whitespace();
        let filesystem = fields.next()?;
        let source = fields.next()?;
        Some(json!({"target": target, "source": source, "filesystem": filesystem, "readonly": readonly}))
    }).collect();
    Ok(json!({"entries": mounts}))
}

fn packages() -> std::io::Result<Value> {
    let data = fs::read_to_string("/data/owrt-root/usr/lib/opkg/status")?;
    let mut installed: Vec<_> = data.split("\n\n").filter_map(|block| {
        let field = |prefix| block.lines().find_map(|line| line.strip_prefix(prefix));
        let status = field("Status: ")?;
        if status.split_ascii_whitespace().last() != Some("installed") { return None; }
        Some((field("Package: ")?, field("Version: ")?, field("Architecture: ").unwrap_or("")))
    }).collect();
    installed.sort_unstable();
    let entries: Vec<_> = installed.into_iter().map(|(name, version, architecture)| {
        json!({"name": name, "version": version, "architecture": architecture})
    }).collect();
    Ok(json!({"entries": entries}))
}
