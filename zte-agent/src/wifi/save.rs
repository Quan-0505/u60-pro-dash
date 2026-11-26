//! Wi-Fi writes share validation, firmware application and readback. An
//! accepted HTTP request alone must never mean that a setting was saved.
use super::Wireless;
use crate::ubus;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

static IN_FLIGHT: AtomicBool = AtomicBool::new(false);
static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);
static APPLY_JOB: Mutex<ApplyJob> = Mutex::new(ApplyJob::idle());

struct ApplyJob {
    id: u64,
    state: &'static str,
    started_at: Option<Instant>,
    error: Option<String>,
}
impl ApplyJob {
    const fn idle() -> Self {
        Self {
            id: 0,
            state: "idle",
            started_at: None,
            error: None,
        }
    }
}

struct WriteGuard;
impl WriteGuard {
    fn acquire() -> Option<Self> {
        IN_FLIGHT
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}
impl Drop for WriteGuard {
    fn drop(&mut self) {
        IN_FLIGHT.store(false, Ordering::Release);
    }
}

type Failure = (u16, String);
fn failed(error: String) -> Failure {
    (503, error)
}

#[derive(Clone)]
struct Change {
    path: String,
    value: String,
    firmware: bool,
}

fn scalar(key: &str, value: &Value) -> Result<String, Failure> {
    let text = match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => if *b { "1" } else { "0" }.into(),
        _ => return Err((400, format!("{key} must be a scalar value"))),
    };
    // Values are separate argv entries, never shell code. Do not strip
    // punctuation from SSIDs or passwords: that changes the user's secret.
    if text.chars().any(char::is_control) || text.len() > 256 {
        return Err((400, format!("{key} contains an unsupported value")));
    }
    Ok(text)
}

fn put(
    changes: &mut BTreeMap<String, Change>,
    current: &Wireless,
    path: String,
    value: String,
    firmware: bool,
) -> Result<(), Failure> {
    let section = path.rsplit_once('.').unwrap().0;
    if !current.0.contains_key(section) {
        return Err((
            422,
            format!("Wi-Fi section {section} is unavailable on this firmware"),
        ));
    }
    if let Some(previous) = changes.get(&path) {
        if previous.value != value {
            return Err((400, "Conflicting Wi-Fi settings".into()));
        }
    }
    changes.insert(
        path.clone(),
        Change {
            path,
            value,
            firmware,
        },
    );
    Ok(())
}

fn plan(body: &Value, current: &Wireless, guest: bool) -> Result<Vec<Change>, Failure> {
    let fields = body
        .as_object()
        .ok_or((400, "expected JSON object".into()))?;
    let mut changes = BTreeMap::new();
    for (key, input) in fields {
        let value = scalar(key, input)?;
        let mut paths = Vec::new();
        let mut firmware = false;
        if guest {
            let (option, bands): (&str, &[&str]) = match key.as_str() {
                "guest_ssid" => ("ssid", &["guest_2g", "guest_5g"]),
                "guest_key" => ("key", &["guest_2g", "guest_5g"]),
                "guest_encryption" => ("encryption", &["guest_2g", "guest_5g"]),
                "guest_disabled" => ("disabled", &["guest_2g", "guest_5g"]),
                "guest_disabled_2g" => ("disabled", &["guest_2g"]),
                "guest_disabled_5g" => ("disabled", &["guest_5g"]),
                "guest_hidden" => ("hidden", &["guest_2g", "guest_5g"]),
                "guest_isolate" => ("isolate", &["guest_2g", "guest_5g"]),
                "guest_active_time" => ("guest_active_time", &["guest_2g", "guest_5g"]),
                _ => return Err((400, "Unknown guest Wi-Fi setting".into())),
            };
            firmware = matches!(option, "disabled" | "guest_active_time");
            for band in bands {
                paths.push(format!("wireless.{band}.{option}"));
            }
        } else if matches!(key.as_str(), "wifi_onoff" | "wifi6_switch") {
            let path = current
                .mbb_path(key)
                .ok_or((422, "Wi-Fi master settings are unavailable".into()))?;
            firmware = path.starts_with("wireless.");
            paths.push(path);
        } else if matches!(key.as_str(), "radio2_disabled" | "radio5_disabled") {
            let radio = if key == "radio2_disabled" {
                "wifi0"
            } else {
                "wifi1"
            };
            firmware = true;
            paths.push(format!("wireless.{radio}.disabled"));
        } else if let Some((option, band @ ("2g" | "5g"))) = key.rsplit_once('_') {
            let radio = if band == "2g" { "wifi0" } else { "wifi1" };
            match option {
                "ssid" | "key" | "encryption" | "hidden" => {
                    paths.push(format!("wireless.main_{band}.{option}"))
                }
                "channel" | "htmode" | "txpower" => {
                    let option = if option == "txpower" {
                        "txpowerpercent"
                    } else {
                        option
                    };
                    paths.push(format!("wireless.{radio}.{option}"));
                    firmware = true;
                }
                _ => return Err((400, "Unknown Wi-Fi setting".into())),
            }
        } else {
            return Err((400, "Unknown Wi-Fi setting".into()));
        }
        for path in paths {
            let option = path.rsplit_once('.').unwrap().1;
            let valid = match option {
                "disabled" | "hidden" | "isolate" | "wifi_onoff" | "wifi6_switch" => {
                    matches!(value.as_str(), "0" | "1")
                }
                "ssid" => !value.is_empty() && value.len() <= 32,
                "key" => {
                    value.is_empty()
                        || (8..=63).contains(&value.len()) && value.is_ascii()
                        || value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
                }
                "txpowerpercent" => value.parse::<u8>().is_ok_and(|v| (1..=100).contains(&v)),
                "channel" => {
                    value.eq_ignore_ascii_case("auto")
                        || value == "0"
                        || value.parse::<u16>().is_ok_and(|v| {
                            if path.contains("wifi0") {
                                (1..=14).contains(&v)
                            } else {
                                (36..=144).contains(&v) && v % 4 == 0
                                    || [149, 153, 157, 161, 165].contains(&v)
                            }
                        })
                }
                "htmode" => {
                    value.eq_ignore_ascii_case("auto")
                        || ["EHT", "HE", "VHT", "HT"].iter().any(|prefix| {
                            value.strip_prefix(prefix).is_some_and(|width| {
                                matches!(width, "20" | "40")
                                    || !path.contains("wifi0") && matches!(width, "80" | "160")
                            })
                        })
                }
                "guest_active_time" => value.parse::<u32>().is_ok_and(|v| v <= 1440),
                // The firmware supports additional auth suites; preserve
                // existing clients rather than narrowing them to UI choices.
                "encryption" => !value.is_empty(),
                _ => false,
            };
            if !valid {
                return Err((400, format!("Invalid value for {key}")));
            }
            let stored = match option {
                "guest_active_time" => {
                    // Public clients use minutes; the firmware stores seconds.
                    (value.parse::<u32>().unwrap() * 60).to_string()
                }
                // B31 validate_wifi.sh enforces channel_rule=string(1,3) and stores '0' for auto.
                "channel" if value.eq_ignore_ascii_case("auto") => "0".into(),
                // B31 validate_wifi.sh expects capitalized "Auto" for htmode.
                "htmode" if value.eq_ignore_ascii_case("auto") => "Auto".into(),
                // B31 validate_wifi.sh expects "psk2+ccmp" rather than bare "psk2".
                "encryption" if value == "psk2" => "psk2+ccmp".into(),
                _ => value.clone(),
            };
            put(&mut changes, current, path, stored, firmware)?;
        }
    }

    if guest {
        let has_2g = fields.contains_key("guest_disabled_2g");
        let has_5g = fields.contains_key("guest_disabled_5g");
        let both_guest_sections = current.0.contains_key("wireless.guest_2g")
            && current.0.contains_key("wireless.guest_5g");
        if both_guest_sections && active_ap_count(current, &changes) == 3 {
            if has_2g && has_5g {
                return Err((
                    409,
                    "This firmware does not support 3 simultaneous APs (guest Wi-Fi on only one band while both 2.4 GHz and 5 GHz radios are active). Enable or disable both guest bands together.".into(),
                ));
            }
            if has_2g ^ has_5g {
                let (source, target) = if has_2g {
                    ("wireless.guest_2g.disabled", "wireless.guest_5g.disabled")
                } else {
                    ("wireless.guest_5g.disabled", "wireless.guest_2g.disabled")
                };
                if let Some(val) = changes.get(source).map(|c| c.value.clone()) {
                    put(&mut changes, current, target.into(), val, true)?;
                }
            }
        }
    } else {
        if let Some(input) = fields.get("wifi6_switch") {
            let enabled = scalar("wifi6_switch", input)? == "1";
            if !enabled
                && (current.get("zte_mbb.mlo") == "1" || current.get("zte_mbb.mlo_enable") == "1")
            {
                return Err((
                    409,
                    "Disable MLO before selecting Wi-Fi compatibility mode".into(),
                ));
            }
            for (radio, modern, legacy) in [("wifi0", "11beg", "11ng"), ("wifi1", "11bea", "11ac")]
            {
                let path = format!("wireless.{radio}.htmode");
                let width = changes
                    .get(&path)
                    .map(|c| c.value.clone())
                    .unwrap_or_else(|| current.get(&format!("{radio}.htmode")));
                let width = standard_width(&width, enabled, radio == "wifi0")?;
                // Width conversion is intentional when changing the standard.
                changes.remove(&path);
                put(&mut changes, current, path, width, true)?;
                put(
                    &mut changes,
                    current,
                    format!("wireless.{radio}.hwmode"),
                    if enabled { modern } else { legacy }.into(),
                    true,
                )?;
            }
        }
        // Auto-heal an asymmetric 3-AP guest configuration (which causes B31 QCMAP
        // mode=4 "unsupported wifi mode" and a 60s hostapd timeout) when enabling
        // Wi-Fi or re-enabling the second radio.
        let both_guest_sections = current.0.contains_key("wireless.guest_2g")
            && current.0.contains_key("wireless.guest_5g");
        if both_guest_sections {
            let g2 = current.get("guest_2g.disabled");
            let g5 = current.get("guest_5g.disabled");
            let asymmetric_guest =
                (g2 == "0" && g5 == "1") || (g2 == "1" && g5 == "0");
            let turning_on = changes
                .values()
                .any(|c| c.path.ends_with(".wifi_onoff") && c.value == "1");
            if asymmetric_guest && (turning_on || active_ap_count(current, &changes) == 3) {
                if g2 == "1" {
                    put(
                        &mut changes,
                        current,
                        "wireless.guest_2g.disabled".into(),
                        "0".into(),
                        true,
                    )?;
                }
                if g5 == "1" {
                    put(
                        &mut changes,
                        current,
                        "wireless.guest_5g.disabled".into(),
                        "0".into(),
                        true,
                    )?;
                }
            }
        }
    }
    Ok(changes.into_values().collect())
}

fn active_ap_count(current: &Wireless, changes: &BTreeMap<String, Change>) -> usize {
    let val = |path: &str| -> String {
        changes
            .get(path)
            .map(|c| c.value.clone())
            .unwrap_or_else(|| current.0.get(path).cloned().unwrap_or_default())
    };
    let mut count = 0;
    for (radio, main, guest) in [
        ("wireless.wifi0.disabled", "wireless.main_2g.disabled", "wireless.guest_2g.disabled"),
        ("wireless.wifi1.disabled", "wireless.main_5g.disabled", "wireless.guest_5g.disabled"),
    ] {
        if val(radio) == "1" {
            continue;
        }
        if val(main) != "1" {
            count += 1;
        }
        if val(guest) == "0" {
            count += 1;
        }
    }
    count
}

fn standard_width(width: &str, modern: bool, band2: bool) -> Result<String, Failure> {
    if width.eq_ignore_ascii_case("auto") {
        return Ok("Auto".into());
    }
    let number = width.trim_start_matches(|c: char| c.is_ascii_alphabetic());
    if !matches!(number, "20" | "40")
        && !(band2 && number == "20_40")
        && (band2 || !matches!(number, "80" | "160"))
    {
        return Err((
            422,
            "Cannot determine the current Wi-Fi channel width".into(),
        ));
    }
    Ok(format!(
        "{}{number}",
        if modern {
            "EHT"
        } else if band2 {
            "HT"
        } else {
            "VHT"
        }
    ))
}

trait Backend {
    fn read(&mut self) -> Result<Wireless, String>;
    fn set(&mut self, path: &str, value: &str) -> Result<(), String>;
    fn commit(&mut self, package: &str) -> Result<(), String>;
    fn apply(&mut self, firmware: &Value) -> Result<(), String>;
    fn ready(&mut self) -> Result<bool, String>;
    fn load_status(&mut self) -> Option<String> {
        None
    }
}

struct Device;
impl Backend for Device {
    fn read(&mut self) -> Result<Wireless, String> {
        Wireless::load()
    }
    fn set(&mut self, path: &str, value: &str) -> Result<(), String> {
        ubus::uci_set_no_commit(path, value)
    }
    fn commit(&mut self, package: &str) -> Result<(), String> {
        ubus::uci_commit(package)
    }
    fn apply(&mut self, firmware: &Value) -> Result<(), String> {
        let method = if firmware.as_object().is_some_and(Map::is_empty) {
            "reload"
        } else {
            "set"
        };
        let reply = ubus::call_bounded("zwrt_wlan", method, Some(&firmware.to_string()), 5)?;
        if reply["error"].as_str().is_some_and(|e| !e.is_empty())
            || matches!(reply["result"].as_str(), Some("failure" | "fail" | "error"))
        {
            return Err("The firmware rejected the Wi-Fi change".into());
        }
        Ok(())
    }
    fn ready(&mut self) -> Result<bool, String> {
        let report = ubus::call_bounded("zwrt_wlan", "report", Some("{}"), 1)?;
        Ok(report["load_status"].as_str() == Some("idle"))
    }
    fn load_status(&mut self) -> Option<String> {
        std::fs::read_to_string("/tmp/zte_wlan_load_status")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
}

fn commit_and_apply(
    backend: &mut impl Backend,
    body: &Value,
    guest: bool,
) -> Result<Option<Vec<Change>>, Failure> {
    let current = backend.read().map_err(failed)?;
    let changes = plan(body, &current, guest)?;
    let changed: Vec<_> = changes
        .iter()
        .filter(|c| current.0.get(&c.path) != Some(&c.value))
        .collect();
    if changed.is_empty() {
        return Ok(None);
    }
    let mut firmware = json!({});
    let mut packages = std::collections::BTreeSet::new();
    for change in changed {
        if change.firmware {
            let mut components = change.path.split('.');
            components.next();
            let section = components.next().unwrap();
            let option = components.next().unwrap();
            if firmware.get(section).is_none() {
                firmware[section] = json!({});
            }
            firmware[section][option] = json!(change.value);
        } else {
            backend.set(&change.path, &change.value).map_err(failed)?;
            packages.insert(change.path.split('.').next().unwrap());
        }
    }
    for package in packages {
        backend.commit(package).map_err(failed)?;
    }
    backend.apply(&firmware).map_err(failed)?;
    Ok(Some(changes))
}

fn verify(
    backend: &mut impl Backend,
    changes: &[Change],
    settle: Duration,
    wait: Duration,
) -> Result<Value, Failure> {
    // The firmware queues a reload. Allow it to start before treating idle
    // plus a UCI read as confirmation. Poll reads only; never replay a write.
    std::thread::sleep(settle);
    let deadline = Instant::now() + wait;
    loop {
        // The WLAN daemon can also be busy during reinitialization. Retry
        // only these bounded reads; a temporary report failure is not a
        // reason to replay the change or claim it was saved successfully.
        if backend.ready().unwrap_or(false) {
            if let Some(status) = backend.load_status() {
                if status.contains("failed") {
                    return Err((
                        503,
                        format!(
                            "Firmware failed to apply Wi-Fi ({status}). Check Wi-Fi settings and retry."
                        ),
                    ));
                }
            }
            if let Ok(actual) = backend.read() {
                if changes
                    .iter()
                    .all(|c| actual.0.get(&c.path) == Some(&c.value))
                {
                    return Ok(json!({"status":"ok", "verified":true}));
                }
            }
        }
        if Instant::now() >= deadline {
            return Err((503, "Wi-Fi settings were not confirmed after applying. Reconnect and check the actual state before retrying.".into()));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn save(
    backend: &mut impl Backend,
    body: &Value,
    guest: bool,
    settle: Duration,
    wait: Duration,
) -> Result<Value, Failure> {
    let Some(changes) = commit_and_apply(backend, body, guest)? else {
        return Ok(json!({"status":"ok", "note":"no changes"}));
    };
    verify(backend, &changes, settle, wait)
}

pub(super) fn apply_status() -> (u16, Value) {
    let job = APPLY_JOB.lock().unwrap_or_else(PoisonError::into_inner);
    let elapsed_ms = job
        .started_at
        .map(|t| t.elapsed().as_millis() as u64)
        .unwrap_or(0);
    (
        200,
        json!({
            "ok": true,
            "data": {
                "job_id": job.id,
                "state": job.state,
                "elapsed_ms": elapsed_ms,
                "error": job.error,
            }
        }),
    )
}

pub(super) fn settings_async(body: &[u8], guest: bool) -> (u16, Value) {
    let body: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => return (400, json!({"ok":false, "error":"invalid JSON"})),
    };
    let Some(guard) = WriteGuard::acquire() else {
        return (
            409,
            json!({"ok":false, "error":"Another Wi-Fi change is in progress"}),
        );
    };
    match commit_and_apply(&mut Device, &body, guest) {
        Ok(None) => (
            200,
            json!({"ok":true, "data":{"status":"ok", "note":"no changes", "verified":true}}),
        ),
        Ok(Some(changes)) => {
            let job_id = NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed);
            {
                let mut job = APPLY_JOB.lock().unwrap_or_else(PoisonError::into_inner);
                job.id = job_id;
                job.state = "applying";
                job.started_at = Some(Instant::now());
                job.error = None;
            }
            let spawned = std::thread::Builder::new()
                .name("wifi-verify".into())
                .spawn(move || {
                    let _guard = guard;
                    let result = verify(
                        &mut Device,
                        &changes,
                        Duration::from_secs(2),
                        Duration::from_secs(60),
                    );
                    let mut job = APPLY_JOB.lock().unwrap_or_else(PoisonError::into_inner);
                    if job.id == job_id {
                        match result {
                            Ok(_) => {
                                job.state = "verified";
                                job.error = None;
                            }
                            Err((_, msg)) => {
                                job.state = "failed";
                                job.error = Some(msg);
                            }
                        }
                    }
                });
            if spawned.is_err() {
                let mut job = APPLY_JOB.lock().unwrap_or_else(PoisonError::into_inner);
                if job.id == job_id {
                    job.state = "failed";
                    job.error = Some("failed to start verification task".into());
                }
                return (
                    503,
                    json!({"ok":false, "error":"failed to start verification task"}),
                );
            }
            (
                202,
                json!({"ok":true, "data":{"status":"applying", "job_id":job_id, "verified":false}}),
            )
        }
        Err((status, error)) => (status, json!({"ok":false, "error":error})),
    }
}

pub(super) fn settings(body: &[u8], guest: bool) -> (u16, Value) {
    let body: Value = match serde_json::from_slice(body) {
        Ok(value) => value,
        Err(_) => return (400, json!({"ok":false, "error":"invalid JSON"})),
    };
    let Some(_guard) = WriteGuard::acquire() else {
        return (
            409,
            json!({"ok":false, "error":"Another Wi-Fi change is in progress"}),
        );
    };
    match save(
        &mut Device,
        &body,
        guest,
        Duration::from_secs(2),
        // B31 standard changes take about 16 seconds; wider/DFS channels
        // may take longer. Both interactive clients allow a 90-second call.
        Duration::from_secs(60),
    ) {
        Ok(data) => (200, json!({"ok":true, "data":data})),
        Err((status, error)) => (status, json!({"ok":false, "error":error})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = "wireless.zte_mbb=zte_mbb\nwireless.zte_mbb.wifi_onoff='1'\nwireless.wifi0=wifi-device\nwireless.wifi0.hwmode='11beg'\nwireless.wifi0.htmode='EHT40'\nwireless.wifi0.txpowerpercent='100'\nwireless.wifi1=wifi-device\nwireless.wifi1.hwmode='11bea'\nwireless.wifi1.htmode='EHT160'\nwireless.wifi1.txpowerpercent='100'\nwireless.main_2g=wifi-iface\nwireless.main_2g.ssid='Example'\nwireless.main_5g=wifi-iface\nwireless.guest_2g=wifi-iface\nwireless.guest_5g=wifi-iface\n";

    struct Fake {
        config: Wireless,
        calls: Vec<String>,
        fail: &'static str,
        ignore: &'static str,
        unavailable_reports: usize,
        load_status: Option<String>,
    }
    impl Default for Fake {
        fn default() -> Self {
            Self {
                config: Wireless::from_show(CONFIG),
                calls: Vec::new(),
                fail: "",
                ignore: "",
                unavailable_reports: 0,
                load_status: None,
            }
        }
    }
    impl Backend for Fake {
        fn read(&mut self) -> Result<Wireless, String> {
            if self.fail == "read" {
                return Err("config unavailable".into());
            }
            Ok(Wireless(self.config.0.clone()))
        }
        fn set(&mut self, path: &str, value: &str) -> Result<(), String> {
            self.calls.push(format!("set {path}"));
            if self.fail == "set" {
                return Err("setting refused".into());
            }
            if self.ignore != path {
                self.config.0.insert(path.into(), value.into());
            }
            Ok(())
        }
        fn commit(&mut self, package: &str) -> Result<(), String> {
            self.calls.push(format!("commit {package}"));
            if self.fail == "commit" {
                Err("commit refused".into())
            } else {
                Ok(())
            }
        }
        fn apply(&mut self, firmware: &Value) -> Result<(), String> {
            self.calls.push("apply".into());
            if self.fail == "apply" {
                return Err("reload refused".into());
            }
            for (section, values) in firmware.as_object().unwrap() {
                for (option, value) in values.as_object().unwrap() {
                    let path = format!("wireless.{section}.{option}");
                    if self.ignore != path {
                        self.config.0.insert(path, value.as_str().unwrap().into());
                    }
                }
            }
            Ok(())
        }
        fn ready(&mut self) -> Result<bool, String> {
            if self.unavailable_reports > 0 {
                self.unavailable_reports -= 1;
                return Err("firmware is restarting".into());
            }
            Ok(self.fail != "busy")
        }
        fn load_status(&mut self) -> Option<String> {
            self.load_status.clone()
        }
    }
    fn run(fake: &mut Fake, body: Value, guest: bool) -> Result<Value, Failure> {
        save(fake, &body, guest, Duration::ZERO, Duration::ZERO)
    }

    #[test]
    fn omitted_switch_uses_real_modes_and_saves_in_existing_section() {
        let mut fake = Fake::default();
        assert_eq!(fake.config.wifi_standard(), Some("1"));
        assert!(!fake.config.0.contains_key("wireless.zte_mbb.wifi6_switch"));
        assert_eq!(
            run(&mut fake, json!({"wifi6_switch":"1"}), false).unwrap()["verified"],
            true
        );
        assert_eq!(fake.config.mbb("wifi6_switch"), "1");
        assert_eq!(fake.calls, ["apply"]);
        assert_eq!(fake.config.get("wifi0.hwmode"), "11beg");
        assert_eq!(fake.config.get("wifi1.hwmode"), "11bea");
        fake.calls.clear();
        assert_eq!(
            run(&mut fake, json!({"wifi6_switch":"1"}), false).unwrap()["note"],
            "no changes"
        );
        assert!(fake.calls.is_empty());
    }

    #[test]
    fn standard_changes_both_radios_and_preserves_channel_width() {
        let mut fake = Fake::default();
        run(&mut fake, json!({"wifi6_switch":"0"}), false).unwrap();
        assert_eq!(fake.config.get("wifi0.hwmode"), "11ng");
        assert_eq!(fake.config.get("wifi1.hwmode"), "11ac");
        assert_eq!(fake.config.get("wifi0.htmode"), "HT40");
        assert_eq!(fake.config.get("wifi1.htmode"), "VHT160");
        run(&mut fake, json!({"wifi6_switch":"1"}), false).unwrap();
        assert_eq!(fake.config.get("wifi0.hwmode"), "11beg");
        assert_eq!(fake.config.get("wifi1.hwmode"), "11bea");
        assert_eq!(fake.config.get("wifi1.htmode"), "EHT160");
        fake.config
            .0
            .insert("wireless.wifi0.htmode".into(), "EHT20_40".into());
        run(&mut fake, json!({"wifi6_switch":"0"}), false).unwrap();
        assert_eq!(fake.config.get("wifi0.htmode"), "HT20_40");
    }

    #[test]
    fn unknown_or_mixed_radio_modes_do_not_default_to_disabled() {
        let mut config = Wireless::from_show("wireless.zte_mbb=zte_mbb\n");
        assert_eq!(config.wifi_standard(), None);
        config
            .0
            .insert("wireless.wifi0.hwmode".into(), "11beg".into());
        config
            .0
            .insert("wireless.wifi1.hwmode".into(), "11ac".into());
        assert_eq!(config.wifi_standard(), None);
        config
            .0
            .insert("wireless.wifi0.hwmode".into(), "11ng".into());
        assert_eq!(config.wifi_standard(), Some("0"));
    }

    #[test]
    fn passwords_and_ssids_keep_literal_punctuation_on_both_paths() {
        let secret = "a'\"$`\\|<>;&12345";
        let mut fake = Fake::default();
        run(
            &mut fake,
            json!({"ssid_2g":"Guest's & Wi-Fi", "key_2g":secret}),
            false,
        )
        .unwrap();
        assert_eq!(fake.config.get("main_2g.key"), secret);
        assert_eq!(fake.config.get("main_2g.ssid"), "Guest's & Wi-Fi");
        run(&mut fake, json!({"guest_key":secret}), true).unwrap();
        assert_eq!(fake.config.get("guest_2g.key"), secret);
        assert_eq!(fake.config.get("guest_5g.key"), secret);
    }

    #[test]
    fn power_changes_use_the_firmware_percentage_interface() {
        let mut fake = Fake::default();
        run(&mut fake, json!({"txpower_2g":80, "txpower_5g":40}), false).unwrap();
        assert_eq!(fake.calls, ["apply"]);
        assert_eq!(fake.config.get("wifi0.txpowerpercent"), "80");
        assert_eq!(fake.config.get("wifi1.txpowerpercent"), "40");
    }

    #[test]
    fn guest_minutes_are_persisted_as_seconds_on_both_radios() {
        let mut fake = Fake::default();
        run(&mut fake, json!({"guest_active_time":"60"}), true).unwrap();
        assert_eq!(fake.calls, ["apply"]);
        assert_eq!(fake.config.get("guest_2g.guest_active_time"), "3600");
        assert_eq!(fake.config.get("guest_5g.guest_active_time"), "3600");
        run(&mut fake, json!({"guest_active_time":"0"}), true).unwrap();
        assert_eq!(fake.config.get("guest_2g.guest_active_time"), "0");
    }

    #[test]
    fn validates_all_targets_before_any_write() {
        for (body, guest) in [
            (json!({"ssid_2g":"valid", "wifi6_switch":{}}), false),
            (json!({"ssid_2g":"valid", "unknown_setting":"1"}), false),
            (json!({"ssid_2g":"valid", "txpower_5g":101}), false),
            (json!({"guest_ssid":"valid"}), true),
        ] {
            let mut fake = Fake::default();
            fake.config.0.remove("wireless.guest_5g");
            assert!(run(&mut fake, body, guest).is_err());
            assert!(fake.calls.is_empty());
        }
    }

    #[test]
    fn set_commit_apply_and_verification_errors_never_report_success() {
        for fail in ["read", "set", "commit", "apply", "busy"] {
            let mut fake = Fake {
                fail,
                ..Fake::default()
            };
            let error = run(&mut fake, json!({"ssid_2g":"Changed"}), false).unwrap_err();
            assert_eq!(error.0, 503);
            assert!(fake.calls.iter().filter(|c| *c == "apply").count() <= 1);
        }
        for (body, ignored, guest) in [
            (
                json!({"wifi6_switch":"1"}),
                "wireless.zte_mbb.wifi6_switch",
                false,
            ),
            (
                json!({"key_2g":"New-Example-Only"}),
                "wireless.main_2g.key",
                false,
            ),
            (
                json!({"guest_ssid":"Guest"}),
                "wireless.guest_5g.ssid",
                true,
            ),
        ] {
            let mut fake = Fake {
                ignore: ignored,
                ..Fake::default()
            };
            assert_eq!(run(&mut fake, body, guest).unwrap_err().0, 503);
            assert_eq!(fake.calls.iter().filter(|c| *c == "apply").count(), 1);
        }
    }

    #[test]
    fn waits_for_firmware_reinitialization_without_replaying_writes() {
        let mut fake = Fake {
            unavailable_reports: 2,
            ..Fake::default()
        };
        let result = save(
            &mut fake,
            &json!({"wifi6_switch":"0"}),
            false,
            Duration::ZERO,
            Duration::from_secs(5),
        )
        .unwrap();
        assert_eq!(result["verified"], true);
        assert_eq!(fake.calls, ["apply"]);
    }

    #[test]
    fn b31_contracts_normalize_channel_htmode_encryption_mlo_and_radio_disable() {
        let mut fake = Fake::default();
        fake.config
            .0
            .insert("wireless.wifi0.disabled".into(), "0".into());
        fake.config
            .0
            .insert("wireless.wifi0.channel".into(), "6".into());
        run(
            &mut fake,
            json!({
                "radio2_disabled": "1",
                "channel_2g": "auto",
                "htmode_2g": "auto",
                "encryption_2g": "psk2"
            }),
            false,
        )
        .unwrap();
        assert_eq!(fake.config.get("wifi0.disabled"), "1");
        assert_eq!(fake.config.get("wifi0.channel"), "0");
        assert_eq!(fake.config.get("wifi0.htmode"), "Auto");
        assert_eq!(fake.config.get("main_2g.encryption"), "psk2+ccmp");
        // Radio disable, channel, and htmode must go through firmware `zwrt_wlan set`,
        // not bare `uci set`.
        assert!(!fake
            .calls
            .iter()
            .any(|c| c == "set wireless.wifi0.disabled"));
        assert!(fake.calls.iter().any(|c| c == "apply"));

        // MLO conflict check must honor B31's `wireless.zte_mbb.mlo`.
        let mut mlo_fake = Fake::default();
        mlo_fake
            .config
            .0
            .insert("wireless.zte_mbb.mlo".into(), "1".into());
        let err = run(&mut mlo_fake, json!({"wifi6_switch": "0"}), false).unwrap_err();
        assert_eq!(err.0, 409);

        // `apply_status()` reports a well-formed JSON envelope.
        let (status, body) = apply_status();
        assert_eq!(status, 200);
        assert_eq!(body["ok"], true);
        assert!(body["data"]["state"].is_string());
    }

    #[test]
    fn guest_single_band_toggle_syncs_both_bands_to_avoid_qcmap_mode4() {
        let mut fake = Fake::default();
        fake.config.0.insert("wireless.wifi0.disabled".into(), "0".into());
        fake.config.0.insert("wireless.wifi1.disabled".into(), "0".into());
        fake.config.0.insert("wireless.main_2g.disabled".into(), "0".into());
        fake.config.0.insert("wireless.main_5g.disabled".into(), "0".into());
        fake.config.0.insert("wireless.guest_2g.disabled".into(), "1".into());
        fake.config.0.insert("wireless.guest_5g.disabled".into(), "1".into());

        // Enabling only guest_2g while both radios are active would produce 3 APs
        // (QCMAP mode=4 unsupported); save.rs must couple guest_5g too (4 APs, mode=7).
        run(&mut fake, json!({"guest_disabled_2g": "0"}), true).unwrap();
        assert_eq!(fake.config.get("guest_2g.disabled"), "0");
        assert_eq!(fake.config.get("guest_5g.disabled"), "0");

        // Disabling only guest_2g likewise disables guest_5g to return cleanly to 2 APs.
        run(&mut fake, json!({"guest_disabled_2g": "1"}), true).unwrap();
        assert_eq!(fake.config.get("guest_2g.disabled"), "1");
        assert_eq!(fake.config.get("guest_5g.disabled"), "1");
    }

    #[test]
    fn conflicting_explicit_guest_bands_in_dual_radio_mode_return_409() {
        let mut fake = Fake::default();
        fake.config.0.insert("wireless.wifi0.disabled".into(), "0".into());
        fake.config.0.insert("wireless.wifi1.disabled".into(), "0".into());
        fake.config.0.insert("wireless.main_2g.disabled".into(), "0".into());
        fake.config.0.insert("wireless.main_5g.disabled".into(), "0".into());
        fake.config.0.insert("wireless.guest_2g.disabled".into(), "1".into());
        fake.config.0.insert("wireless.guest_5g.disabled".into(), "1".into());

        let err = run(
            &mut fake,
            json!({"guest_disabled_2g": "0", "guest_disabled_5g": "1"}),
            true,
        )
        .unwrap_err();
        assert_eq!(err.0, 409);
        assert!(fake.calls.is_empty());
    }

    #[test]
    fn enabling_wifi_heals_asymmetric_three_ap_guest_state() {
        let mut fake = Fake::default();
        fake.config.0.insert("wireless.zte_mbb.wifi_onoff".into(), "0".into());
        fake.config.0.insert("wireless.wifi0.disabled".into(), "0".into());
        fake.config.0.insert("wireless.wifi1.disabled".into(), "0".into());
        fake.config.0.insert("wireless.main_2g.disabled".into(), "0".into());
        fake.config.0.insert("wireless.main_5g.disabled".into(), "0".into());
        fake.config.0.insert("wireless.guest_2g.disabled".into(), "0".into());
        fake.config.0.insert("wireless.guest_5g.disabled".into(), "1".into());

        run(&mut fake, json!({"wifi_onoff": "1"}), false).unwrap();
        assert_eq!(fake.config.get("zte_mbb.wifi_onoff"), "1");
        assert_eq!(fake.config.get("guest_2g.disabled"), "0");
        assert_eq!(fake.config.get("guest_5g.disabled"), "0");
    }

    #[test]
    fn verify_fails_fast_when_firmware_reports_power_on_failed() {
        let mut fake = Fake {
            load_status: Some("power_on failed".into()),
            ..Fake::default()
        };
        let err = save(
            &mut fake,
            &json!({"wifi_onoff": "0"}),
            false,
            Duration::ZERO,
            Duration::from_secs(30),
        )
        .unwrap_err();
        assert_eq!(err.0, 503);
        assert!(err.1.contains("power_on failed"));
    }
}
