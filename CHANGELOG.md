# Changelog

All notable changes to this plugin are documented in this file.

## [Unreleased]

- Surface real model-call failures to WeChat instead of a generic
  「(空回复)」: when the driven turn ends with reason.kind === 'error' and
  produced no assistant text, the bridge now replies
  「⚠️ 模型调用失败（provider/model）：<上游错误原文>」
  (new pure helper `formatTurnErrorReply`, +3 tests).
- 默认模型 card + docs now state explicitly that the pinned
  defaultProvider/defaultModel is re-installed on EVERY inbound message —
  switching models inside a WeChat session from the web GUI does not affect
  WeChat replies (this caused the confusing "switched to openrouter but
  still API key invalid" case: the calls were still going out on the old
  pinned provider with its dead key).

- Settings-tab allowlist editor (「入站白名单」card): edit `allowedPeers`
  directly (normalized comma-separated), persisted via
  POST /wechat-bridge/config → settings.yaml. Shows clickable
  「已对话过的 ID」chips built from stored context tokens — the opaque
  internal peer ids only become known through an actual conversation, so
  denied peers now also get their context token recorded and their id
  echoed back by the bot. Card carries an explicit hint that these ids are
  NOT WeChat aliases/nicknames.
- Settings-tab toggle for one-way session notifications (「会话通知」card,
  persisted via POST /wechat-bridge/config → settings.yaml).
- One-way session turn-end notifications (`notifyEnabled`, default ON): every
  top-level DSH session's finished turn pings the allowlisted peers with a
  fixed two-line template (session name ≤15 chars + session id first 6 chars,
  then the turn response ≤200 chars) — no LLM summarization.
  Notifications go straight through the WeChat API and are never written into
  any session: the daily bridge conversation neither sees nor is extended by
  them (mutual non-pollution). Bridge-owned sessions and subagent children are
  skipped; reload-artifact `interrupted` turn closers are skipped too.

## [0.1.0] - 2026-08-16

- Initial release of the WeChat (ilink bot) bridge for DeepSeek Harness.
- Multi-account polling of the WeChat ilink bot API with one session per peer per day.
- Cross-process poll lock, per-chat serialization, inbound dedupe, and corrupt-log self-heal.
- Runtime hot-plug from the Settings UI tab, `/wechat` slash commands, or `settings.yaml`.
- QR-code account binding from the Settings tab.
- Context parity with GUI sessions: injects the user-global `AGENTS.md` and the skill catalog.
- Inbound media download + AES decrypt; outbound media via the `wechat_send_file` tool.
