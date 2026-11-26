#!/usr/bin/env python3
"""Build and deploy this fork's agent and native screen as a recoverable pair."""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

REPO = Path(__file__).resolve().parents[2]
REMOTE = "/data/u60-dash"
TARGET = "aarch64-unknown-linux-musl"
FILES = ("zte-agent", "u60-screen", "service.sh", "manage.sh")
MARKER = "__U60_DASH_RC__"
DROPBEAR_IPK_URL = (
    "https://downloads.openwrt.org/releases/23.05.4/targets/armsr/armv8/"
    "packages/dropbear_2022.83-1_aarch64_generic.ipk"
)
# Audited predecessors: same release/lock/recovery protocol. Unknown or locally
# modified managers still require restore.
COMPATIBLE_MANAGERS = {
    "e8e7bc1d9c6167686b6f0f4669eae81e903d3f1fe7dec73ac14923ab1694299d",
    "152743cd07d21704f57cc27d03126e35c7d8e4dc71f2c9ce7922c135fc674dcb",
    "707119b317039d17d22213c9ca6dc1c6f3db0ad3f7f82e864d6b2eb40de4dcc7",
}

class Failure(RuntimeError):
    pass

def shell(command):
    return "sh -c " + shlex.quote(command) + '; code=$?; printf "\\n' + MARKER + '%s\\n" "$code"'

def decode(result):
    match = re.search(r"\n" + MARKER + r"(\d+)\s*$", result.stdout)
    if result.returncode or not match:
        detail = (result.stderr or "").strip()[-400:]
        raise Failure("设备连接中断或没有返回执行结果；先运行 status，确认结果后再重试。" + ("\n" + detail if detail else ""))
    output = result.stdout[:match.start()].replace("\r\n", "\n").strip()
    if int(match.group(1)):
        raise Failure("设备操作失败：" + output[-1200:])
    return output

class Connection:
    def __init__(self, args):
        self.ssh = args.ssh
        if self.ssh:
            if self.ssh.startswith("-") or not re.fullmatch(r"[A-Za-z0-9_.:@\[\]-]+", self.ssh):
                raise Failure("SSH 地址无效；使用 root@设备地址。")
            self.command = ["ssh", "-p", str(args.port), "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", self.ssh]
        else:
            self.command = ["adb"] + (["-s", args.serial] if args.serial else [])
    def remote(self, command, timeout=30):
        argv = self.command + ([shell(command)] if self.ssh else ["shell", shell(command)])
        try:
            return decode(subprocess.run(argv, text=True, capture_output=True, timeout=timeout))
        except subprocess.TimeoutExpired:
            raise Failure("设备操作超时，先运行 status 检查；不会自动重发。") from None
    def push(self, source, destination):
        if self.ssh:
            with open(source, "rb") as stream:
                proc = subprocess.run(self.command + ["umask 077; cat > " + shlex.quote(destination)], stdin=stream, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
        else:
            proc = subprocess.run(self.command + ["push", str(source), destination], capture_output=True, timeout=120)
        if proc.returncode:
            raise Failure("传输失败：" + Path(source).name)
        expected = digest(source)
        actual = self.remote("sha256sum " + shlex.quote(destination)).split()[0]
        if actual != expected:
            raise Failure("SHA-256 不匹配：" + Path(source).name)

def digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def elf(path):
    data = Path(path).read_bytes()
    if len(data) < 64 or data[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", data, 18)[0] != 183:
        raise Failure(f"{Path(path).name} 必须是静态 Linux ARM64 ELF。")
    offset = struct.unpack_from("<Q", data, 32)[0]
    size, count = struct.unpack_from("<HH", data, 54)
    if size < 56 or not 0 < count < 256 or offset + size * count > len(data):
        raise Failure("ELF 程序头无效。")
    if any(struct.unpack_from("<I", data, offset + size * i)[0] == 3 for i in range(count)):
        raise Failure("拒绝依赖动态加载器的设备产物。")

def build(args):
    subprocess.run([sys.executable, str(REPO / "scripts/i18n/build.py"), "--check"], cwd=REPO, check=True)
    npm = shutil.which("npm")
    if not npm:
        raise Failure("缺少 Node.js/npm；Web 静态资源需要 Node.js 22 或更新版本构建。")
    if not (REPO / "u60-web/node_modules/.bin/vite").is_file():
        subprocess.run([npm, "ci"] + (["--offline"] if args.offline else []), cwd=REPO / "u60-web", check=True)
    subprocess.run([npm, "run", "build"], cwd=REPO / "u60-web", check=True)
    env = os.environ.copy()
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    # build.rs watches this variable; Cargo otherwise reuses the old embedded
    # commit when only Git refs changed since the previous build.
    env["ZTE_AGENT_COMMIT"] = revision
    root = Path(env.get("U60_BUILD_ROOT", Path.home() / ".local/share/u60-build"))
    toolchain = root / "rustup/toolchains/stable-x86_64-unknown-linux-gnu/bin"
    cargo = env.get("CARGO") or (str(toolchain / "cargo") if (toolchain / "cargo").is_file() else shutil.which("cargo"))
    if not cargo:
        raise Failure("缺少 Cargo；请先安装 Rust 与 ARM64 musl 标准库。")
    if (root / "cargo").is_dir():
        env.setdefault("CARGO_HOME", str(root / "cargo"))
    if (toolchain / "rustc").is_file():
        env.setdefault("RUSTC", str(toolchain / "rustc"))
    linker = env.get("CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER") or shutil.which("aarch64-linux-musl-gcc") or shutil.which("aarch64-unknown-linux-gnu-gcc")
    if not linker:
        raise Failure("缺少 ARM64 交叉链接器；设置 CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER。")
    env["CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER"] = linker
    env.setdefault("CC_aarch64_unknown_linux_musl", linker)
    common = [cargo, "build", "--locked", "--release", "--target", TARGET]
    if args.offline:
        common.append("--offline")
    destination = Path(args.artifacts).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    for name, extra, target_dir in [
        ("zte-agent", ["-p", "zte-agent"], REPO / "target"),
        ("u60-screen", ["--manifest-path", "u60-screen/Cargo.toml", "--no-default-features", "--features", "device"], REPO / "target/u60-screen"),
    ]:
        print(f"构建 {name}…", flush=True)
        subprocess.run(common + extra, cwd=REPO, env={**env, "CARGO_TARGET_DIR": str(target_dir)}, check=True)
        artifact = target_dir / TARGET / "release" / name
        elf(artifact)
        shutil.copyfile(artifact, destination / name)
    for name in ("service.sh", "manage.sh"):
        shutil.copyfile(REPO / "scripts/dash" / name, destination / name)
    hashes = {name: digest(destination / name) for name in FILES}
    pair_id = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()[:20]
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip() != revision:
        raise Failure("构建期间 Git 版本发生变化；请重新构建以保证版本信息一致。")
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=REPO, text=True).strip())
    manifest = {"format": 1, "id": pair_id, "source_commit": revision, "source_dirty": dirty, "sha256": hashes}
    (destination / "release.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (destination / "manifest.sha256").write_text("".join(f"{value}  {name}\n" for name, value in hashes.items()))
    print(f"已构建两个程序，版本组 {pair_id}\n产物：{destination}")

def package(args):
    root = Path(args.artifacts).resolve()
    try:
        manifest = json.loads((root / "release.json").read_text())
        hashes = manifest["sha256"]
        if set(hashes) != set(FILES) or manifest["format"] != 1:
            raise ValueError
        for name in FILES:
            if hashes[name] != digest(root / name):
                raise ValueError
        identity = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()[:20]
        if manifest["id"] != identity or (root / "manifest.sha256").read_text() != "".join(f"{hashes[n]}  {n}\n" for n in FILES):
            raise ValueError
        for name in ("zte-agent", "u60-screen"):
            elf(root / name)
    except (OSError, ValueError, KeyError, TypeError):
        raise Failure("部署包缺失或校验失败；请运行 bash dash.sh build。") from None
    return root, identity

def format_agent_env(password):
    if not password or "\n" in password or "\r" in password:
        raise Failure("Agent 密码不能为空，且不能包含换行符。")
    escaped = password.replace("'", "'\\''")
    return f"# Private on-device agent environment. Do not publish.\nexport ZTE_AGENT_PASSWORD='{escaped}'\n"

def prompt_agent_password():
    env_pw = os.environ.get("ZTE_AGENT_PASSWORD")
    if env_pw is not None:
        return env_pw
    if not sys.stdin.isatty():
        raise Failure("首次安装需要设置 Web/Agent 登录密码；非交互环境请通过环境变量 ZTE_AGENT_PASSWORD 传入。")
    first = getpass.getpass("首次安装，请设置 Web/Agent 登录密码：")
    if not first or "\n" in first or "\r" in first:
        raise Failure("Agent 密码不能为空，且不能包含换行符。")
    second = getpass.getpass("再次确认密码：")
    if first != second:
        raise Failure("两次输入的密码不一致。")
    return first

def push_text(connection, content, destination, mode="600"):
    fd, tmp_path = tempfile.mkstemp(prefix="u60-dash-")
    try:
        os.chmod(tmp_path, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
        connection.push(tmp_path, destination)
        connection.remote(f"chmod {mode} {shlex.quote(destination)}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

def check(connection):
    script = """
set -eu
test "$(id -u)" = 0
test "$(uname -m)" = aarch64
test -c /dev/dri/card0
test -r /sys/class/leds/led:lcd/brightness
test -x /etc/init.d/zte_topsw_devui
test ! -e /tmp/u60-native-screen-trial
test ! -s /data/open-u60/update/pending
test -r /etc/rc.local
for tool in flock sha256sum readlink nohup ubus; do command -v "$tool" >/dev/null; done
# Exercise the BusyBox-compatible flags, using a read-only descriptor.
exec 8</etc/rc.local
flock -s -n 8
flock -u 8
exec 8<&-
ubus call zwrt_topsw_daemon.sync get_sync_info '{}' | grep -q '"noSyncModuleName"[[:space:]]*:[[:space:]]*"sync success"'
if test -e /data/u60-dash; then test -d /data/u60-dash && test ! -L /data/u60-dash; fi
if test -x /data/zte-agent && test -s /data/local/tmp/start_zte_agent.sh && grep -qF /data/local/tmp/start_zte_agent.sh /etc/rc.local; then
    printf 'device=root ARM64; boot=ready; recovery=available\n'
    if test -L /data/zte-agent; then printf 'existing_layout=linked\n'; else printf 'existing_layout=direct\n'; fi
elif test ! -e /data/zte-agent && test ! -s /data/local/tmp/start_zte_agent.sh; then
    printf 'device=root ARM64; boot=fresh; recovery=factory\n'
    printf 'existing_layout=fresh\n'
else
    echo 'Detected incomplete legacy agent files (/data/zte-agent or start_zte_agent.sh); clean them up or restore before installing.' >&2
    exit 1
fi
df -Pk /data | tail -1 | awk '{print "free_kib=" $4}'
"""
    result = connection.remote(script)
    free = re.search(r"free_kib=(\d+)", result)
    if not free or int(free.group(1)) < 150 * 1024:
        raise Failure("设备 /data 至少需要 150 MiB 空闲空间，用于新旧版本与回退。")
    print(result, flush=True)
    return result

def inactive_manager_condition():
    return (
        f"test ! -e /tmp/u60-dash-run && test ! -e {REMOTE}/pending "
        f"&& test ! -e {REMOTE}/enabled "
        f"&& (test ! -e {REMOTE}/current || test \"$(cat {REMOTE}/current)\" = none) "
        f"&& (test ! -s /data/local/tmp/start_zte_agent.sh "
        f"|| ! grep -qF {REMOTE}/manage.sh /data/local/tmp/start_zte_agent.sh)"
    )

def bootstrap_fresh(connection):
    """Prepare private agent.env, baseline health.json, and rc.local boot hook on a fresh device."""
    has_env = connection.remote(f"if test -s {REMOTE}/agent.env; then echo yes; else echo no; fi")
    if has_env != "yes" or os.environ.get("ZTE_AGENT_PASSWORD") is not None:
        password = prompt_agent_password()
        push_text(connection, format_agent_env(password), f"{REMOTE}/agent.env", mode="600")
        print("已写入设备端登录凭据（/data/u60-dash/agent.env）。", flush=True)
    else:
        print("复用设备已有的 /data/u60-dash/agent.env 登录凭据。", flush=True)
    has_health = connection.remote(f"if test -s {REMOTE}/health.json; then echo yes; else echo no; fi")
    if has_health != "yes":
        baseline = json.dumps({"tailscale": False, "gateway": False, "proxy": False, "proxy_capture": None}) + "\n"
        push_text(connection, baseline, f"{REMOTE}/health.json", mode="600")
    connection.remote("""
set -eu
mkdir -p /data/local/tmp
RC_LINE='sh /data/local/tmp/start_zte_agent.sh'
if ! grep -qxF -- "$RC_LINE" /etc/rc.local; then
    if grep -q '^exit 0' /etc/rc.local; then
        sed -i "/^exit 0/i $RC_LINE" /etc/rc.local
    else
        printf '%s\n' "$RC_LINE" >> /etc/rc.local
    fi
fi
grep -qxF -- "$RC_LINE" /etc/rc.local
""")

def setup_ssh(connection, args):
    """Install and enable Dropbear SSH on the device for wireless deploys."""
    pubkey_path = Path(args.pubkey).expanduser() if args.pubkey else Path.home() / ".ssh/id_ed25519.pub"
    if not pubkey_path.is_file():
        if args.pubkey:
            raise Failure(f"找不到指定的公钥文件：{pubkey_path}")
        priv = Path.home() / ".ssh/id_ed25519"
        if not priv.exists():
            priv.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["ssh-keygen", "-t", "ed25519", "-f", str(priv), "-N", ""], check=True)
        if not pubkey_path.is_file():
            raise Failure(f"未能生成 SSH 公钥：{pubkey_path}")
    pubkey = pubkey_path.read_text(encoding="utf-8").strip()
    if not pubkey or "\n" in pubkey or "\r" in pubkey:
        raise Failure(f"SSH 公钥格式无效：{pubkey_path}")

    has_dropbear = connection.remote("if test -x /usr/sbin/dropbear; then echo yes; else echo no; fi")
    if has_dropbear != "yes":
        print("设备未安装 Dropbear，正在下载 OpenWrt 23.05.4 ARM64 安装包…", flush=True)
        fd, ipk_path = tempfile.mkstemp(prefix="u60-dropbear-", suffix=".ipk")
        os.close(fd)
        try:
            urllib.request.urlretrieve(DROPBEAR_IPK_URL, ipk_path)
            connection.push(ipk_path, "/tmp/dropbear.ipk")
            connection.remote("opkg install /tmp/dropbear.ipk >/dev/null 2>&1 || true; rm -f /tmp/dropbear.ipk; test -x /usr/sbin/dropbear")
        except (urllib.error.URLError, OSError) as error:
            raise Failure(f"下载 Dropbear 失败：{error}") from None
        finally:
            try:
                os.unlink(ipk_path)
            except OSError:
                pass

    push_text(connection, pubkey + "\n", "/tmp/u60-dash-pubkey.pub", mode="600")
    port = args.port
    connection.remote(f"""
set -eu
mkdir -p /etc/dropbear /data/local/tmp
chmod 700 /etc/dropbear
touch /etc/dropbear/authorized_keys
chmod 600 /etc/dropbear/authorized_keys
PUBKEY=$(cat /tmp/u60-dash-pubkey.pub)
rm -f /tmp/u60-dash-pubkey.pub
if ! grep -qxF -- "$PUBKEY" /etc/dropbear/authorized_keys; then
    printf '%s\n' "$PUBKEY" >> /etc/dropbear/authorized_keys
fi
cat >/data/local/tmp/start_dropbear.sh.new <<'DBBOOT'
#!/bin/sh
/usr/sbin/dropbear -p {port} -R
DBBOOT
chmod 700 /data/local/tmp/start_dropbear.sh.new
mv -f /data/local/tmp/start_dropbear.sh.new /data/local/tmp/start_dropbear.sh
RC_LINE='sh /data/local/tmp/start_dropbear.sh'
if ! grep -qxF -- "$RC_LINE" /etc/rc.local; then
    if grep -q '^exit 0' /etc/rc.local; then
        sed -i "/^exit 0/i $RC_LINE" /etc/rc.local
    else
        printf '%s\n' "$RC_LINE" >> /etc/rc.local
    fi
fi
grep -qxF -- "$RC_LINE" /etc/rc.local
if ! pidof dropbear >/dev/null 2>&1; then
    sh /data/local/tmp/start_dropbear.sh
fi
""")
    print(f"Dropbear SSH 已配置并启动（端口 {port}）。")
    print(f"连接测试：ssh -p {port} root@{args.gateway}")
    print(f"无线部署：bash dash.sh install --ssh root@{args.gateway} --port {port}")

def _load_unlock():
    dash_dir = str(Path(__file__).resolve().parent)
    if dash_dir not in sys.path:
        sys.path.insert(0, dash_dir)
    import unlock
    return unlock

def enable_adb(args):
    """Enable root ADB on both unlocked (B27) and locked (B31) firmwares."""
    gateway = args.gateway
    url = f"http://{gateway}/ubus/"
    password = os.environ.get("ZTE_ROUTER_PASSWORD") or os.environ.get("ROUTER_PW")
    if password is None:
        if not sys.stdin.isatty():
            raise Failure("请通过环境变量 ZTE_ROUTER_PASSWORD 提供路由器原厂管理密码。")
        password = getpass.getpass(f"路由器原厂管理密码 ({gateway})：")
    if not password:
        raise Failure("路由器管理密码不能为空。")

    suffix = args.suffix or os.environ.get("ZTE_BACKUP_SUFFIX")
    if suffix or args.dry_run:
        if not suffix:
            if not sys.stdin.isatty():
                raise Failure("请通过 --suffix 或环境变量 ZTE_BACKUP_SUFFIX 提供配置备份密钥后缀。")
            suffix = getpass.getpass("配置备份密钥后缀（国行 B31 为 zteSDX75*11Mbb2@1）：")
        if not suffix:
            raise Failure("配置备份密钥后缀不能为空。")
        unlock = _load_unlock()
        try:
            unlock.run_unlock(
                gateway,
                password,
                suffix,
                dry_run=args.dry_run,
                yes=args.yes,
                work=args.keep_work,
            )
        except unlock.UnlockError as error:
            raise Failure(str(error)) from None
        if not args.dry_run:
            print("重启完成后可运行：adb wait-for-device && adb devices && adb shell id")
            print("确认输出 uid=0(root) 后，继续运行 bash dash.sh check 与 bash dash.sh install。")
        return

    def ubus_rpc(session, obj, method, params):
        payload = json.dumps([
            {"jsonrpc": "2.0", "id": 1, "method": "call", "params": [session, obj, method, params]}
        ]).encode("utf-8")
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, OSError, ValueError) as error:
            raise Failure(f"无法连接路由器 {gateway}：{error}") from None
        entry = data[0] if isinstance(data, list) and data else {}
        result = entry.get("result")
        if not isinstance(result, list) or not result or not isinstance(result[0], int):
            raise Failure(f"{obj}.{method} 返回格式异常。")
        if result[0] != 0:
            return result[0], {}
        return 0, result[1] if len(result) > 1 and isinstance(result[1], dict) else {}

    anon = "00000000000000000000000000000000"
    code, info = ubus_rpc(anon, "zwrt_web", "web_login_info", {})
    salt = info.get("zte_web_sault", "")
    if code != 0 or not salt:
        raise Failure(f"获取登录盐值失败（ubus code={code}）；请确认已连接路由器 {gateway}。")
    h1 = hashlib.sha256(password.encode("utf-8")).hexdigest().upper()
    h2 = hashlib.sha256((h1 + salt).encode("utf-8")).hexdigest().upper()
    code, login_data = ubus_rpc(anon, "zwrt_web", "web_login", {"password": h2})
    sid = login_data.get("ubus_rpc_session", "")
    if code != 0 or not sid or sid == anon:
        raise Failure("原厂后台登录失败，请检查路由器管理密码。")

    code, _ = ubus_rpc(sid, "zwrt_bsp.usb", "set", {"mode": "debug"})
    if code != 0:
        print(f"当前固件拒绝了 zwrt_bsp.usb 调试切换（ubus code={code}），将自动转入配置备份/恢复解锁流程（适用于 B31 等较新固件）。", flush=True)
        if not sys.stdin.isatty():
            raise Failure(
                "非交互环境请加上 --suffix 参数（国行 B31 示例）：\n"
                "  bash dash.sh enable-adb --suffix 'zteSDX75*11Mbb2@1'"
            )
        suffix = getpass.getpass("请输入配置备份密钥后缀（国行 B31 为 zteSDX75*11Mbb2@1）：")
        if not suffix:
            raise Failure("未提供配置备份密钥后缀，已取消。")
        unlock = _load_unlock()
        try:
            unlock.run_unlock(
                gateway,
                password,
                suffix,
                dry_run=args.dry_run,
                yes=args.yes,
                work=args.keep_work,
            )
        except unlock.UnlockError as error:
            raise Failure(str(error)) from None
        print("重启完成后可运行：adb wait-for-device && adb devices && adb shell id")
        print("确认输出 uid=0(root) 后，继续运行 bash dash.sh check 与 bash dash.sh install。")
        return

    mode = "unknown"
    for _ in range(3):
        time.sleep(1)
        rc, listing = ubus_rpc(sid, "zwrt_bsp.usb", "list", {})
        if rc == 0 and isinstance(listing.get("mode"), str):
            mode = listing["mode"]
            if mode == "debug":
                break
    if mode != "debug":
        raise Failure(f"路由器上报 USB 模式为 '{mode}'（非 debug），未能开启 ADB。")
    print("路由器已切换至 USB debug 模式，正在等待 ADB 设备上线…", flush=True)
    adb = ["adb"] + (["-s", args.serial] if args.serial else [])
    try:
        subprocess.run(adb + ["wait-for-device"], timeout=30, check=True)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, FileNotFoundError) as error:
        raise Failure(f"等待 ADB 设备超时或失败：{error}") from None
    print("ADB 已连接，现在可以直接运行 bash dash.sh check 和 bash dash.sh install。")

def replace_inactive_manager(connection, source):
    # Recheck under the operation lock: another installer may have started
    # between preflight and upload. Never replace the lock file itself.
    connection.remote(f"""
set -eu
exec 9>{REMOTE}/operation.lock
flock -n 9 || {{ echo 'Deployment lock unavailable; retry after the active operation finishes.'; exit 1; }}
if ! ({inactive_manager_condition()}); then
    echo 'The project manager is active; run bash dash.sh restore before replacing it.'
    exit 1
fi
cp {shlex.quote(source)} {REMOTE}/manage.sh.new
chmod 700 {REMOTE}/manage.sh.new
mv -f {REMOTE}/manage.sh.new {REMOTE}/manage.sh
""")

def replace_compatible_manager(connection, source, expected):
    if expected not in COMPATIBLE_MANAGERS:
        raise Failure("部署管理器不在已验证的兼容版本中。")
    connection.remote(f"""
set -eu
exec 9>{REMOTE}/operation.lock
flock -n 9 || {{ echo 'Deployment operation is active.'; exit 1; }}
test ! -e {REMOTE}/pending || {{ echo 'Wait for the active deployment trial.'; exit 1; }}
actual=$(sha256sum {REMOTE}/manage.sh); actual=${{actual%% *}}
test "$actual" = {shlex.quote(expected)} || {{ echo 'Deployment manager changed; retry after checking its version.'; exit 1; }}
sh -n {shlex.quote(source)}
cp -p {REMOTE}/manage.sh {REMOTE}/manage.sh.previous
cp {shlex.quote(source)} {REMOTE}/manage.sh.new
chmod 700 {REMOTE}/manage.sh.new
sync
mv -f {REMOTE}/manage.sh.new {REMOTE}/manage.sh
""")

def prune_old_releases(connection):
    """Keep only the active release (`current`), rollback target (`previous`),
    and any in-flight `pending` release so /data never fills up across deploys."""
    connection.remote(f"""
cur=$(sed -n '1p' {REMOTE}/current 2>/dev/null || true)
prev=$(sed -n '1p' {REMOTE}/previous 2>/dev/null || true)
pend=$(sed -n '1p' {REMOTE}/pending 2>/dev/null || true)
[ -n "$cur" ] || exit 0
removed=0
for d in {REMOTE}/releases/*; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    case "$name" in
        "$cur"|"$prev"|"$pend"|*.incoming-*) continue ;;
    esac
    rm -rf "$d"
    removed=$((removed + 1))
done
if [ "$removed" -gt 0 ]; then
    echo "pruned_old_releases=$removed"
fi
""")

def install(connection, args):
    root, identity = package(args)
    check_out = check(connection)
    connection.remote(f"umask 077; mkdir -p {REMOTE}/releases; chmod 700 {REMOTE} {REMOTE}/releases")
    if "existing_layout=fresh" in check_out:
        bootstrap_fresh(connection)
    existing = connection.remote(f"if test -s {REMOTE}/manage.sh; then sha256sum {REMOTE}/manage.sh; fi")
    compatible = None
    if existing and existing.split()[0] != digest(root / "manage.sh"):
        inactive = connection.remote(f"if {inactive_manager_condition()}; then echo restored; else echo active; fi")
        if inactive != "restored" and existing.split()[0] in COMPATIBLE_MANAGERS:
            compatible = existing.split()[0]
        elif inactive != "restored":
            raise Failure("设备部署管理器版本不同；请先运行 bash dash.sh restore，再安装新版本。原备份不会被覆盖。")
        else:
            existing = ""
    destination = f"{REMOTE}/releases/{identity}"
    present = connection.remote(f"if test -d {destination}; then echo yes; else echo no; fi")
    if present == "no":
        staging = destination + ".incoming-" + secrets.token_hex(6)
        connection.remote(f"test ! -e {staging} && mkdir {staging}")
        try:
            for name in (*FILES, "release.json", "manifest.sha256"):
                connection.push(root / name, staging + "/" + name)
            connection.remote(f"cd {staging} && sha256sum -c manifest.sha256 >/dev/null && chmod 700 zte-agent u60-screen service.sh manage.sh && sh -n service.sh && sh -n manage.sh && test ! -e {destination} && mv {staging} {destination}")
        finally:
            try:
                connection.remote(f"rm -rf {staging}")
            except (Failure, OSError, subprocess.SubprocessError):
                print("未能清理未激活的上传目录：" + staging, file=sys.stderr)
    if compatible:
        replace_compatible_manager(connection, destination + "/manage.sh", compatible)
    elif not existing:
        replace_inactive_manager(connection, destination + "/manage.sh")
    print("文件已传输并校验；开始部署两个程序。30 秒健康观察通过后自动确认。", flush=True)
    operation = f'sh {REMOTE}/manage.sh install {identity}; result=$?; printf "%s\\n" "$result" >{REMOTE}/install.exit.new; mv {REMOTE}/install.exit.new {REMOTE}/install.exit'
    connection.remote(f"rm -f {REMOTE}/install.exit; nohup sh -c {shlex.quote(operation)} >{REMOTE}/install.log 2>&1 </dev/null & sleep 1")
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        time.sleep(3)
        state = connection.remote(f"sh {REMOTE}/manage.sh status; if test -f {REMOTE}/install.exit; then printf 'install_exit='; cat {REMOTE}/install.exit; fi")
        exit_code = re.search(r"^install_exit=(\d+)$", state, re.MULTILINE)
        if exit_code and exit_code.group(1) != "0":
            raise Failure("安装管理器未完成；设备端原因见 /data/u60-dash/install.log。\n" + state)
        if f"selected={identity}" in state and "trial=none" in state and "screen_frame=ready" in state and "agent=running" in state:
            prune_old_releases(connection)
            print(state)
            print("两个程序已部署并通过健康检查。", flush=True)
            return
        if "was rolled back" in state or "Recovery requires attention" in state:
            raise Failure(state)
    raise Failure("健康观察尚未成功；运行 bash dash.sh status 查看状态。设备会按自己的恢复流程处理，不会自动重复安装。")

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=["build", "check", "install", "status", "start", "stop", "rollback", "restore", "setup-ssh", "enable-adb", "help"],
        nargs="?",
        default="help",
    )
    parser.add_argument("--ssh", help="root@设备地址；默认使用 ADB")
    parser.add_argument("--port", type=int, default=2222)
    parser.add_argument("--serial", default=os.environ.get("ANDROID_SERIAL"), help="ADB 设备序列号")
    parser.add_argument("--gateway", default="192.168.0.1", help="路由器管理地址（默认 192.168.0.1）")
    parser.add_argument("--pubkey", help="setup-ssh 使用的 SSH 公钥路径（默认 ~/.ssh/id_ed25519.pub）")
    parser.add_argument("--suffix", help="enable-adb 用于 B31 等新固件的配置备份密钥后缀（或 ZTE_BACKUP_SUFFIX 环境变量）")
    parser.add_argument("--dry-run", action="store_true", help="enable-adb 仅下载、解密并生成补丁包，不上传也不重启")
    parser.add_argument("--yes", action="store_true", help="enable-adb 跳过上传前交互确认")
    parser.add_argument("--keep-work", help="enable-adb 中间文件保存目录")
    parser.add_argument("--artifacts", default=str(REPO / "target/dash"))
    parser.add_argument("--no-build", action="store_true", help="安装已经通过 manifest 校验的部署包")
    parser.add_argument("--offline", action="store_true", help="Cargo 离线构建")
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("SSH 端口无效")
    if args.command == "help":
        parser.print_help()
        print(
            "\n常用：bash dash.sh check；bash dash.sh install（支持全新设备首次安装与升级）；bash dash.sh status\n"
            "enable-adb：一键开启设备 root ADB（B31 等新固件加 --suffix 'zteSDX75*11Mbb2@1'，B27 及更早可直接运行）。\n"
            "setup-ssh：在设备安装并启用 Dropbear SSH（默认端口 2222），用于无线部署。\n"
            "stop：恢复原厂屏幕，保留后台；start：重新启动两个程序。\n"
            "rollback：恢复上一组；restore：恢复到首次安装前状态（全新设备将清理启动钩子并回到原厂）。"
        )
        return 0
    if args.command == "build":
        build(args)
        return 0
    if args.command == "enable-adb":
        enable_adb(args)
        return 0
    connection = Connection(args)
    if args.command == "check":
        check(connection)
    elif args.command == "install":
        if not args.no_build:
            build(args)
        install(connection, args)
    elif args.command == "setup-ssh":
        setup_ssh(connection, args)
    elif args.command == "status":
        print(connection.remote(f"if test -s {REMOTE}/manage.sh; then sh {REMOTE}/manage.sh status; else echo 'paired_deployment=not_installed'; fi"))
    else:
        print(connection.remote(f"sh {REMOTE}/manage.sh {args.command} && sleep 1", timeout=150))
        print(connection.remote(f"sh {REMOTE}/manage.sh status"))
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Failure, OSError, subprocess.SubprocessError) as error:
        print(f"部署未完成：{error}", file=sys.stderr)
        sys.exit(1)
