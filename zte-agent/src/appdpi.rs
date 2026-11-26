use serde_json::{json, Value};
use std::{
    fs::File,
    io::{self, Read},
    os::unix::fs::OpenOptionsExt,
    time::{SystemTime, UNIX_EPOCH},
};

const STATUS: &str = "/tmp/u60-appdpi/status.json";
const DEVICES: &str = "/tmp/u60-appdpi/devices.json";
const MAX_BYTES: u64 = 512 * 1024;

fn read_snapshot(path: &str) -> io::Result<Value> {
    let file = File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err(io::ErrorKind::InvalidData.into());
    }

    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(io::ErrorKind::InvalidData.into());
    }
    serde_json::from_slice(&bytes).map_err(Into::into)
}

pub fn snapshot() -> (u16, Value) {
    for _ in 0..2 {
        let (Ok(status), Ok(devices)) = (read_snapshot(STATUS), read_snapshot(DEVICES)) else {
            break;
        };
        let (Some(ts), Some(seq)) = (status["meta"]["ts"].as_u64(), status["meta"]["seq"].as_u64()) else {
            break;
        };
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        if ts.abs_diff(now) > 25 {
            break;
        }
        if devices["meta"]["seq"].as_u64() == Some(seq) {
            return (200, json!({"ok": true, "data": {
                "meta": status["meta"], "apps": status["apps"], "device_apps": status["dev_apps"],
                "connections": status["flows"], "devices": devices["devices"],
                "devices_total": devices["devices_total"]
            }}));
        }
    }
    (503, crate::server::error_body("AppDPI snapshot unavailable"))
}
