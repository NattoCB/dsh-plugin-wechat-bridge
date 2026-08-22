// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	NAME_PREFIX_LIMIT,
	RESPONSE_PREFIX_LIMIT,
	prefixWithEllipsis,
	flattenText,
	extractTurnResponse,
	turnEndFallbackText,
	deriveSessionName,
	shouldNotifySession,
	formatTurnNotification,
	stripMarkup,
} from "../src/notify.js";

// ── fixtures ─────────────────────────────────────────────────────────────

/** Build one assistant/message-like session event. */
function assistantMessage(turn, text, seq = 0) {
	return { type: "assistant/message", seq, data: { turn, message: { content: [{ type: "text", text }] } } };
}

function userMessage(text, kind = "user", seq = 0) {
	return { type: "user/message", seq, data: { source: { kind }, content: [{ type: "text", text }] } };
}

// ── prefixWithEllipsis / flattenText ──────────────────────────────────────

test("prefixWithEllipsis keeps short text unchanged", () => {
	assert.equal(prefixWithEllipsis("短文本", 15), "短文本");
	assert.equal(prefixWithEllipsis("", 15), "");
});

test("prefixWithEllipsis truncates at the limit and appends ...", () => {
	const long = "一".repeat(30);
	assert.equal(prefixWithEllipsis(long, 15), "一".repeat(15) + "...");
	assert.equal(prefixWithEllipsis("abcdefghij", 5), "abcde...");
});

test("flattenText collapses newlines and control characters to one line", () => {
	assert.equal(flattenText("第一行\n第二行\r\n\t第三行"), "第一行 第二行 第三行");
	assert.equal(flattenText("a\u0000b\u0007c"), "abc");
});

test("flattenText tolerates null and undefined", () => {
	assert.equal(flattenText(null), "");
	assert.equal(flattenText(undefined), "");
});

// ── extractTurnResponse ───────────────────────────────────────────────────

test("extractTurnResponse picks the last non-empty assistant text of the turn", () => {
	const events = [
		userMessage("你好"),
		assistantMessage(1, "中间步骤说明", 2),
		assistantMessage(1, "", 3), // empty text must not win
		assistantMessage(1, "最终回答", 4),
	];
	assert.equal(extractTurnResponse(events, 1), "最终回答");
});

test("extractTurnResponse ignores other turns' messages", () => {
	const events = [
		assistantMessage(0, "上一回合的回复", 1),
		assistantMessage(2, "下一回合的回复", 3),
	];
	assert.equal(extractTurnResponse(events, 1), "");
});

test("extractTurnResponse joins multi-block messages and returns '' when none", () => {
	const events = [{
		type: "assistant/message",
		seq: 9,
		data: { turn: 7, message: { content: [{ type: "text", text: "A" }, { type: "text", text: "B" }, { type: "tool-call" }] } },
	}];
	assert.equal(extractTurnResponse(events, 7), "AB");
	assert.equal(extractTurnResponse([], 7), "");
});

// ── turnEndFallbackText ───────────────────────────────────────────────────

test("turnEndFallbackText maps reason kinds to fixed strings", () => {
	assert.match(turnEndFallbackText({ kind: "error", error: { message: "HTTP 400 boom" } }), /⚠️ 回合失败: HTTP 400 boom/);
	assert.equal(turnEndFallbackText({ kind: "aborted" }), "(回合被中断，无文本回复)");
	assert.equal(turnEndFallbackText({ kind: "blocked" }), "(回合受阻，无文本回复)");
	assert.equal(turnEndFallbackText({ kind: "completed" }), "(本轮无文本回复)");
	assert.equal(turnEndFallbackText(undefined), "(本轮无文本回复)");
});

// ── deriveSessionName ─────────────────────────────────────────────────────

test("deriveSessionName prefers the latest session/title event", () => {
	const events = [
		{ type: "session/title", seq: 1, data: { title: "旧标题" } },
		{ type: "session/title", seq: 8, data: { title: "新标题" } },
	];
	assert.equal(deriveSessionName(events), "新标题");
});

test("deriveSessionName falls back to the first real user prompt", () => {
	const events = [
		userMessage("[系统注入] 不要看这个", "agent-instructions", 1),
		userMessage("帮我查一下天气\n顺便看看新闻", "user", 2),
	];
	assert.equal(deriveSessionName(events), "帮我查一下天气");
});

test("deriveSessionName returns the fallback when nothing matches", () => {
	assert.equal(deriveSessionName([]), "未命名会话");
	assert.equal(deriveSessionName([userMessage("自动化提示", "automation")]), "未命名会话");
});

// ── shouldNotifySession ───────────────────────────────────────────────────

test("shouldNotifySession skips the bridge's own daily sessions", () => {
	assert.equal(shouldNotifySession("wechat-weixin::a::b-2026-08-21", {}), false);
	assert.equal(shouldNotifySession("wechat-selftest::123-2026-08-21", {}), false);
});

test("shouldNotifySession skips subagent children by origin or depth", () => {
	assert.equal(shouldNotifySession("session-abc", { origin: "subagent" }), false);
	assert.equal(shouldNotifySession("session-abc", { delegationDepth: 1 }), false);
	assert.equal(shouldNotifySession("session-abc", { delegationDepth: 0 }), true);
	assert.equal(shouldNotifySession("session-abc", {}), true);
});

test("shouldNotifySession allows top-level ids without a header", () => {
	assert.equal(shouldNotifySession("dsh-automation-session-xyz", undefined), true);
	assert.equal(shouldNotifySession(undefined, {}), false);
});

// ── stripMarkup (shared with the reply path) ─────────────────────────────

test("stripMarkup removes markdown decorations", () => {
	assert.equal(stripMarkup("**加粗** 与 `code`"), "加粗 与 code");
	assert.equal(stripMarkup("[链接](https://x.y)"), "链接");
	assert.equal(stripMarkup("```js\nconst a = 1;\n```"), "const a = 1;\n");
});

// ── formatTurnNotification ────────────────────────────────────────────────

test("formatTurnNotification renders the exact two-line template", () => {
	const events = [
		userMessage("需求分析", "user", 1),
		{ type: "session/title", seq: 0, data: { title: "我的会话" } },
		assistantMessage(3, "这是最终回复内容", 2),
	];
	const out = formatTurnNotification({
		events,
		turn: 3,
		reason: { kind: "completed" },
		sessionId: "session-abcdef12-3456",
	});
	assert.equal(out, "【会话通知：我的会话（sessio）】\n这是最终回复内容");
});

test("formatTurnNotification truncates long names and responses with ...", () => {
	const events = [assistantMessage(1, "回".repeat(RESPONSE_PREFIX_LIMIT + 50))];
	const out = formatTurnNotification({
		events,
		turn: 1,
		reason: { kind: "completed" },
		sessionId: "s1234567890",
	});
	const lines = out.split("\n");
	assert.equal(lines.length, 2);
	assert.ok(lines[0].startsWith("【会话通知："));
	assert.ok(lines[0].includes("（s12345）")); // first 6 id chars, full-width parens
	assert.ok(lines[0].endsWith("）】"));
	assert.equal(lines[1], "回".repeat(RESPONSE_PREFIX_LIMIT) + "...");
});

test("formatTurnNotification flattens multiline responses into one line", () => {
	const events = [assistantMessage(1, "第一段。\n第二段：**要点**。")];
	const out = formatTurnNotification({ events, turn: 1, reason: {}, sessionId: "sid-001" });
	assert.equal(out.split("\n")[1], "第一段。 第二段：要点。");
});

test("formatTurnNotification uses fixed fallbacks for response-less turns", () => {
	const out = formatTurnNotification({
		events: [],
		turn: 2,
		reason: { kind: "error", error: { message: "NO_ADAPTER\n细节" } },
		sessionId: "session-xyz",
	});
	assert.ok(out.includes("⚠️ 回合失败: NO_ADAPTER 细节"));
});

test("name/response limits match the spec constants", () => {
	assert.equal(NAME_PREFIX_LIMIT, 15);
	assert.equal(RESPONSE_PREFIX_LIMIT, 200);
});
