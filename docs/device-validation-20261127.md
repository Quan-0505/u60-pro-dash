# U60 Pro upstream refresh validation

Integrated upstream `locez/u60-pro-dash` through
`36a8e8e5565a244f7ca0c01530d80a840b4ec248` while retaining the existing
console, LuCI proxy, AppDPI adapter, owner service entries and swipe unlock.
The dashboard localizes common Chinese carrier names, including UNICOM.

## Build and device checks

- Built the React assets and ARM64 musl agent and screen on the existing
  build host; verified the uploaded ELF files by SHA-256.
- Agent: `d93cacc8c0729e42615b7d8c16e2adbdbb12eb0582972ccb418c53e380723e0f`.
- Screen: `0055edc663c17e96c710c2a9ed185c3343d730f3940430514b0530e6c13c9e00`.
- Saved the prior pair and settings before replacing either program.
- The paired service authenticated, received live signal/traffic/battery,
  submitted a screen frame and continued updating its heartbeat.
- Authenticated browser showed the Chinese carrier name and retained the
  OpenWrt entry with no JavaScript errors.
- Direct HTTPS returned 200; HTTPS through the existing proxy returned 204.
- Device boot identity, wireless/network configuration hashes and existing
  proxy process identity remained unchanged. No whole-device reboot occurred.

## Test limits

Targeted Wi-Fi (23), ubus (3), server/authentication (9), and Tailscale (16)
tests passed. Frontend unit tests passed. The full agent suite reported 1174
passed, 11 failed and 8 ignored. Failures include pre-existing custom-port
expectations, legacy supervisor/plugin fixtures, CSS expectations and QR
timing; this is not a claim that the full suite passed.

The upstream browser scenario expecting control over the Mihomo mode differs
from this installation's deliberately read-only UFI-owned proxy panel. The
existing navigation fixture also assumes five groups; the customized console
has an additional OpenWrt group. Those tests require fixture adaptation and
were not counted as passed.

No live Wi-Fi setting was applied and no modem, SIM, APN or routing setting
was changed as a test. Build success and read-only verification do not prove
every upstream write operation on this device.
