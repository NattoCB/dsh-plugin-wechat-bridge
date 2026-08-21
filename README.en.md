# dsh-plugin-wechat-bridge

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">Put your DSH agent in WeChat: private-chat messages drive an agent session, replies stream back as plain text.</b><br /><br />
  <a href="https://github.com/NattoCB/dsh-plugin-wechat-bridge"><img alt="License" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a>
  <a href="https://github.com/NattoCB/dsh-plugin-wechat-bridge"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-NattoCB%2Fdsh--plugin--wechat--bridge-181717" /></a><br /><br />
  <img alt="ilink bot" src="https://img.shields.io/badge/-ilink%20bot-4d6bfe" />
  <img alt="Hot plug" src="https://img.shields.io/badge/-Hot%20plug-4d6bfe" />
  <img alt="Per-day sessions" src="https://img.shields.io/badge/-Per-day%20sessions-4d6bfe" />
  <img alt="Crash-safe" src="https://img.shields.io/badge/-Crash-safe-4d6bfe" />
  <img alt="Outbound media" src="https://img.shields.io/badge/-Outbound%20media-4d6bfe" /><br /><br />
  <b>Integration surface:</b> settings namespace <code>wechat-bridge</code> · slash command <code>/wechat</code> · tool <code>wechat_send_file</code> · Settings "WeChat bridge" tab
</div>

> **Language**: [中文](./README.md) ｜ **English**

> Put your DSH agent in WeChat. A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle plugin:
> it bridges **WeChat (ilink bot)** private-chat messages into a DSH agent session and streams the reply back as plain text.
> Install into the `web` profile, scan a QR code to bind a `bot_type=3` WeChat account, and chat from WeChat directly.
> One session per peer per day, durable JSON-file state, crash-safe polling; enable/disable live from the Settings UI tab,
> the `/wechat` command, or `settings.yaml` — no `dsh web` restart.

## ✨ Features

- **📱 WeChat private chat → DSH agent**: polls the WeChat `ilink bot` API (`getupdates`, multi-account); private-chat messages drive an agent session, replies come back as plain-text chunks (4096 chars × max 5, truncated beyond).
- **🔌 Runtime hot plug**: three independent controls — Settings UI tab, `/wechat` slash command, `settings.yaml` flag — start/stop take effect immediately, no process restart.
- **🗓️ One session per peer per day**: local-midnight rotation, lazily created on the first inbound message, titled `<YYYY-MM-DD>`; a day without conversation never materializes a session, and a corrupt log can't block the next day.
- **🛡️ Crash-safe by construction**: cross-process poll lock (`~/.dsh/wechat-bridge/poll.lock`), per-chat serialization, inbound dedupe (each `message_id` at most once), corrupt logs quarantined as `.corrupt-<ts>` and rebuilt.
- **🚪 Inbound allowlist (fail-closed)**: empty `allowedPeers` = deny everyone; matching on the WeChat id (`from_user_id`), not the display name; comma-separated; editable in the Settings UI.
- **📤 Outbound media**: the agent calls the `wechat_send_file` tool to upload a local image/video/file to the WeChat CDN and send it to the current peer (routed by extension, optional caption).
- **📥 Inbound media**: images/files/videos/voice are downloaded from the CDN and AES-decrypted, parked under `WeChatSpace/inbox/<date>/` and described by path; images are attached as native image content when the selected model declares image input.
- **🧠 GUI-equivalent context**: each day's session is created with the user-global `~/.dsh/AGENTS.md` and the available skill catalog (`<available_skills>`) injected up front, mounting the same agent preset as the GUI.
- **🚫 Interactive option UI disabled (hang-proofing)**: `ask_user_question` and other interactive-option tools are denied in WeChat sessions — their answer channel is the DSH web GUI, unreachable from the phone; questions and options are inlined as plain text instead, and the user replies with a normal message.
- **💾 Self-contained persistence**: accounts, `context_token`s, and poll offsets live in one atomic JSON file (`~/.dsh/wechat-bridge/state.json`); no database. Sessions live under `~/.dsh/wechat-bridge/WeChatSpace`.
- **🔁 Automatic migration**: the legacy `weixin-bridge` data directory and settings section are renamed once to `wechat-*`; an account pauses for 60 minutes on `errcode -14` (session expired).

## Quick Start

### Prerequisites

- DeepSeek Harness installed (`dsh web` runs).
- A WeChat account with `ilink bot` permission (`bot_type=3`).
- Note: the harness resolves bundle deps from the flat `~/.dsh/profiles/node_modules` fallback, so **do not** symlink the package from outside the profile tree (ESM); copy it under the profile. (A `file:` dependency + `dsh.profile.bundles` entry is the canonical registration; the copy is the booted artifact.)

### Install (into the `web` profile)

One-line install:

```bash
dsh plugin --profile web add github:NattoCB/dsh-plugin-wechat-bridge
```

Manual install steps follow.

```bash
# 1. copy the plugin under the web profile's node_modules
#    (keep vendored deps: qrcode/pngjs/dijkstrajs live in the plugin's own node_modules)
SRC=/path/to/dsh-plugin-wechat-bridge
DST=~/.dsh/profiles/web/node_modules/dsh-plugin-wechat-bridge
rm -rf "$DST" && cp -R "$SRC" "$DST"

# 2. register in the profile manifest (~/.dsh/profiles/web/package.json)
#    dependencies: add  "dsh-plugin-wechat-bridge": "file:<SRC>"
#    dsh.profile.bundles: add "dsh-plugin-wechat-bridge"

# 3. (re)start dsh web — the bundle patch mounts the `wechat-bridge` service
#    and serves the client settings tab at /plugins/<id>/client.js
dsh web
```

### Bind by QR code

Open **Settings → "微信桥接" (WeChat bridge)** in the bottom-left of the DSH web UI → click "扫码绑定账号" (bind account) → the QR code renders inline (PNG data URL) → scan status auto-polls every 2 seconds → once confirmed in WeChat, the account is saved and the bridge enabled.

Or use the CLI in any DSH chat: `/wechat qrlogin` starts a login (returns a `sessionId`) → `/wechat qrstatus <sessionId>` polls the status; on `confirmed` the account is saved and enabled.

### Run

Message the bot ("what's on today") — the agent answers as if you were in the GUI, and the reply comes back as plain text. The service mounts at boot; if `settings.wechat-bridge.enabled` is true it starts polling immediately, otherwise it idles until enabled.

## Configuration

### Options

| key | default | meaning |
|:----|:--------|:--------|
| `enabled` | `false` | boot-time autostart when the settings flag is absent; re-applied live on every change |
| `mediaEnabled` | `true` | accept inbound media (download / decrypt / park) |
| `defaultProvider` | `''` | provider override for bridged sessions (empty = follow global default; editable in the Settings tab) |
| `defaultModel` | `''` | model override for bridged sessions (empty = follow global default; editable in the Settings tab) |
| `allowedPeers` | `''` | inbound allowlist: WeChat ids (`from_user_id`) allowed to drive the agent, comma-separated; empty = deny everyone (fail-closed) |
| `dataDir` | `~/.dsh/wechat-bridge` | where `state.json` (accounts / tokens / offsets) lives |
| `defaultCwd` | `''` | working dir for new sessions (else `~/.dsh/wechat-bridge/WeChatSpace`) |

`enabled`, `mediaEnabled`, `defaultProvider`, `defaultModel` and `allowedPeers` also live in the `wechat-bridge:` section of `~/.dsh/settings.yaml`; editing and saving re-applies them live:

```yaml
wechat-bridge:
  enabled: true        # live toggle; the service re-applies on every change
  mediaEnabled: true
  defaultProvider: ''  # bridged-session provider (empty = follow global default)
  defaultModel: ''     # bridged-session model (empty = follow global default)
  allowedPeers: 'wxid_abc123, wxid_def456'  # inbound allowlist, comma-separated
```

### Inbound allowlist (fail-closed)

`allowedPeers` is a **deny-by-default** inbound gate: only the WeChat ids listed may drive an agent session.

- **Empty means nobody** (the safe default, not everyone) — messages from non-listed ids are ignored, and the sender gets a hint carrying their WeChat id so the operator can enroll themselves in the Settings tab.
- Matching is on the **WeChat id** (`from_user_id`), not the display name — names change, ids are stable.
- Multiple ids are comma-separated, e.g. `wxid_abc123, wxid_def456`.
- Hot-reloaded, no restart; also editable directly in the Settings UI tab.

### Runtime enable / disable (hot plug)

1. **Settings UI tab**: status card (running state + enable/disable button, effective immediately), default-model card (two dropdowns pick provider/model from DSH's registered models), accounts card (account id, token status, last login time + remove), QR bind.
2. **Slash command** (in any DSH chat):
   - `/wechat status` — running? account count?
   - `/wechat enable` — start the poll loop now (also writes `settings.wechat-bridge.enabled=true`)
   - `/wechat disable` — stop the poll loop now (writes `settings.wechat-bridge.enabled=false`)
   - `/wechat accounts` — list configured accounts
   - `/wechat qrlogin` — start a QR login; returns a `sessionId`
   - `/wechat qrstatus <sessionId>` — poll scan status; on `confirmed` saves the account and enables
   - `/wechat rm <accountId>` — remove an account
3. **Settings flag** (hot-reloaded): edit `wechat-bridge.enabled` in `~/.dsh/settings.yaml`; saving re-reads the flag and starts/stops the loop.

The UI tab calls the plugin's own HTTP API (`/wechat-bridge/*`) served by the host webserver — no external service involved.

### Session model

- Session id: `wechat-<chatId>-<YYYY-MM-DD>` (local machine timezone, e.g. `2026-08-15`); created lazily on the first inbound message of the day, never pre-created at midnight.
- Title: `<YYYY-MM-DD>`, pinned with the `user` title source so automatic title generation never overwrites it.
- Default cwd: `~/.dsh/wechat-bridge/WeChatSpace` (created on boot; override with `defaultCwd`).
- Peer identity stays encoded as `weixin::<accountId>::<peerUserId>` (protocol layer, shared with the CodePilot lineage); only the plugin's own naming uses `wechat-*`.

### Files

```
src/index.js        WechatBridgeService: poll loop, agent-driving, per-day sessions, hot-plug, /wechat command, /wechat-bridge/* HTTP API (QR rendered server-side)
client/client.js    Client bundle: registers the Settings "微信桥接" section slot (React)
src/weixin-api.js   ilink bot protocol client (getupdates/sendmessage/sendtyping/getconfig/qrlogin)
src/weixin-media.js inbound media CDN download + AES decrypt, outbound media CDN upload
src/weixin-ids.js   synthetic chatId encode/decode (weixin::<accountId>::<peerUserId>)
src/weixin-types.js protocol enums/constants
src/store.js        JSON-file persistence (accounts, context_tokens, offsets; legacy-dir migration)
cordis.patch.yml    bundle patch (registers service `wechat-bridge`)
package.json        declares dsh.bundle + dsh.client (web)
node_modules/       vendored qrcode/pngjs/dijkstrajs (QR data-URL rendering, no pnpm needed)
```

### Notes / scope

- Outbound media is agent-initiated via the `wechat_send_file` tool; inbound voice is parked on disk only (no transcription).
- Private chat only; no group semantics.
- Requires a WeChat account with `ilink bot` permission (`bot_type=3`).
- Persistence is a single atomic JSON file (`state.json`) — sufficient for one DSH process.
- The per-chat queue serializes within one process; the cross-process poll lock and message dedupe cover the multi-process case (keep the port single-owned anyway).

---

<div align="center">

[MIT License](https://github.com/NattoCB/dsh-plugin-wechat-bridge) · [GitHub repo](https://github.com/NattoCB/dsh-plugin-wechat-bridge) · [Open an issue](https://github.com/NattoCB/dsh-plugin-wechat-bridge/issues)

</div>
