window.__ModuleLoader__.load({
	id: "dsh-plugin-wechat-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		// ── CSS (settings-tab scoped) ──────────────────────────────────────
		const css = ".wxb_section{width:100%;max-width:760px;display:flex;flex-direction:column;gap:14px}.wxb_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}.wxb_card h3{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}.wxb_row{display:flex;align-items:center;justify-content:space-between;gap:10px}.wxb_label{color:var(--dsw-alias-label-secondary);font-size:13px}.wxb_value{color:var(--dsw-alias-label-tertiary);font-size:12px}.wxb_status{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:13px}.wxb_dot{border-radius:999px;width:7px;height:7px;display:inline-block;background:var(--dsw-alias-label-tertiary)}.wxb_dot[data-on=\"true\"]{background:var(--dsw-alias-state-success-primary)}.wxb_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:6px;padding:4px 12px;font-size:13px}.wxb_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}.wxb_btn[data-danger=\"true\"]{color:var(--dsw-alias-state-error-primary)}.wxb_btn[data-primary=\"true\"]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}.wxb_accounts{display:flex;flex-direction:column;gap:8px}.wxb_account{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:4px}.wxb_accountTop{display:flex;align-items:center;justify-content:space-between;gap:8px}.wxb_qr{display:flex;flex-direction:column;align-items:center;gap:10px}.wxb_qr img{width:256px;height:256px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.wxb_err{color:var(--dsw-alias-state-error-primary);font-size:13px}";
		const tagId = "dsh-plugin-wechat-bridge/settings.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-plugin-wechat-bridge";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ── HTTP client to the host API ───────────────────────────────────
		async function api(method, path, body) {
			const res = await fetch("/wechat-bridge/" + path, {
				method,
				headers: body !== undefined ? { "content-type": "application/json" } : undefined,
				body: body !== undefined ? JSON.stringify(body) : undefined,
			});
			const json = await res.json().catch(() => ({}));
			if (!res.ok || json.ok === false) throw new Error(json.error || `HTTP ${res.status}`);
			return json;
		}

		// ── Section component ─────────────────────────────────────────────
		const { useState, useEffect, useCallback } = react;
		const { jsx, jsxs, Fragment } = react_jsx_runtime;

		function WeixinBridgeSection(props) {
			const [status, setStatus] = useState(null);
			const [error, setError] = useState(null);
			const [qr, setQr] = useState(null); // { sessionId, qrImage }
			const [busy, setBusy] = useState(false);

			const load = useCallback(async () => {
				try {
					const s = await api("GET", "status");
					setStatus(s);
					setError(null);
				} catch (e) {
					setError(e.message);
				}
			}, []);

			useEffect(() => { load(); }, [load]);

			// Poll QR status while a login session is shown.
			useEffect(() => {
				if (!qr) return;
				const timer = setInterval(async () => {
					try {
						const r = await api("POST", "qrstatus", { sessionId: qr.sessionId });
						if (r.status === "confirmed") {
							clearInterval(timer);
							setQr(null);
							setBusy(false);
							await load();
						} else if (r.status === "expired" || r.status === "failed") {
							clearInterval(timer);
							setError("QR 已过期，请重新发起");
							setQr(null);
							setBusy(false);
						}
					} catch (e) { /* transient poll error — keep polling */ }
				}, 2000);
				return () => clearInterval(timer);
			}, [qr, load]);

			const act = async (fn) => {
				setBusy(true);
				try { await fn(); await load(); } catch (e) { setError(e.message); }
				finally { setBusy(false); }
			};

			const running = status?.running === true;
			const accounts = status?.accounts ?? [];

			return jsxs("div", { className: "wxb_section", children: [
				jsxs("div", { className: "wxb_card", children: [
					jsx("h3", { children: "微信桥接状态" }),
					jsxs("div", { className: "wxb_row", children: [
						jsxs("span", { className: "wxb_status", children: [
							jsx("span", { className: "wxb_dot", "data-on": running ? "true" : "false" }),
							running ? "运行中" : "已停止",
						] }),
						jsx("button", {
							className: "wxb_btn",
							"data-primary": !running ? "true" : undefined,
							disabled: busy,
							onClick: () => act(() => api("POST", running ? "disable" : "enable")),
							children: running ? "停用" : "启用",
						}),
					] }),
					jsx("div", { className: "wxb_value", children: "轮询已绑定账号的消息并驱动 DSH agent 会话；启用状态持久化到 settings.yaml。" }),
				] }),
				jsxs("div", { className: "wxb_card", children: [
					jsx("h3", { children: "已绑定账号" }),
					accounts.length === 0
						? jsx("div", { className: "wxb_value", children: "还没有绑定任何微信账号。点击下方按钮扫码绑定。" })
						: jsx("div", { className: "wxb_accounts", children: accounts.map((a) =>
							jsxs("div", { className: "wxb_account", key: a.accountId, children: [
								jsxs("div", { className: "wxb_accountTop", children: [
									jsxs("span", { className: "wxb_label", children: [
										a.name || a.accountId,
										a.enabled ? "" : "（已停用）",
									] }),
									jsx("button", {
										className: "wxb_btn",
										"data-danger": "true",
										disabled: busy,
										onClick: () => act(() => api("POST", "remove", { accountId: a.accountId })),
										children: "移除",
									}),
								] }),
								jsx("div", { className: "wxb_value", children: `${a.accountId} · token=${a.hasToken ? "已存" : "缺失"} · ${a.lastLoginAt || "从未登录"}` }),
							] })
						) }),
					jsx("div", { className: "wxb_row", children: [
						jsx("span", { className: "wxb_value", children: "需要具备 ilink bot 权限的微信账号（bot_type=3）。" }),
						jsx("button", {
							className: "wxb_btn",
							"data-primary": "true",
							disabled: busy || qr !== null,
							onClick: () => act(async () => setQr(await api("POST", "qrlogin"))),
							children: "扫码绑定账号",
						}),
					] }),
				] }),
				qr && jsxs("div", { className: "wxb_card", children: [
					jsx("h3", { children: "扫码绑定（等待确认）" }),
					jsxs("div", { className: "wxb_qr", children: [
						jsx("img", { src: qr.qrImage, alt: "WeChat login QR" }),
						jsx("div", { className: "wxb_value", children: "用手机微信扫码并确认，确认后自动完成绑定。" }),
						jsx("button", { className: "wxb_btn", onClick: () => setQr(null), children: "取消" }),
					] }),
				] }),
				error && jsx("div", { className: "wxb_err", children: error }),
			] });
		}

		// ── Slot registration ─────────────────────────────────────────────
		const inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "wechat",
				order: 90,
				label: () => "微信桥接",
				children: {},
			}, WeixinBridgeSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
