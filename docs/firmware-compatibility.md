# 固件兼容性说明与 AI Agent 自检清单

本仓库针对 **ZTE U60 Pro (MU5250)** 的特定固件进行了实机适配与验证。中兴不同地区版本（国行/海外）或不同小版本固件（如 B27、B30、B31 及后续版本）在 `ubus` 接口、UCI 配置键名、参数校验脚本以及系统服务行为上存在差异。

> [!IMPORTANT]
> **如果你打算在其他固件版本或其他相近机型上复用本仓库，强烈建议先通过 ADB/SSH 连接设备，让你的 AI Agent 按下方清单执行一次只读兼容性检查，确认差异后再编译部署。**

---

## 1. 当前已实机验证的环境

| 项目 | 实机确认值 |
|---|---|
| 设备型号 | ZTE U60 Pro (`MU5250`, 硬件 `MU5250_HW1.0`) |
| 实测固件 | **B31**（上游原仓库 README 记录为 `CN_ZTE_MU5250V1.0.0B27`） |
| 操作系统 | ZWRT (`OpenWrt 23.05.4 r24012-d8dd03c46f`, `aarch64_cortex-a53`) |
| 内核版本 | `Linux 5.15.194-perf` |
| 无线芯片 | Qualcomm `WCN7851` (`qcacld32`) |
| 屏幕 / 触控 / 背光 | 3.5" 320×480 DRM/KMS (`/dev/dri/card0`) · Sitronix (`/dev/input/event3`) · `/sys/class/leds/led:lcd/brightness` |
| 部署目录 | `/data/u60-dash/`（双程序配对部署：`zte-agent` + `u60-screen`） |

---

## 2. B31 固件已确认的特有契约与坑点

以下是实机抓包、脚本审计与实测确认的固件行为。移植到其他版本时，请重点核对这些项：

### 2.1 Wi-Fi 参数校验与写路径
B31 的 `zwrt_wlan` 通过 `/sbin/validate_wifi.sh` 与 `/sbin/wlan_set_scp_sbusd.sh` 执行强校验：

- **发射功率 (`txpowerpercent`)**：仅接受 `"40"`、`"80"`、`"100"`（`txpowerpercent_rule='or("40","80","100")'`）。传入 `50` 等其他百分比会直接返回 `503`。
- **信道 (`channel`)**：校验规则为 `string(1,3)`，自动信道在 UCI 中存为 `"0"`，不能传 `"auto"`（4 字节会被拒）。
- **频宽 (`htmode`)**：自动频宽为首字母大写的 `"Auto"`，传小写 `"auto"` 会被拒。
- **加密方式 (`encryption`)**：WPA2 必须为 `"psk2+ccmp"`，传 `"psk2"` 会被拒。支持枚举：`none`, `psk2+ccmp`, `psk-mixed+tkip+ccmp`, `psk+tkip+ccmp`, `sae-mixed`, `sae`, `owe`。
- **单频段开关 (`wifi0.disabled` / `wifi1.disabled`)**：必须走 `ubus call zwrt_wlan set '{"wifi0":{"disabled":"1"}}'`（与 `/sbin/wlan_set_scp_sbusd.sh` 一致）。若仅用 `uci set` + `zwrt_wlan reload`，会残留 `main_2g.disabled=0` 并可能触发 `/sbin/zte_post_wifi.sh` 死循环（`zte-agent` 内置 `wifi_watchdog` 兜底，但走 `zwrt_wlan set` 可从源头避免）。
- **QCMAP 严禁 3-AP 组合（`mode=4` 不支持）**：B31 的 `WCN7851` + `QCMAP_CLI` 仅支持 **1 AP (`mode=1`)、2 AP (`mode=2`, AP-AP)、4 AP (`mode=7`, AP-AP-AP-AP)**，**不支持 3 AP (`mode=4`, AP-AP-AP)**！当 2.4G 与 5G 主热点均开启时，如果只打开单频段访客网络（例如 `guest_2g.disabled=0` 且 `guest_5g.disabled=1`），`QCMAP_CLI` 会报 `QCMAP: unsupported wifi mode.` / `zte_wlan_set_para failed`，`/lib/wifi/zteqcawifi.sh` 会空等 `hostapd` 60 秒后写入 `power_on failed` 到 `/tmp/zte_wlan_load_status`，随后 `zte_topsw_wlan` 自动把 `wifi_onoff` 回滚为 `0`（表现为"Wi-Fi 开一会儿又自己关了，且每次卡 60 秒"）。因此原厂 `/sbin/wlan_set_scp_sbusd.sh` 与本仓库后端/前端均将 `guest_2g.disabled` 与 `guest_5g.disabled` 联动控制，并在检测到 `/tmp/zte_wlan_load_status` 为 `failed` 时立即失败返回。
- **Wi-Fi 7 开关 (`wifi6_switch`)**：B31 出厂配置中 `wireless.zte_mbb.wifi6_switch` 缺失，直到首次显式修改才写入；读取时需从 `wifi0.hwmode` / `wifi1.hwmode`（`11beg`/`11bea` vs `11ng`/`11ac`）推断。
- **MLO 键名差异**：UCI 中为 `wireless.zte_mbb.mlo`，而 `ubus call zwrt_wlan report` 返回的是 `mlo_enable`。切换兼容模式前需同时检查两者。
- **访客定时关闭 (`guest_active_time`)**：UCI 中以**秒**存储（出厂默认 `240` 秒），API 与前端以**分钟**展示与传入。
- **Wi-Fi 应用耗时与断连**：单次无线切换通常需要 8–16 秒，且会立刻断开 Wi-Fi 客户端。Web 控制台使用异步接口 `PUT /api/wifi/settings/async`（返回 `202`）+ 轮询 `GET /api/wifi/apply`，避免客户端被半开 TCP 连接卡死。

### 2.2 启动同步屏障与严禁禁用的守护进程
- 严禁通过 `/etc/init.d/<name> disable` 禁用 `/etc/config/zte_topsw_daemon.conf` 中列出的任何原厂守护进程，否则可能导致同步超时与重启循环（变砖风险）。
- 屏幕接管等操作必须等待同步完成：
  `ubus call zwrt_topsw_daemon.sync get_sync_info '{}'` 返回 `"noSyncModuleName": "sync success"`。

### 2.3 蜂窝网络、飞行模式与电量控制
- **飞行模式恢复**：在飞行模式下切换带宽策略，固件上报的离线枚举可能从 `LPM` 变为 `LOW_POWER`，恢复在线需确保 `AT+CFUN=1` 路径有效。
- **移动数据字段怪癖**：`/api/modem/data` 在 B31 上可能同时出现 `connect_status: "ipv4_ipv6_connected"` 与 `enable: 0`。
- **充电策略**：直供电与充电上限控制依赖 `/sys/class/power_supply/` 与原厂接口，不同内核版本节点路径或反转语义可能不同。

### 2.4 系统日志与 Wakelock
- **无 `logd`**：B31 默认未运行 `logd`，执行 `logread` 会报错 `Failed to find log object: Not found`。排障请查看 `/data/u60-dash/agent.log` 和 `/data/u60-dash/screen.log`。
- **Wakelock 方法名**：`ubus call zwrt_zte_sleep_faw.wakelock createWakelock` 在 B31 上返回方法不存在（Tailscale 模块中仅作非致命告警日志，不影响主功能）。

---

## 3. AI Agent 兼容性检查清单（复用前必跑）

> 你可以直接把下面这段提示词连同本文件交给你的 AI Agent（如 Claude Code / Antigravity / Codex），让它在**不修改任何设备配置**的前提下完成目标固件的兼容性体检：

```text
请阅读 docs/firmware-compatibility.md，并通过 adb shell（仅执行只读命令，禁止修改配置或禁用任何 init.d 服务）
对当前连接的设备运行第 3 节的兼容性检查命令，逐项对比本仓库代码中的假设（zte-agent/src/wifi/save.rs、
zte-agent/src/wifi.rs、u60-web/src/settings.ts、u60-screen/src/features/settings.rs、scripts/dash/deploy.py），
输出一份兼容/不兼容项清单及需要修改的文件位置。
```

### 3.1 基础环境与硬件节点（只读）

```sh
adb shell '
  echo "=== OS & Kernel ==="
  cat /etc/openwrt_release 2>/dev/null || cat /etc/os-release 2>/dev/null
  uname -a
  echo "=== Storage (/data >= 150 MiB needed) ==="
  df -h /data
  echo "=== Display / Touch / Backlight ==="
  ls -l /dev/dri/card0 /dev/input/event* /sys/class/leds/led:lcd/brightness 2>/dev/null
  echo "=== Sync Barrier ==="
  ubus call zwrt_topsw_daemon.sync get_sync_info "{}"
  echo "=== Boot Hook & Tools ==="
  grep -n "start_zte_agent" /etc/rc.local 2>/dev/null || true
  for t in flock sha256sum readlink nohup ubus uci iw hostapd_cli; do
    command -v "$t" >/dev/null && echo "tool:$t=ok" || echo "tool:$t=MISSING"
  done
'
```

### 3.2 Wi-Fi 契约与校验规则（只读，不含密码）

```sh
adb shell '
  echo "=== validate_wifi.sh rules ==="
  grep -E "rule=|txpower|channel|htmode|encryption|guest_active" /sbin/validate_wifi.sh 2>/dev/null || echo "validate_wifi.sh not found"
  echo "=== wireless UCI schema (keys/non-secret values only) ==="
  uci show wireless | grep -vE "\.(key|password|sae_password|nasid)="
  echo "=== zwrt_wlan ubus signatures ==="
  ubus -v list zwrt_wlan
  echo "=== zwrt_wlan report (non-secret) ==="
  ubus call zwrt_wlan report "{}"
'
```

**核对要点：**
1. `txpowerpercent_rule` 是否仍为 `40 / 80 / 100`？若变化，调整 `u60-web/src/settings.ts` 与 `u60-screen/src/features/settings.rs`。
2. `channel` 自动值是否为 `"0"`，`htmode` 自动值是否为 `"Auto"`，`encryption` 的 WPA2 是否为 `"psk2+ccmp"`？若变化，调整 `zte-agent/src/wifi/save.rs` 的归一化逻辑与前端选项。
3. `wireless.zte_mbb` 是否存在？MLO 键名是 `mlo` 还是 `mlo_enable`？
4. 2.4 GHz / 5 GHz 对应节名是否仍为 `wifi0`/`wifi1`、`main_2g`/`main_5g`、`guest_2g`/`guest_5g`，AP 接口名是否仍为 `wlan0`/`wlan2`？

### 3.3 蜂窝、电量与系统服务 ubus 对象（只读）

```sh
adb shell '
  echo "=== Key ubus objects ==="
  ubus list | grep -E "zwrt_|zte_|network|system" | sort
  echo "=== Power supply sysfs ==="
  ls -la /sys/class/power_supply/ 2>/dev/null
  echo "=== Daemon sync list (DO NOT DISABLE THESE) ==="
  cat /etc/config/zte_topsw_daemon.conf 2>/dev/null | head -n 60
  echo "=== Original UI init script ==="
  ls -la /etc/init.d/zte_topsw_devui 2>/dev/null
'
```

### 3.4 部署前预检命令

确认以上各项与仓库实现一致后，先运行只读预检：

```bash
bash dash.sh check
```

预检通过且 `/data` 剩余空间充足（>= 150 MiB）后，再执行配对构建与安装：

```bash
bash dash.sh install
bash dash.sh status
```
