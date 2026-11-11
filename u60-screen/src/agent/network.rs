//! Presentation state keeps service status, path, TCP and forwarding separate.
use super::Error;
use serde_json::Value;
use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};

pub struct Network {
    pub last_refresh: Instant,
    status: Option<(Instant, Value)>,
    status_error: Option<Error>,
    probe: Option<(Instant, Value)>,
    probe_error: Option<Error>,
    pending: Option<(u64, SocketAddr)>,
    next_id: u64,
}
impl Default for Network {
    fn default() -> Self {
        Self {
            last_refresh: Instant::now() - Duration::from_secs(30),
            status: None,
            status_error: None,
            probe: None,
            probe_error: None,
            pending: None,
            next_id: 100,
        }
    }
}
impl Network {
    pub fn refresh(&mut self) {
        self.last_refresh = Instant::now() - Duration::from_secs(30);
    }
    pub fn reset_target(&mut self) {
        self.probe = None;
        self.pending = None;
        self.probe_error = None;
        self.refresh();
    }
    pub fn suspend(&mut self) {
        self.pending = None;
    }
    pub fn disconnected(&mut self) {
        self.status = None;
        self.probe = None;
        self.pending = None;
        self.refresh();
    }
    pub fn accept_status(&mut self, result: Result<Value, Error>) {
        match result {
            Ok(value) => {
                self.status_error = None;
                self.status = Some((Instant::now(), value));
            }
            Err(error) => {
                self.status = None;
                self.status_error = Some(error);
            }
        }
        if !self.online() {
            self.probe = None;
            self.pending = None;
        }
    }
    fn status(&self) -> Option<&Value> {
        self.status
            .as_ref()
            .filter(|(at, _)| at.elapsed() < Duration::from_secs(60))
            .map(|(_, v)| v)
    }
    pub fn online(&self) -> bool {
        self.status().is_some_and(|s| s["state"] == "running")
    }
    pub fn label(&self) -> &'static str {
        match self.status().and_then(|v| v["state"].as_str()) {
            Some("running") => "服务运行中",
            Some("not_installed") => "尚未安装",
            Some("disabled" | "paused") => "已停止",
            Some("needs_login" | "awaiting_setup") => "需要登录 节点小宝",
            Some("pending_approval") => "等待设备批准",
            Some(_) => "正在连接",
            None => {
                if self.status_error.is_some() {
                    "状态查询失败"
                } else {
                    "等待查询状态"
                }
            }
        }
    }
    pub fn begin_probe(&mut self, address: SocketAddr) -> Option<u64> {
        if !self.online() || self.pending.is_some() {
            return None;
        }
        self.next_id = self.next_id.wrapping_add(1).max(100);
        self.pending = Some((self.next_id, address));
        self.probe_error = None;
        Some(self.next_id)
    }
    pub fn accept_probe(&mut self, id: u64, target: &str, result: Result<Value, Error>) {
        let Some((wanted, address)) = self.pending else {
            return;
        };
        if wanted != id {
            return;
        }
        self.pending = None;
        if target.parse::<SocketAddr>().ok() != Some(address) || !self.online() {
            return;
        }
        match result {
            Ok(value) => {
                self.probe = Some((Instant::now(), value));
                self.probe_error = None;
            }
            Err(error) => {
                self.probe = None;
                self.probe_error = Some(error);
            }
        }
    }
    pub fn rows(&self, _target: &str) -> Vec<(String, String)> {
        let mut rows = vec![("节点小宝".into(), self.label().into())];
        if let Some(status) = self.status() {
            rows.push(("本机隧道".into(), if status["tunnel_present"] == true {
                "NodeBabyLink 已创建".into()
            } else { "尚未创建".into() }));
        }
        rows.push(("远端连通性".into(), "尚未验证 · 请实际访问目标".into()));
        rows.push(("管理入口".into(), "节点小宝 App / 网页控制台".into()));
        if let Some(error) = &self.status_error {
            rows.push(("连接提示".into(), error.message().into()));
        }
        rows
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn running_tunnel_does_not_imply_peer_reachability() {
        let mut network = Network::default();
        network.accept_status(Ok(json!({"state":"running","tunnel_present":true})));
        assert!(network.online());
        assert_eq!(network.label(), "服务运行中");
        assert!(network.rows("").iter().any(|(k,v)| k == "远端连通性" && v.contains("尚未验证")));
        network.status.as_mut().unwrap().0 -= Duration::from_secs(61);
        assert!(!network.online());
        network.accept_status(Err(Error::Unavailable));
        assert_eq!(network.label(), "状态查询失败");
    }
}
