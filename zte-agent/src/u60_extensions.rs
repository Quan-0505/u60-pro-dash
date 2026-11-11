//! Device-owned extension controls. No caller-supplied executable or shell command.
use std::{fs, io::Write, path::Path, process::{Command, Stdio}, sync::Mutex};
use serde_json::{json, Value};
use crate::server::Method;
const CPU: &str = "/data/scripts/u60-cpu-mode.json";
pub const BATTERY: &str = "/data/plugins/battery_monitor/battery_monitor.conf";
const WIFI: &str = "/data/plugins/wifi-power-save/boot.sh";
static LOCK: Mutex<()> = Mutex::new(());
pub(crate) fn process_lock()->Result<fs::File,String>{
    use std::os::{fd::AsRawFd,unix::fs::OpenOptionsExt};
    let f=fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open("/tmp/u60-extension-control.lock").map_err(|e|e.to_string())?;
    if unsafe{libc::flock(f.as_raw_fd(),libc::LOCK_EX)}!=0{return Err(std::io::Error::last_os_error().to_string());}Ok(f)
}
fn read(p: impl AsRef<Path>) -> String { fs::read_to_string(p).unwrap_or_default().trim().to_string() }
fn load(p: &str) -> Result<Value,String> { serde_json::from_str(&fs::read_to_string(p).map_err(|e|e.to_string())?).map_err(|e|e.to_string()) }
fn atomic(p: &str, s: &str) -> Result<(),String> {
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = format!("{p}.6060-new");
    let mut f=fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(|e|e.to_string())?;
    f.write_all(s.as_bytes()).and_then(|_|f.sync_all()).map_err(|e|e.to_string())?;
    fs::rename(&tmp,p).map_err(|e|e.to_string())
}
fn run(program:&str,args:&[&str],input:Option<&str>)->Result<String,String>{
    let mut child=Command::new(program).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|e.to_string())?;
    if let Some(s)=input {child.stdin.take().unwrap().write_all(s.as_bytes()).map_err(|e|e.to_string())?;}
    else {drop(child.stdin.take());}
    let out=child.wait_with_output().map_err(|e|e.to_string())?;
    if !out.status.success(){return Err(format!("operation failed: {}",String::from_utf8_lossy(&out.stderr).chars().take(500).collect::<String>()));}
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
fn policies()->Vec<std::path::PathBuf>{
    fs::read_dir("/sys/devices/system/cpu/cpufreq").into_iter().flatten().flatten().filter(|e|e.file_name().to_string_lossy().starts_with("policy")).map(|e|e.path()).collect()
}
fn cpu()->Value{
    let saved=load(CPU).unwrap_or_else(|_| {
        let profile=load("/data/u60-dash/performance.json").unwrap_or(Value::Null);
        match profile["profile"].as_str(){Some(p)=>json!({"mode":match p{"balanced"=>"balance","saving"=>"powersave",_=>"performance"},"autostart":true}),None=>json!({"autostart":false})}
    });
    let rows:Vec<Value>=policies().iter().map(|p|json!({"policy":p.file_name().unwrap().to_string_lossy(),"governor":read(p.join("scaling_governor")),"frequency_khz":read(p.join("scaling_cur_freq")),"available":read(p.join("scaling_available_governors")),"min_khz":read(p.join("scaling_min_freq")),"max_khz":read(p.join("scaling_max_freq"))})).collect();
    let governor=rows.first().and_then(|v|v["governor"].as_str()).unwrap_or("unknown");
    let mut cores:Vec<Value>=fs::read_dir("/sys/devices/system/cpu").into_iter().flatten().flatten().filter(|e|{let s=e.file_name().to_string_lossy().to_string();s.strip_prefix("cpu").is_some_and(|n|!n.is_empty()&&n.chars().all(|c|c.is_ascii_digit()))}).map(|e|json!({"name":e.file_name().to_string_lossy(),"frequency_khz":read(e.path().join("cpufreq/scaling_cur_freq")),"governor":read(e.path().join("cpufreq/scaling_governor"))})).collect();
    cores.sort_by_key(|v|v["name"].as_str().unwrap_or("").to_string());
    json!({"mode":saved.get("mode").and_then(Value::as_str).unwrap_or(if governor=="schedutil"{"balance"}else{governor}),"autostart":saved["autostart"].as_bool().unwrap_or(false),"policies":rows,"cores":cores})
}
fn prior_limits(profile:&Value,policy:&str,hardware_min:u64,hardware_max:u64)->Result<(u64,u64),String>{
    if profile["version"]!=1 || !matches!(profile["profile"].as_str(),Some("balanced"|"performance"|"saving")){return Err("invalid saved performance profile".into());}
    let rows=profile["baseline"].as_array().ok_or("missing CPU baseline")?;
    let mut matching=rows.iter().filter(|r|r["id"].as_str()==Some(policy));
    let row=matching.next().ok_or("CPU baseline policy missing")?;
    if matching.next().is_some(){return Err("duplicate CPU baseline policy".into());}
    let min=row["min_khz"].as_u64().ok_or("invalid baseline minimum")?;
    let max=row["max_khz"].as_u64().ok_or("invalid baseline maximum")?;
    if min<hardware_min || max>hardware_max || min>max{return Err("CPU baseline limits out of range".into());}
    Ok((min,max))
}
fn cpu_set(v:&Value)->Result<Value,String>{
    let previous=cpu(); let mode=v.get("mode").and_then(Value::as_str).or(previous["mode"].as_str()).ok_or("mode required")?;
    if !["powersave","balance","performance","restore"].contains(&mode){return Err("unknown CPU mode".into());}
    if v.get("autostart").is_some_and(|x|!x.is_boolean()){return Err("autostart must be boolean".into());}
    let dirs=policies(); if dirs.is_empty(){return Err("CPU policies unavailable".into());}
    let mut writes=Vec::new();
    for p in &dirs{
        let available=read(p.join("scaling_available_governors"));
        let governor=match mode{"balance"|"restore"=>if available.split_whitespace().any(|s|s=="schedutil"){"schedutil"}else{"performance"},x=>x};
        if !available.split_whitespace().any(|s|s==governor){return Err("governor not supported".into());}
        if mode=="restore"{for (dst,src) in [("scaling_min_freq","cpuinfo_min_freq"),("scaling_max_freq","cpuinfo_max_freq")]{writes.push((p.join(dst),read(p.join(src))));}}
        else if Path::new("/data/u60-dash/performance.json").exists(){
            let profile=load("/data/u60-dash/performance.json")?;
            let min=read(p.join("cpuinfo_min_freq")).parse::<u64>().map_err(|_|"CPU hardware minimum unavailable")?;
            let max=read(p.join("cpuinfo_max_freq")).parse::<u64>().map_err(|_|"CPU hardware maximum unavailable")?;
            let (min,max)=prior_limits(&profile,&p.file_name().unwrap().to_string_lossy(),min,max)?;
            let current_min=read(p.join("scaling_min_freq")).parse::<u64>().map_err(|_|"CPU minimum unavailable")?;
            let limits=if max<current_min{[("scaling_min_freq",min),("scaling_max_freq",max)]}else{[("scaling_max_freq",max),("scaling_min_freq",min)]};
            for (key,value) in limits{writes.push((p.join(key),value.to_string()));}
        }
        writes.push((p.join("scaling_governor"),governor.to_string()));
    }
    let old:Vec<_>=writes.iter().map(|(p,_)|(p.clone(),read(p))).collect();
    let apply=(||{for (p,value) in &writes{fs::write(p,value).map_err(|e|e.to_string())?;if read(p)!=*value{return Err("CPU readback differs".to_string());}}
        atomic(CPU,&json!({"mode":mode,"autostart":v.get("autostart").unwrap_or(&previous["autostart"])}).to_string())})();
    if let Err(e)=apply{for(p,s)in old.iter().rev(){let _=fs::write(p,s);}return Err(e);}
    if Path::new("/data/u60-dash/performance.json").exists(){fs::remove_file("/data/u60-dash/performance.json").map_err(|e|e.to_string())?;}
    Ok(cpu())
}
pub fn restore_cpu(){if let Ok(v)=load(CPU){if v["autostart"]==true{let _lock=LOCK.lock().unwrap();if let Ok(_file)=process_lock(){if let Err(e)=cpu_set(&v){eprintln!("[u60 CPU restore] {e}");}}}}}
fn battery()->Result<Value,String>{
    let mut v=load(BATTERY)?;
    for (key,path) in [("adsp_state","/sys/class/qcom-battery/zte_adsp_chg_state_debug"),("restrict_chg","/sys/class/qcom-battery/restrict_chg"),("restrict_cur","/sys/class/qcom-battery/restrict_cur"),("input_online","/sys/class/power_supply/usb/online"),("battery_current_ua","/sys/class/power_supply/battery/current_now"),("battery_temp","/sys/class/power_supply/battery/temp")]{v[key]=json!(read(path));}
    v["monitor_running"]=json!(Path::new("/data/plugins/battery_monitor/monitor.pid").exists() && run("/bin/sh",&["-c","pidof battery_monitor >/dev/null || ps w | grep '[s]h /data/plugins/battery_monitor/battery_monitor' >/dev/null"],None).is_ok());
    Ok(v)
}
fn battery_set(v:&Value)->Result<Value,String>{
    let config=validate_battery(load(BATTERY)?,v)?;
    atomic(BATTERY,&config.to_string())?;
    battery()
}
fn validate_battery(mut config:Value,v:&Value)->Result<Value,String>{
    for (key,value) in v.as_object().ok_or("expected object")?{
        match key.as_str(){
            "charge_limit"|"bypass_power"|"auto_bypass"=>if !value.is_boolean(){return Err(format!("{key} must be boolean"));},
            "charge_val"=>if !value.as_u64().is_some_and(|n|(10..=100).contains(&n)){return Err("charge_val must be 10..100".into());},
            "charge_recover"=>if !value.as_u64().is_some_and(|n|(1..=20).contains(&n)){return Err("charge_recover must be 1..20".into());},
            "charge_cur"=>if !value.is_null() && !value.as_u64().is_some_and(|n|(500..=5000).contains(&n)){return Err("charge_cur must be null or 500..5000 mA".into());},
            _=>return Err(format!("unsupported field: {key}")),
        }
        config[key]=value.clone();
    }
    if config["bypass_power"]==true && config["auto_bypass"]==true{return Err("manual and automatic bypass cannot both be enabled".into());}
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config()->Value{json!({"charge_limit":true,"charge_val":70,"charge_recover":2,"bypass_power":false,"auto_bypass":true,"charge_cur":2000})}
    #[test]
    fn battery_controls_preserve_protection_and_validate_limits(){
        let v=validate_battery(config(),&json!({"charge_cur":null})).unwrap();
        assert_eq!(v["auto_bypass"],true);assert!(v["charge_cur"].is_null());assert_eq!(v["charge_val"],70);
        for bad in [json!({"charge_val":101}),json!({"charge_val":9}),json!({"charge_recover":0}),json!({"charge_cur":499}),json!({"charge_cur":5001}),json!({"auto_bypass":"true"}),json!({"bypass_power":true}),json!({"thermal_protection":false})]{assert!(validate_battery(config(),&bad).is_err(),"{bad}");}
        assert!(validate_battery(config(),&json!({"auto_bypass":false,"bypass_power":true})).is_ok());
    }
    #[test]
    fn malformed_cpu_mode_cannot_reach_a_sysfs_write(){assert!(cpu_set(&json!({"mode":"performance;reboot"})).is_err());}
    #[test]
    fn plugin_code_roundtrip_preserves_whitespace_quotes_and_rejects_stale_edits(){
        let file=std::env::temp_dir().join(format!("u60-plugin-roundtrip-{}-{}.db",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let db=file.to_str().unwrap();let source="\n<script>const text = '原插件';</script>\n\n";
        let sql=format!("CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO kv VALUES('custom_head','{}');",source.replace('\'',"''"));
        run("/usr/bin/sqlite3",&[db],Some(&sql)).unwrap();
        assert_eq!(plugin_read(db).unwrap()["source"],source);
        assert_eq!(plugin_update(db,&json!({"source":source,"previous_source":source})).unwrap()["source"],source);
        let updated="\n<script>const text = '更新';</script>\n";
        assert_eq!(plugin_update(db,&json!({"source":updated,"previous_source":source})).unwrap()["source"],updated);
        assert!(plugin_update(db,&json!({"source":"stale overwrite","previous_source":source})).is_err());
        assert_eq!(plugin_read(db).unwrap()["source"],updated);fs::remove_file(file).unwrap();
    }
}
fn kv(s:&str)->Value{let mut m=serde_json::Map::new();for line in s.lines(){if let Some((k,v))=line.split_once('='){m.insert(k.to_string(),json!(v));}}Value::Object(m)}
fn wifi()->Result<Value,String>{let state=run("/bin/sh",&[WIFI,"status"],None)?;Ok(json!({"saved":kv(&state),"runtime":run("/bin/sh",&[WIFI,"runtime"],None)?,"coverage":run("/bin/sh",&[WIFI,"coverage"],None)?}))}
fn wifi_set(v:&Value)->Result<Value,String>{
    let op=v["operation"].as_str().ok_or("operation required")?;let val=v["value"].as_str().ok_or("value required")?;
    match op{
        "psm" if ["on","off"].contains(&val)=>{run("/bin/sh",&[WIFI,"set-psm",val,"web"],None)?;},
        "coverage" if ["near","standard","wall"].contains(&val)=>{run("/bin/sh",&[WIFI,"set-coverage",val],None)?;},
        "interface" if ["up","down"].contains(&val)=>{let iface=v["interface"].as_str().ok_or("interface required")?;if !["wlan0","wlan1","wlan2","wlan3"].contains(&iface){return Err("invalid interface".into());}run("/bin/sh",&[WIFI,"set-iface",iface,val,"web"],None)?;},
        _=>return Err("unsupported Wi-Fi operation".into())
    }wifi()
}
const DB:&str="/data/ufi-tools/data/ufi-tools.db";
fn plugin_read(db:&str)->Result<Value,String>{
    // sqlite CLI appends a record newline. JSON quoting preserves the actual
    // leading/trailing whitespace instead of accidentally trimming plugin code.
    let quoted=run("/usr/bin/sqlite3",&[db,"select json_quote(value) from kv where key='custom_head';"],None)?;
    let source: String=serde_json::from_str(&quoted).map_err(|e|e.to_string())?;
    Ok(json!({"source":source}))
}
fn plugins()->Result<Value,String>{plugin_read(DB)}
fn plugin_update(db:&str,v:&Value)->Result<Value,String>{
    let source=v["source"].as_str().ok_or("source required")?;if source.len()>2*1024*1024{return Err("plugin source exceeds 2 MiB".into());}
    let old=plugin_read(db)?["source"].as_str().unwrap_or("").to_string();
    if v["previous_source"].as_str()!=Some(old.as_str()){return Err("plugin source changed in another console; reload before saving".into());}
    let sql=format!(".bail on\n.timeout 5000\nBEGIN IMMEDIATE;\nUPDATE kv SET value='{}' WHERE key='custom_head' AND value='{}';\nSELECT changes();\nCOMMIT;\n",source.replace('\'',"''"),old.replace('\'',"''"));
    if run("/usr/bin/sqlite3",&[db],Some(&sql))? != "1" { return Err("plugin source changed; reload before saving".into()); }
    plugin_read(db)
}
fn plugins_set(v:&Value)->Result<Value,String>{plugin_update(DB,v)}
fn startup()->Value{json!({"source":read("/etc/rc.local")})}
fn startup_set(v:&Value)->Result<Value,String>{
    let source=v["source"].as_str().ok_or("source required")?;if source.len()>65536 || source.contains('\0'){return Err("invalid script size or NUL".into());}
    if v["previous_source"].as_str()!=startup()["source"].as_str(){return Err("startup script changed; reload first".into());}
    run("/bin/sh",&["-n"],Some(source))?;
    let old=read("/etc/rc.local");atomic("/etc/rc.local.bak",&old)?;atomic("/etc/rc.local",source)?;
    use std::os::unix::fs::PermissionsExt;fs::set_permissions("/etc/rc.local",fs::Permissions::from_mode(0o755)).map_err(|e|e.to_string())?;Ok(startup())
}
pub fn route(method:&Method,path:&str,body:&[u8])->(u16,Value){
    let _lock=LOCK.lock().unwrap();
    let _file=match process_lock(){Ok(f)=>f,Err(e)=>return(503,json!({"ok":false,"error":e}))};
    let input=if *method==Method::Get{Ok(json!({}))}else{serde_json::from_slice::<Value>(body).map_err(|e|e.to_string())};
    let result=input.and_then(|v|match (*method,path){
        (Method::Get,"cpu")=>Ok(cpu()),(Method::Put,"cpu")=>cpu_set(&v),
        (Method::Get,"battery")=>battery(),(Method::Put,"battery")=>battery_set(&v),
        (Method::Get,"wifi")=>wifi(),(Method::Put,"wifi")=>wifi_set(&v),
        (Method::Get,"plugins")=>plugins(),(Method::Put,"plugins")=>plugins_set(&v),
        (Method::Get,"startup")=>Ok(startup()),(Method::Put,"startup")=>startup_set(&v),
        (Method::Get,"startup-backup")=>Ok(json!({"source":fs::read_to_string("/etc/rc.local.bak").map_err(|e|e.to_string())?})),
        (Method::Get,"nfc")=>crate::ubus::call("zwrt_nfc","zwrt_nfc_wifi_get",Some("{}")),
        (Method::Put,"nfc")=>{
            let switch=v["switch"].as_u64().filter(|n|*n<=1).ok_or("switch must be 0 or 1")?;
            crate::ubus::call("zwrt_nfc","zwrt_nfc_wifi_set_for_web",Some(&json!({"switch":switch,"flag":2}).to_string()))?;
            crate::ubus::call("zwrt_nfc","zwrt_nfc_wifi_get",Some("{}"))
        },
        _=>Err("unsupported extension route".into())
    });
    match result{Ok(v)=>(200,json!({"ok":true,"data":v})),Err(e)=>(400,json!({"ok":false,"error":e}))}
}

#[cfg(test)]
mod cpu_handoff_tests {
    use super::*;
    #[test]
    fn switching_back_to_legacy_preserves_the_original_frequency_limits() {
        let mut profile=json!({"version":1,"profile":"saving","baseline":[{"id":"policy0","min_khz":700000,"max_khz":1800000}]});
        assert_eq!(prior_limits(&profile,"policy0",600000,2200000).unwrap(),(700000,1800000));
        assert!(prior_limits(&profile,"policy1",600000,2200000).is_err());
        profile["baseline"][0]["max_khz"]=json!(2300000);
        assert!(prior_limits(&profile,"policy0",600000,2200000).is_err());
        profile["baseline"][0]["max_khz"]=json!(500000);
        assert!(prior_limits(&profile,"policy0",600000,2200000).is_err());
    }
}
