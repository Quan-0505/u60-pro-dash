<div align="center">

# U60 Pro · 原生小屏

**Rust + Slint 重写的 320×480 原生界面 · 上滑解锁 · 蜂窝与速率一屏可见**

[![UI](https://img.shields.io/badge/UI-Slint_1.18-2379f4?style=flat-square)](u60-screen)
[![Target](https://img.shields.io/badge/target-aarch64--musl-805ad5?style=flat-square)](u60-screen)
[![Device](https://img.shields.io/badge/device-U60_Pro%20%C2%B7%20SDXPINN-0b5?style=flat-square)](#-设备与运行环境)
[![Agent](https://img.shields.io/badge/agent-zte--agent%20%C2%B7%20local_HTTP-lightgrey?style=flat-square)](#-架构)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**中兴 U60 Pro（MU5250 / SDXPINN）机身小屏的原生实现** · 与同机 `zte-agent` 配合，替代原厂闭源界面

[✨ 功能](#-功能) · [📱 界面](#-界面) · [🏗 架构](#-架构) · [🔧 编译](#-编译) · [🚀 部署与回滚](#-部署与回滚)

</div>

---

## 这是什么

U60 Pro 是一台 5G CPE，机身正面有一块 320×480 的屏。原厂那块屏由闭源二进制绘制，样式改不了、
数据也只能看它愿意给的。这个项目用 **Rust + Slint** 把它整套重写成原生界面：

- **静态链接单文件**，约 33 MB，aarch64-musl，直接跑在 DRM（`/dev/dri/card0`）上，软件渲染，不依赖 GPU 与窗口系统；
- **数据来自设备自身**：同机的 `zte-agent` 通过本地 HTTP 提供信号、流量、电量与设备信息，屏幕只做展示，不接管蜂窝、不动原厂分区；
- **不改系统**：界面进程独立运行，被 `native-service.sh` 托管（owner + guard），出问题时随时能换回原厂 UI。

装好之后，这块小屏就是一台随身 5G 路由器的状态面板：谁连着、跑多快、用的哪个频段、还剩多少电，一眼看完。

---

<a id="features"></a>
## ✨ 功能

| 功能 | 说明 |
| --- | --- |
| **锁屏** | 48px 时钟与日期、性能模式、运营商 + `5G SA` + 在线状态、服务小区信息（`n78 · 100 MHz · QCI 9 · 300 / 75 Mbps`）、上下行速率与实时曲线、在线设备数 / 电量 / 供电状态；底部上滑解锁 |
| **概览** | 运营商、上下行速率、在线设备数、本月流量、温度，以及 Wi-Fi 与代理服务状态 |
| **网络** | 蜂窝与 Wi-Fi 连接状态、代理服务入口（节点小宝 / WireGuard / Mihomo） |
| **应用** | 已安装服务列表，点开即为对应插件页；插件本身可带独立界面 |
| **设备** | 屏幕与外观（明暗、强调色、显示大小、不透明度）、锁屏与密码、语言、亮度、导航栏 |
| **解锁与密码** | 上滑解锁；可选 6–12 位数字密码，开启后进入设置与敏感操作需要验证 |
| **中英文** | 跟随系统语言切换，文案集中在 `u60-screen/locales/screen.json` |
| **事件驱动** | 数据来自 agent 的 `signal` / `traffic` / `battery` 三个 topic，屏幕休眠时暂停订阅，不做无谓轮询 |

<a id="ui"></a>
## 📱 界面

| 屏 | 内容 |
| --- | --- |
| 锁屏 | 时钟 · 日期 · 性能模式 · 运营商与服务小区 · 速率与曲线 · 设备数 / 电量 / 供电 · 上滑解锁 |
| 概览 | 运营商 · 速率 · 设备数 · 本月流量 · 温度 · Wi-Fi 与服务状态 |
| 网络 | 连接详情 · 代理服务 |
| 应用 | 已安装服务列表 |
| 设备 | 外观 · 锁屏与密码 · 语言 · 亮度 · 导航栏 |

底部三个标签（状态 / 连接 / 管理）负责切换；屏幕 320×480 RGB565，旋转 180°，触控走
`sitronix_ts_i2c`，坐标范围 `x=0..319 y=0..479`。

<a id="arch"></a>
## 🏗 架构

```
┌──────────────────────────────┐        ┌─────────────────────────┐
│  u60-screen（本仓库核心）      │        │  zte-agent              │
│  Rust + Slint，静态链接        │◄──────►│  本地 HTTP + Bearer     │
│  软件渲染 → /dev/dri/card0    │  JSON  │  信号 / 流量 / 电量     │
└──────────────────────────────┘        └─────────────────────────┘
              ▲                                     ▲
              │  native-service.sh（owner + guard）  │ 读设备状态
              └────────────── 设备（OpenWrt）────────┘
```

- 屏幕只消费 agent 的 API，不直接读 `/proc`、不解析 AT 命令，也不持久化任何凭据；
- agent 密码从进程环境 `ZTE_AGENT_PASSWORD` 读取，屏幕通过 `--local-agent` 向
  `127.0.0.1:6060` 换取 Bearer token，密码不落盘、不写日志；
- 屏幕与 agent **必须同版本**：协议对不上时表现为数据全是 `—`，而不是抛错。

---

<a id="build"></a>
## 🔧 编译

目标平台 `aarch64-unknown-linux-musl`，产物为单文件静态二进制。

```bash
# 交叉工具链（Debian/Ubuntu）
apt install gcc-aarch64-linux-gnu
rustup target add aarch64-unknown-linux-musl

export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=aarch64-linux-gnu-gcc
cd u60-screen
cargo build --locked --release --target aarch64-unknown-linux-musl \
  --no-default-features --features device
```

产物：`u60-screen/target/aarch64-unknown-linux-musl/release/u60-screen`

`--no-default-features --features device` 是必须的。默认的 `desktop` feature 走窗口后端，
板上既没有 Wayland 也没有 X11，编出来的东西跑不起来。

<a id="deploy"></a>
## 🚀 部署与回滚

设备上由 `native-service.sh` 托管。换二进制前先验证数据通道，再重启服务：

```bash
# 1. 送到设备
gzip -9 -c u60-screen | ssh root@192.168.0.1 'cat > /tmp/u60-screen.gz'
ssh root@192.168.0.1 'gunzip -f /tmp/u60-screen.gz && chmod 700 /tmp/u60-screen'

# 2. 先验证能不能连上 agent（这条不启动界面）
ssh root@192.168.0.1 '/tmp/u60-screen --agent 127.0.0.1:6060 --probe-agent --local-agent'
# 期望：agent: authenticated; signal, traffic and battery received

# 3. 停服务 → 换二进制 → 启动
ssh root@192.168.0.1 'touch /tmp/u60-dash-run/stop'
ssh root@192.168.0.1 'cp -f /tmp/u60-screen /data/local/tmp/u60-codex-native-screen/u60-screen'
ssh root@192.168.0.1 'sh /data/local/tmp/u60-codex-native-screen/native-service.sh run'
```

**两个容易踩的坑**：

- `native-service.sh` 必须用**绝对路径**启动。guard 匹配的是完整 cmdline，用相对路径会被判成异常并立刻回收进程；
- 换屏幕时确认 agent 版本一致，否则会出现「界面正常但数据全空」的假象。

**回滚**：换二进制前把当前文件拷到 `/tmp` 留底，需要时拷回并重启服务即可。原厂固件分区全程不受影响，
随时可以停掉服务回到厂商界面。

<a id="env"></a>
## 📡 设备与运行环境

| 项 | 值 |
| --- | --- |
| 设备 | 中兴 U60 Pro（MU5250，Qualcomm SDXPINN） |
| 系统 | OpenWrt 23.05.4 `sdx75/generic`，kernel 5.15.185-perf |
| 屏幕 | 320×480 RGB565，DRM `/dev/dri/card0`，旋转 180° |
| 触控 | `sitronix_ts_i2c`，坐标 `x=0..319 y=0..479` |
| 运行方式 | `u60-screen --device --service --local-agent --prefs appearance.json` |
| 数据来源 | `zte-agent` 本地 HTTP（Bearer token），端口 `6060` |

---

<a id="credits"></a>
## ❤️ 致谢

原生屏与 agent 的主体实现来自 [locez/u60-pro-dash](https://github.com/locez/u60-pro-dash)，
感谢原作者在闭源设备上把这套界面从零做出来。完整的工具链说明见
[`README.upstream.md`](README.upstream.md)，二次开发流程见 [`FORK.md`](FORK.md)，
界面语言配置见 [`docs/languages.md`](docs/languages.md)。

本仓库只包含源码与资源，不含设备凭据、`agent.env`、私钥或已编译二进制。

## 最近更新

**2026-11-11**

- 锁屏改为整屏上滑解锁，替代原来的长按 1 秒；
- 锁屏运营商行下方增加服务小区信息：频段、带宽、QCI 与签约速率；
- 状态栏 WiFi 图标重绘为对称坐标，修正小尺寸下的左右不均。
