import { useSyncExternalStore } from "react";
import productMessages from "./messages.json";
export const languages = {
  "zh-Hans": "简体中文",
  "zh-Hant": "繁體中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
};
export type Locale = keyof typeof languages;
const messages: Record<string, string[]> = {
  Overview: ["概览", "概覽", "概要", "개요"],
  Connections: ["连接", "連線", "接続", "연결"],
  "Connected devices": ["连接设备", "連線裝置", "接続端末", "연결된 기기"],
  "Mobile network": ["移动网络", "行動網路", "モバイル回線", "모바일 네트워크"],
  "Networking & services": [
    "组网与服务",
    "組網與服務",
    "ネットワークとサービス",
    "네트워크 및 서비스",
  ],
  "Local network": [
    "局域网",
    "區域網路",
    "ローカルネットワーク",
    "로컬 네트워크",
  ],
  "System settings": ["系统设置", "系統設定", "システム設定", "시스템 설정"],
  "Device extensions": ["设备扩展", "裝置擴充", "デバイス拡張", "기기 확장"],
  "CPU mode": ["CPU 模式", "CPU 模式", "CPU モード", "CPU 모드"],
  "Hybrid direct power": ["混合直供", "混合直供", "ハイブリッド直供", "하이브리드 직공급"],
  "Plugin management": ["插件管理", "外掛管理", "プラグイン管理", "플러그인 관리"],
  "Read-only plugin catalog": ["只读插件目录", "唯讀外掛目錄", "プラグイン一覧（読取専用）", "읽기 전용 플러그인 목록"],
  "CPU mode and startup restore": ["CPU 模式与开机恢复", "CPU 模式與開機還原", "CPU mode and startup restore", "CPU mode and startup restore"],
  "Uses the device CPU policies and reads back the applied governor and frequencies.": ["直接控制设备 CPU 策略，并回读实际 governor 和频率。", "直接控制裝置 CPU 策略，並讀回實際 governor 與頻率。", "Uses the device CPU policies and reads back the applied governor and frequencies.", "Uses the device CPU policies and reads back the applied governor and frequencies."],
  "Actual CPU status": ["CPU 实际状态", "CPU 實際狀態", "Actual CPU status", "Actual CPU status"],
  "Live governor and frequency values read from each CPU policy.": ["从每个 CPU 策略读取当前 governor 和频率。", "從每個 CPU 策略讀取目前 governor 與頻率。", "Live governor and frequency values read from each CPU policy.", "Live governor and frequency values read from each CPU policy."],
  "Balanced uses schedutil where available and falls back to performance when required by the device.": ["设备支持时使用 schedutil；否则回退到 performance。", "裝置支援時使用 schedutil；否則回退到 performance。", "Balanced uses schedutil where available and falls back to performance when required by the device.", "Balanced uses schedutil where available and falls back to performance when required by the device."],
  "Restore this mode at startup": ["开机时恢复此模式", "開機時還原此模式", "Restore this mode at startup", "Restore this mode at startup"],
  "Reapply the selected CPU mode when the router starts.": ["路由器启动时重新应用所选 CPU 模式。", "路由器啟動時重新套用所選 CPU 模式。", "Reapply the selected CPU mode when the router starts.", "Reapply the selected CPU mode when the router starts."],
  "Apply CPU mode": ["应用 CPU 模式", "套用 CPU 模式", "Apply CPU mode", "Apply CPU mode"],
  "Changes are not applied yet.": ["修改尚未应用。", "修改尚未套用。", "Changes are not applied yet.", "Changes are not applied yet."],
  "Current settings are applied.": ["当前设置已应用。", "目前設定已套用。", "Current settings are applied.", "Current settings are applied."],
  "Restore resets frequency limits to the hardware range. Temperature protection is still managed by the device.": ["恢复会将频率上下限重置为硬件范围，温度保护仍由设备管理。", "還原會將頻率上下限重設為硬體範圍，溫度保護仍由裝置管理。", "Restore resets frequency limits to the hardware range. Temperature protection is still managed by the device.", "Restore resets frequency limits to the hardware range. Temperature protection is still managed by the device."],
  "The device thermal controller remains active. CPU mode changes are coordinated with the upstream performance profiles.": ["设备温控继续生效；CPU 模式与上游性能预设共享控制锁。", "裝置溫控會繼續生效；CPU 模式與上游效能預設共用控制鎖。", "The device thermal controller remains active. CPU mode changes are coordinated with the upstream performance profiles.", "The device thermal controller remains active. CPU mode changes are coordinated with the upstream performance profiles."],
  "Startup restore": ["开机恢复", "開機還原", "Startup restore", "Startup restore"],
  "CPU policies": ["CPU 策略数", "CPU 策略數", "CPU policies", "CPU policies"],
  Policy: ["策略", "策略", "Policy", "Policy"],
  Governor: ["Governor", "Governor", "Governor", "Governor"],
  "Current frequency": ["当前频率", "目前頻率", "Current frequency", "Current frequency"],
  "Min / max": ["最低 / 最高", "最低 / 最高", "Min / max", "Min / max"],
  "No CPU frequency policies were reported by this device.": ["设备未报告 CPU 频率策略。", "裝置未回報 CPU 頻率策略。", "No CPU frequency policies were reported by this device.", "No CPU frequency policies were reported by this device."],
  "Restore system defaults": ["恢复系统默认范围", "還原系統預設範圍", "Restore system defaults", "Restore system defaults"],
  "Hybrid direct power and charging": ["混合直供与充电策略", "混合直供與充電策略", "Hybrid direct power and charging", "Hybrid direct power and charging"],
  "Edits the existing resident battery monitor configuration shared with the legacy console.": ["编辑常驻电池监控配置；此配置与原定制后台共用。", "編輯常駐電池監控設定；此設定與原客製後台共用。", "Edits the existing resident battery monitor configuration shared with the legacy console.", "Edits the existing resident battery monitor configuration shared with the legacy console."],
  "Manual hybrid direct power": ["手动混合直供", "手動混合直供", "Manual hybrid direct power", "Manual hybrid direct power"],
  "Request direct supply when external power is connected; the monitor may leave direct mode under high load.": ["接入外部电源时请求直供；负载较高时监控程序可能退出直供。", "接上外部電源時請求直供；負載較高時監控程式可能退出直供。", "Request direct supply when external power is connected; the monitor may leave direct mode under high load.", "Request direct supply when external power is connected; the monitor may leave direct mode under high load."],
  "Automatic hybrid direct power": ["自动混合直供", "自動混合直供", "Automatic hybrid direct power", "Automatic hybrid direct power"],
  "Let the resident monitor enter or leave direct supply according to its current rules.": ["由常驻监控程序按现有规则自动进入或退出直供。", "由常駐監控程式按現有規則自動進入或退出直供。", "Let the resident monitor enter or leave direct supply according to its current rules.", "Let the resident monitor enter or leave direct supply according to its current rules."],
  "Charge limit protection": ["充电上限保护", "充電上限保護", "Charge limit protection", "Charge limit protection"],
  "Stop charging at the configured level and resume after the recovery gap.": ["达到设定电量后停止充电，降至回差值后恢复。", "達到設定電量後停止充電，降至回差值後恢復。", "Stop charging at the configured level and resume after the recovery gap.", "Stop charging at the configured level and resume after the recovery gap."],
  "Stop charging at (%)": ["停止充电电量 (%)", "停止充電電量 (%)", "Stop charging at (%)", "Stop charging at (%)"],
  "Resume gap (%)": ["恢复充电回差 (%)", "恢復充電回差 (%)", "Resume gap (%)", "Resume gap (%)"],
  "Charge current limit (mA)": ["充电限流 (mA)", "充電限流 (mA)", "Charge current limit (mA)", "Charge current limit (mA)"],
  "Leave blank to restore the stock current limit.": ["留空可恢复原厂限流值。", "留空可還原原廠限流值。", "Leave blank to restore the stock current limit.", "Leave blank to restore the stock current limit."],
  "Save power settings": ["保存电源设置", "儲存電源設定", "Save power settings", "Save power settings"],
  "Manual and automatic direct power are mutually exclusive. Actual charging and supply behavior remains controlled by the resident battery monitor.": ["手动和自动直供互斥；实际充电和供电仍由常驻电池监控程序控制。", "手動與自動直供互斥；實際充電與供電仍由常駐電池監控程式控制。", "Manual and automatic direct power are mutually exclusive. Actual charging and supply behavior remains controlled by the resident battery monitor.", "Manual and automatic direct power are mutually exclusive. Actual charging and supply behavior remains controlled by the resident battery monitor."],
  "Battery controller status": ["电池控制器状态", "電池控制器狀態", "Battery controller status", "Battery controller status"],
  "Configuration and observed device state are shown separately.": ["分开展示配置值和设备实测状态。", "分開顯示設定值與裝置實測狀態。", "Configuration and observed device state are shown separately.", "Configuration and observed device state are shown separately."],
  Monitor: ["监控程序", "監控程式", "Monitor", "Monitor"],
  "Not confirmed": ["未确认运行", "未確認執行", "Not confirmed", "Not confirmed"],
  "USB input": ["USB 输入", "USB 輸入", "USB input", "USB input"],
  Offline: ["离线", "離線", "Offline", "Offline"],
  "Battery temperature": ["电池温度", "電池溫度", "Battery temperature", "Battery temperature"],
  "Battery current": ["电池电流", "電池電流", "Battery current", "Battery current"],
  "Manual direct power request": ["手动直供请求", "手動直供要求", "Manual direct power request", "Manual direct power request"],
  "Automatic direct power": ["自动直供", "自動直供", "Automatic direct power", "Automatic direct power"],
  "Charge limit": ["充电上限", "充電上限", "Charge limit", "Charge limit"],
  "Charger state": ["充电器状态", "充電器狀態", "Charger state", "Charger state"],
  "Charge restriction": ["充电限制", "充電限制", "Charge restriction", "Charge restriction"],
  "Current restriction": ["限流状态", "限流狀態", "Current restriction", "Current restriction"],
  "Installed plugin extensions": ["已安装页面插件", "已安裝頁面外掛", "Installed plugin extensions", "Installed plugin extensions"],
  "Manage the extension HTML shared with the legacy console.": ["管理与原定制后台共用的插件页面源代码。", "管理與原客製後台共用的外掛頁面原始碼。", "Manage the extension HTML shared with the legacy console.", "Manage the extension HTML shared with the legacy console."],
  "Read current source": ["读取当前源码", "讀取目前原始碼", "Read current source", "Read current source"],
  "Plugin code is executable and may affect the whole management page. The 27-item store catalog below is informational only; it does not install or run catalog plugins.": ["插件代码可执行并影响整个管理页面。下方 27 项商店目录仅供查询，不会安装或运行目录插件。", "外掛程式碼可執行並影響整個管理頁面。下方 27 項商店目錄僅供查詢，不會安裝或執行目錄外掛。", "Plugin code is executable and may affect the whole management page. The 27-item store catalog below is informational only; it does not install or run catalog plugins.", "Plugin code is executable and may affect the whole management page. The 27-item store catalog below is informational only; it does not install or run catalog plugins."],
  "Recognized installed plugin blocks": ["识别到的已安装插件块", "辨識到的已安裝外掛區塊", "Recognized installed plugin blocks", "Recognized installed plugin blocks"],
  "Remove to draft": ["移除到草稿", "移除至草稿", "Remove to draft", "Remove to draft"],
  "No complete marked plugin blocks were found in the current source.": ["当前源码中未找到完整标记的插件块。", "目前原始碼中找不到完整標記的外掛區塊。", "No complete marked plugin blocks were found in the current source.", "No complete marked plugin blocks were found in the current source."],
  "Plugin source code": ["插件源码", "外掛原始碼", "Plugin source code", "Plugin source code"],
  "Import plugin file to draft": ["导入插件文件到草稿", "匯入外掛檔案至草稿", "Import plugin file to draft", "Import plugin file to draft"],
  "Export source": ["导出源码", "匯出原始碼", "Export source", "Export source"],
  "Save plugin changes": ["保存插件修改", "儲存外掛修改", "Save plugin changes", "Save plugin changes"],
  "Unsaved changes.": ["有未保存的修改。", "有未儲存的修改。", "Unsaved changes.", "Unsaved changes."],
  "Source matches the router.": ["源码与设备一致。", "原始碼與裝置一致。", "Source matches the router.", "Source matches the router."],
  "Read-only plugin store catalog": ["插件商店只读目录", "外掛商店唯讀目錄", "Read-only plugin store catalog", "Read-only plugin store catalog"],
  "Browse the store snapshot to plan later interface adaptations.": ["浏览商店快照，为后续界面适配做准备。", "瀏覽商店快照，為後續介面調適做準備。", "Browse the store snapshot to plan later interface adaptations.", "Browse the store snapshot to plan later interface adaptations."],
  "This page only reads and exports the catalog. It has no install, update or execute action for store plugins.": ["此页仅读取和导出目录，不提供商店插件安装、更新或执行操作。", "此頁僅讀取與匯出目錄，不提供商店外掛安裝、更新或執行操作。", "This page only reads and exports the catalog. It has no install, update or execute action for store plugins.", "This page only reads and exports the catalog. It has no install, update or execute action for store plugins."],
  "Search name, author, function or model": ["搜索名称、作者、功能或型号", "搜尋名稱、作者、功能或型號", "Search name, author, function or model", "Search name, author, function or model"],
  Category: ["用途分类", "用途分類", "Category", "Category"],
  Sort: ["排序", "排序", "Sort", "Sort"],
  "All categories": ["全部分类", "全部分類", "All categories", "All categories"],
  "Store order": ["商店原始顺序", "商店原始順序", "Store order", "Store order"],
  "Latest update": ["最近更新", "最近更新", "Latest update", "Latest update"],
  "Showing {0} of {1} plugins": ["显示 {0} / {1} 个插件", "顯示 {0} / {1} 個外掛", "Showing {0} of {1} plugins", "Showing {0} of {1} plugins"],
  "Snapshot date: {0}": ["快照日期：{0}", "快照日期：{0}", "Snapshot date: {0}", "Snapshot date: {0}"],
  "by {0}": ["作者：{0}", "作者：{0}", "by {0}", "by {0}"],
  "Updated {0}": ["更新于 {0}", "更新於 {0}", "Updated {0}", "Updated {0}"],
  "{0} downloads": ["下载 {0} 次", "下載 {0} 次", "{0} downloads", "{0} downloads"],
  "The original store did not provide a description.": ["原商店未提供简介。", "原商店未提供簡介。", "The original store did not provide a description.", "The original store did not provide a description."],
  "No plugins match the current filters.": ["没有符合当前筛选条件的插件。", "沒有符合目前篩選條件的外掛。", "No plugins match the current filters.", "No plugins match the current filters."],
  "Clear filters": ["清空筛选", "清除篩選", "Clear filters", "Clear filters"],
  "Export catalog JSON": ["导出目录 JSON", "匯出目錄 JSON", "Export catalog JSON", "Export catalog JSON"],
  "Export plugin list CSV": ["导出插件清单 CSV", "匯出外掛清單 CSV", "Export plugin list CSV", "Export plugin list CSV"],
  "This is a snapshot of the catalog visible from the 2333 store at the recorded date. Descriptions and compatibility text are store-provided; compatibility has not been validated plugin by plugin.": ["这是记录日期时 2333 商店可见目录的快照。简介与兼容信息来自商店，尚未逐个验证兼容性。", "這是記錄日期時 2333 商店可見目錄的快照。簡介與相容資訊來自商店，尚未逐一驗證相容性。", "This is a snapshot of the catalog visible from the 2333 store at the recorded date. Descriptions and compatibility text are store-provided; compatibility has not been validated plugin by plugin.", "This is a snapshot of the catalog visible from the 2333 store at the recorded date. Descriptions and compatibility text are store-provided; compatibility has not been validated plugin by plugin."],
  "Loading current plugin source…": ["正在读取当前插件源码…", "正在讀取目前外掛原始碼…", "Loading current plugin source…", "Loading current plugin source…"],
  "Load installed plugins": ["载入已安装插件", "載入已安裝外掛", "Load installed plugins", "Load installed plugins"],
  Everyday: ["日常使用", "日常使用", "日常の管理", "일상 관리"],
  "Network management": [
    "网络管理",
    "網路管理",
    "ネットワーク管理",
    "네트워크 관리",
  ],
  "Device management": ["设备管理", "裝置管理", "端末管理", "기기 관리"],
  "Router overview": [
    "路由器概览",
    "路由器概覽",
    "ルーターの概要",
    "라우터 개요",
  ],
  "A clear view of your connection.": [
    "掌握连接与设备状态。",
    "掌握連線與裝置狀態。",
    "接続と端末の状態を確認します。",
    "연결 및 기기 상태를 확인하세요.",
  ],
  "Home layout": ["首页布局", "首頁配置", "ホームの配置", "홈 레이아웃"],
  "Screen appearance": ["屏幕外观", "螢幕外觀", "画面の外観", "화면 모양"],
  Connecting: ["正在连接", "正在連線", "接続中", "연결 중"],
  Reconnecting: ["正在重连", "正在重新連線", "再接続中", "다시 연결 중"],
  Live: ["已连接", "已連線", "接続済み", "연결됨"],
  Paused: ["已暂停", "已暫停", "一時停止", "일시 중지"],
  "Network topology": ["连接拓扑", "連線拓撲", "接続構成", "연결 구성"],
  "Traffic trend": ["速率趋势", "速率趨勢", "通信速度の推移", "속도 추이"],
  "No samples yet": [
    "尚无采样数据",
    "尚無取樣資料",
    "データ待ち",
    "샘플 대기 중",
  ],
  "Settings apply automatically.": [
    "修改后自动应用。",
    "修改後自動套用。",
    "変更は自動的に適用されます。",
    "변경 사항이 자동 적용됩니다.",
  ],
  "Applying…": ["正在应用…", "正在套用…", "適用中…", "적용 중…"],
  "Applied and verified": [
    "已生效并回读确认",
    "已生效並讀回確認",
    "適用と確認が完了しました",
    "적용 및 확인 완료",
  ],
  "Complete input to apply": [
    "完成输入后应用",
    "完成輸入後套用",
    "入力完了時に適用",
    "입력 완료 시 적용",
  ],
  "Cancel change": ["取消修改", "取消修改", "変更を取り消す", "변경 취소"],
  "Continue and apply": ["继续应用", "繼續套用", "適用する", "계속 적용"],
  "This change interrupts connections": [
    "此修改会中断连接",
    "此修改會中斷連線",
    "接続が中断されます",
    "연결이 끊길 수 있습니다",
  ],
  "The router has not confirmed the change.": [
    "设备尚未确认修改已生效。",
    "裝置尚未確認修改已生效。",
    "端末が変更を確認していません。",
    "기기가 변경을 확인하지 않았습니다.",
  ],
  "Session expired": [
    "会话已过期，请重新登录",
    "工作階段已過期，請重新登入",
    "再度ログインしてください",
    "세션이 만료되었습니다",
  ],
  "Cannot reach the router": [
    "无法连接路由器",
    "無法連線路由器",
    "ルーターに接続できません",
    "라우터에 연결할 수 없습니다",
  ],
  "Read current state": [
    "读取当前状态",
    "讀取目前狀態",
    "現在の状態を確認",
    "현재 상태 읽기",
  ],
  "Finish editing": ["完成编辑", "完成編輯", "編集を完了", "편집 완료"],
  "Battery & power": [
    "电源与电池",
    "電源與電池",
    "電源とバッテリー",
    "전원 및 배터리",
  ],
  "Screen & security": [
    "屏幕与安全",
    "螢幕與安全",
    "画面とセキュリティ",
    "화면 및 보안",
  ],
  "Updates & backup": [
    "更新与备份",
    "更新與備份",
    "更新とバックアップ",
    "업데이트 및 백업",
  ],
  Diagnostics: ["诊断工具", "診斷工具", "診断ツール", "진단 도구"],
  Automation: ["自动化", "自動化", "自動化", "자동화"],
  "Hotspot settings": [
    "热点设置",
    "熱點設定",
    "アクセスポイント",
    "핫스팟 설정",
  ],
  "Wireless parameters": ["无线参数", "無線參數", "無線設定", "무선 설정"],
  "Connection settings": ["连接设置", "連線設定", "接続設定", "연결 설정"],
  "Signal & cells": ["信号与频段", "訊號與頻段", "電波とセル", "신호 및 셀"],
  "SIM & eSIM": ["SIM 与 eSIM", "SIM 與 eSIM", "SIM と eSIM", "SIM 및 eSIM"],
  "Carrier services": [
    "运营商服务",
    "電信業者服務",
    "通信事業者サービス",
    "통신사 서비스",
  ],
  "Access & forwarding": [
    "访问与转发",
    "存取與轉發",
    "アクセスと転送",
    "액세스 및 포워딩",
  ],
  "Log out": ["退出登录", "登出", "ログアウト", "로그아웃"],
  "China Unicom": ["中国联通", "中國聯通", "中国聯通", "차이나유니콤"],
  "China Mobile": ["中国移动", "中國移動", "中国移動", "차이나모바일"],
  "China Telecom": ["中国电信", "中國電信", "中国電信", "차이나텔레콤"],
  "China Broadnet": ["中国广电", "中國廣電", "中国広電", "차이나브로드넷"],
};
function resolve(code: string): Locale {
  if (/^zh/i.test(code))
    return /hant|tw|hk|mo/i.test(code) ? "zh-Hant" : "zh-Hans";
  return /^ja/i.test(code) ? "ja" : /^ko/i.test(code) ? "ko" : "en";
}
let locale: Locale = resolve(navigator.language);
try {
  const value = localStorage.getItem("openu60.language");
  if (value && value in languages) locale = value as Locale;
} catch {}
const listeners = new Set<() => void>();
export function setLocale(value: Locale) {
  locale = value;
  document.documentElement.lang = value;
  try {
    localStorage.setItem("openu60.language", value);
  } catch {}
  listeners.forEach((fn) => fn());
}
export function useLocale() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => locale,
  );
}
export function t(source: string, ...values: unknown[]) {
  if (source == null) return "—";
  const index = ["zh-Hans", "zh-Hant", "ja", "ko"].indexOf(locale);
  const text =
    (index >= 0 ? messages[source]?.[index] : undefined) ||
    (productMessages as Record<string, Record<string, string>>)[source]?.[
      locale
    ] ||
    source;
  return text.replace(/\{(\d+)\}/g, (match, i) =>
    Number(i) < values.length ? String(values[Number(i)]) : match,
  );
}
const states: Record<string, string> = {
  Running: "Running",
  Stopped: "Stopped",
  NeedsLogin: "Sign in required",
  NeedsMachineAuth: "Admin approval required",
  NoState: "Not configured",
  Starting: "Starting",
  idle: "Idle",
  running: "Running",
  starting: "Starting",
  disabled: "Disabled",
  enabled: "Enabled",
  not_installed: "Not installed",
  updating: "Updating",
  respawning: "Starting",
  connected: "Connected",
  disconnected: "Disconnected",
  succeeded: "Completed",
  failed: "Failed",
  checking: "Checking",
  downloading: "Downloading",
  installing: "Installing",
  verifying: "Verifying",
  queued: "Queued",
  rule: "Rule",
  global: "Global",
  direct: "Direct",
  local: "Local HTTP / SOCKS clients",
  hotspot: "Wi-Fi hotspot traffic",
  automatic: "Automatic",
  manual: "Manual",
  doh: "DNS over HTTPS",
  dot: "DNS over TLS",
  kernel: "Kernel gateway",
  userspace: "Device access only",
  "sim ready": "Ready",
  "wait pin": "PIN required",
  "wait puk": "PUK required",
  pending: "Pending",
  success: "Completed",
  unknown: "Unknown",
};
export function stateText(value: unknown) {
  return typeof value === "string" ? t(states[value] || value) : value;
}
export function carrier(value: unknown) {
  const raw = typeof value === "string" ? value.trim() : "";
  const key = raw.replace(/[\s_-]/g, "").toUpperCase();
  return (
    t(
      (
        {
          UNICOM: "China Unicom",
          CUCC: "China Unicom",
          CHINAUNICOM: "China Unicom",
          中国联通: "China Unicom",
          中國聯通: "China Unicom",
          CMCC: "China Mobile",
          CHINAMOBILE: "China Mobile",
          中国移动: "China Mobile",
          中國移動: "China Mobile",
          CTCC: "China Telecom",
          CHINATELECOM: "China Telecom",
          中国电信: "China Telecom",
          中國電信: "China Telecom",
          CBN: "China Broadnet",
          CHINABROADNET: "China Broadnet",
          中国广电: "China Broadnet",
          中國廣電: "China Broadnet",
        } as Record<string, string>
      )[key] || raw,
    ) || t("Not reported")
  );
}
