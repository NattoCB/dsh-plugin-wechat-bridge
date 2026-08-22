# Changelog

All notable changes to this plugin are documented in this file.

## [Unreleased]

- One-way session turn-end notifications (`notifyEnabled`, default off): every
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
