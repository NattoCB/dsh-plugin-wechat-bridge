# Changelog

All notable changes to this plugin are documented in this file.

## [0.1.0] - 2026-08-16

- Initial release of the WeChat (ilink bot) bridge for DeepSeek Harness.
- Multi-account polling of the WeChat ilink bot API with one session per peer per day.
- Cross-process poll lock, per-chat serialization, inbound dedupe, and corrupt-log self-heal.
- Runtime hot-plug from the Settings UI tab, `/wechat` slash commands, or `settings.yaml`.
- QR-code account binding from the Settings tab.
- Context parity with GUI sessions: injects the user-global `AGENTS.md` and the skill catalog.
- Inbound media download + AES decrypt; outbound media via the `wechat_send_file` tool.
