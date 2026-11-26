#!/usr/bin/env python3
"""Unlock ADB/root on ZTE MU5250 (U60 Pro) running locked firmware (e.g. B31,
HK B04) via the stock config backup/restore path.

Derived from dklasens/MU5250-OpenUI (scripts/zunlock.py & scripts/device_identity.py).
Copyright (c) 2026 David Klasens
Licensed under the MIT License (see LICENSE and THIRD_PARTY_NOTICES.md).

What it does:
  1. Logs into the stock web UI (router admin password).
  2. Verifies device identity (U60 Pro / MU5250) and downloads a fresh config
     backup via `zwrt_mc.device.manager.device_backup_proc`.
  3. Retains an untouched encrypted recovery copy under
     `~/.local/share/open-u60-pro/recovery/<uuid>/`.
  4. Decrypts the backup (`des-ede3-cbc` / `sha256`, password = `<IMEI><suffix>`),
     auto-discovers the `/sys/...usb_op...` node from stock `etc/rc.local`,
     inserts `echo 1 > <usb_op_node>` after `#!/bin/sh`, repacks (inner tgz +
     MD5 + outer tgz) and re-encrypts.
  5. With confirmation (unless `--yes`), uploads via `/cgi-bin/cgi-upload`
     (SHA-256 verified) and triggers `device_restore_proc`. The device applies
     the config and reboots (~60-90s) with root `adbd` enabled.
"""

import hashlib
import http.cookiejar
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import uuid

INNER = "tmp/back_parameter_r1.tgz"
MD5 = "tmp/back_parameter_r.md5"
RC_LOCAL = "etc/rc.local"


def device_identity(info):
    """Identity contract for U60 Pro / MU5250; never retain raw IMEI."""
    def field(names):
        return next(
            (info[k].strip() for k in names if isinstance(info.get(k), str) and info[k].strip()),
            "",
        )

    model = field(["model", "model_name", "device_name", "product_name", "modelName"])
    firmware = field(["software_version", "sw_version", "firmware_version", "wa_inner_version", "version"])
    if not model:
        stock = field(["wa_inner_version"])
        if stock.startswith("BD_") and "MU5250V" in stock:
            model = "ZTE MU5250"
    normalized = model.lower().replace(" ", "").replace("_", "").replace("-", "")
    imei = field(["imei"])
    if not ("mu5250" in normalized or "u60pro" in normalized) or not firmware or not re.fullmatch(r"[0-9]{15}", imei):
        raise ValueError("Device identity or firmware could not be verified as a U60 Pro")
    return {
        "model": model,
        "firmware": firmware,
        "fingerprint": hashlib.sha256(imei.encode()).hexdigest(),
    }


class Router:
    def __init__(self, gw, password):
        self.base = f"http://{gw}"
        self.pw = password
        self.cj = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cj)
        )
        self.session = None

    def call(self, obj, method, params, session=None):
        url = f"{self.base}/ubus/?t={int(time.time())}"
        body = json.dumps([
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "call",
                "params": [session or self.session, obj, method, params],
            }
        ]).encode()
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Origin": self.base,
                "Referer": self.base + "/",
            },
        )
        return json.loads(self.opener.open(req, timeout=30).read())

    @staticmethod
    def _sha(text):
        return hashlib.sha256(text.encode()).hexdigest().upper()

    def login(self):
        salt = self.call("zwrt_web", "web_login_info", {}, session="0" * 32)[0]["result"][1]["zte_web_sault"]
        resp = self.call(
            "zwrt_web",
            "web_login",
            {"password": self._sha(self._sha(self.pw) + salt)},
            session="0" * 32,
        )
        sid = resp[0]["result"][1].get("ubus_rpc_session")
        if not sid or sid == "0" * 32:
            raise UnlockError("router login failed (invalid session)")
        self.session = sid

    def get(self, path):
        req = urllib.request.Request(self.base + path, headers={"Referer": self.base + "/"})
        return self.opener.open(req, timeout=60).read()

    def upload(self, data):
        boundary = "----zunlock" + hashlib.md5(os.urandom(8)).hexdigest()
        body = (
            f'--{boundary}\r\nContent-Disposition: form-data; name="filename"'
            f"\r\n\r\n/tmp/back_parameter\r\n".encode()
            + f'--{boundary}\r\nContent-Disposition: form-data; '
              f'name="filedata"; filename="back_parameter"\r\n'
              f"Content-Type: application/octet-stream\r\n\r\n".encode()
            + data + b"\r\n"
            + f"--{boundary}--\r\n".encode()
        )
        req = urllib.request.Request(
            self.base + "/cgi-bin/cgi-upload",
            data=body,
            headers={
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Referer": self.base + "/",
                "Origin": self.base,
            },
        )
        return json.loads(self.opener.open(req, timeout=120).read())


class UnlockError(Exception):
    """Fatal unlock failure (bad suffix, unexpected backup layout, etc.)."""


def _evp_bytes_to_key(password, salt, key_len=24, iv_len=8):
    """OpenSSL EVP_BytesToKey with SHA-256 (matches `openssl enc -md sha256`)."""
    out, block = b"", b""
    while len(out) < key_len + iv_len:
        block = hashlib.sha256(block + password + salt).digest()
        out += block
    return out[:key_len], out[key_len:key_len + iv_len]


def _py_crypt(data, password, encrypt):
    """OpenSSL-compatible `enc -des-ede3-cbc -md sha256` (Salted__ container)."""
    from cryptography.hazmat.primitives.ciphers import Cipher, modes
    try:
        from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
    except ImportError:
        from cryptography.hazmat.primitives.ciphers.algorithms import TripleDES

    if encrypt:
        salt = os.urandom(8)
        key, iv = _evp_bytes_to_key(password.encode(), salt)
        pad = 8 - len(data) % 8
        padded = data + bytes([pad]) * pad
        op = Cipher(TripleDES(key), modes.CBC(iv)).encryptor()
        return b"Salted__" + salt + op.update(padded) + op.finalize()

    if data[:8] != b"Salted__" or len(data) < 24 or (len(data) - 16) % 8:
        raise ValueError("not an openssl enc file")
    key, iv = _evp_bytes_to_key(password.encode(), data[8:16])
    op = Cipher(TripleDES(key), modes.CBC(iv)).decryptor()
    padded = op.update(data[16:]) + op.finalize()
    pad = padded[-1]
    if not 1 <= pad <= 8 or padded[-pad:] != bytes([pad]) * pad:
        raise ValueError("bad padding (wrong password)")
    return padded[:-pad]


def openssl(direction, src, dst, password):
    """Encrypt/decrypt with `cryptography` when installed, else `openssl` CLI."""
    try:
        data = Path(src).read_bytes()
        out = _py_crypt(data, password, encrypt=(direction == "e"))
    except ImportError:
        subprocess.run(
            [
                "openssl", "enc", "-des-ede3-cbc", f"-{direction}",
                "-md", "sha256", "-pass", "stdin",
                "-in", str(src), "-out", str(dst),
            ],
            input=(password + "\n").encode(),
            timeout=60,
            check=True,
        )
        return
    except ValueError as error:
        raise subprocess.CalledProcessError(1, ["openssl", direction]) from error
    Path(dst).write_bytes(out)


def read_outer(path):
    with tarfile.open(path, "r:gz") as outer:
        inner = outer.extractfile(INNER).read()
    with tarfile.open(fileobj=io.BytesIO(inner), mode="r:gz") as inner_tar:
        members = [
            (member, inner_tar.extractfile(member).read() if member.isfile() else None)
            for member in inner_tar.getmembers()
        ]
    return inner, members


def patch_outer(src, dst, log=print):
    _, members = read_outer(src)
    out, rc = [], None
    for member, data in members:
        if member.name == RC_LOCAL and member.isfile():
            rc = (member, data)
            continue
        out.append((member, data))
    if rc is None:
        raise UnlockError(f"{RC_LOCAL} not found in backup (unexpected)")
    member, data = rc
    text = data.decode("utf-8", "replace")

    hits = re.findall(r"/sys/[^\s`\"']*usb_op[^\s`\"']*", text)
    if not hits:
        raise UnlockError(
            "no usb_op node found in stock rc.local — this firmware may differ; inspect the backup manually"
        )
    payload = f"echo 1 > {hits[0]}"
    if payload in text:
        raise UnlockError("rc.local already contains the USB debug payload — ADB should already be enabled")

    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.strip() == "#!/bin/sh":
            lines.insert(index + 1, payload)
            break
    else:
        lines.insert(0, payload)
    patched_rc = ("\n".join(lines) + "\n").encode()
    member.size = len(patched_rc)
    out.append((member, patched_rc))
    log(f"[+] payload after shebang: {payload}")

    inner_buf = io.BytesIO()
    with tarfile.open(fileobj=inner_buf, mode="w:gz") as inner_tar:
        for item, content in out:
            inner_tar.addfile(item, io.BytesIO(content) if content is not None else None)
    inner_bytes = inner_buf.getvalue()
    digest = hashlib.md5(inner_bytes).hexdigest()

    def tar_meta(name, size):
        info = tarfile.TarInfo(name)
        info.mode, info.uid, info.gid, info.uname, info.gname = 0o644, 0, 0, "root", "root"
        info.size = size
        return info

    with tarfile.open(dst, "w:gz") as outer_tar:
        outer_tar.addfile(tar_meta(INNER, len(inner_bytes)), io.BytesIO(inner_bytes))
        md5_bytes = (digest + "\n").encode()
        outer_tar.addfile(tar_meta(MD5, len(md5_bytes)), io.BytesIO(md5_bytes))


def run_unlock(gw, pw, suffix, *, dry_run=False, yes=False, work=None, log=print, confirm=None):
    """Run the config backup/restore ADB unlock flow.

    Returns the working directory containing local backup artifacts.
    """
    work = work or tempfile.mkdtemp(prefix="zunlock-")
    os.makedirs(work, mode=0o700, exist_ok=True)
    os.chmod(work, 0o700)
    log(f"[*] work dir: {work}")

    router = Router(gw, pw)
    log("[*] logging in...")
    try:
        router.login()
    except Exception as error:
        raise UnlockError(
            f"router login failed (wrong admin password or device unreachable?): {error}"
        ) from error

    info = router.call("zwrt_web", "device_info", {})[0]["result"][1]
    try:
        identity = device_identity(info)
    except ValueError as error:
        raise UnlockError(str(error)) from error
    identity_file = Path(work) / "identity.json"
    if identity_file.exists() and json.loads(identity_file.read_text()) != identity:
        raise UnlockError("The modem identity changed since preparation")
    identity_file.write_text(json.dumps(identity))
    imei = info["imei"]
    log(f"[+] device IMEI: {imei[:6]}********* ({identity['model']} / {identity['firmware']})")

    log("[*] requesting fresh config backup...")
    res = router.call("zwrt_mc.device.manager", "device_backup_proc", {"procType": "web"})
    if res[0]["result"][0] != 0:
        raise UnlockError(f"backup_proc failed: {res}")
    time.sleep(2)
    enc_orig = os.path.join(work, "back_parameter.orig")
    Path(enc_orig).write_bytes(router.get("/backup/back_parameter"))
    log(f"[+] backup downloaded: {os.path.getsize(enc_orig)} bytes")

    recovery_root = Path.home() / ".local/share/open-u60-pro/recovery"
    recovery_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    recovery = recovery_root / str(uuid.uuid4())
    recovery.mkdir(mode=0o700)
    with open(recovery / "back_parameter.orig", "xb") as saved, open(enc_orig, "rb") as original:
        os.chmod(saved.name, 0o600)
        shutil.copyfileobj(original, saved)
        saved.flush()
        os.fsync(saved.fileno())
    (recovery / "identity.json").write_text(json.dumps(identity))
    log(f"[+] original encrypted recovery backup retained: {recovery}")

    password = imei + suffix
    outer = os.path.join(work, "outer.tgz")
    log("[*] decrypting (des-ede3-cbc/sha256)...")
    try:
        openssl("d", enc_orig, outer, password)
    except (subprocess.CalledProcessError, FileNotFoundError) as error:
        if isinstance(error, FileNotFoundError):
            raise UnlockError("缺少 openssl CLI 或 Python cryptography 库，无法解密配置备份。") from None
        raise UnlockError("decryption failed — wrong suffix for this device/firmware") from None

    patched = os.path.join(work, "outer.patched.tgz")
    patch_outer(outer, patched, log=log)
    enc_new = os.path.join(work, "back_parameter.patched")
    openssl("e", patched, enc_new, password)
    data = Path(enc_new).read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    log(f"[+] patched package ready: {len(data)} bytes, sha256 {sha[:16]}...")

    if dry_run:
        log(f"[*] dry-run: stopping before upload. Artifacts in {work}")
        return work

    if not yes:
        log("")
        log("*** 即将上传修改后的配置备份并触发设备恢复与重启（约 60–90 秒离线）。")
        proceed = confirm() if confirm else input("确认继续？[y/N] ").strip().lower() == "y"
        if not proceed:
            raise UnlockError("已取消操作；中间文件保留在 " + work)

    if device_identity(router.call("zwrt_web", "device_info", {})[0]["result"][1]) != identity:
        raise UnlockError("The modem identity changed before restore")
    log("[*] uploading patched backup...")
    resp = router.upload(data)
    log(f"[+] upload response: {resp}")
    if resp.get("sha256sum") != sha:
        raise UnlockError("sha256 mismatch after upload — aborting before restore")

    log("[*] triggering restore + reboot...")
    res = router.call("zwrt_mc.device.manager", "device_restore_proc", {"procType": "web"})
    if res[0]["result"][0] != 0:
        raise UnlockError(f"restore trigger failed: {res}")

    log("")
    log("[+] 配置恢复已触发，设备正在重启（约 60–90 秒后 root ADB 会自动上线）。")
    return work
