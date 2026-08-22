window.__ModuleLoader__.load({
	id: "dsh-plugin-wechat-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		// ── CSS (settings-tab scoped) ──────────────────────────────────────
		const css = ".wxb_section{width:100%;max-width:760px;display:flex;flex-direction:column;gap:14px}.wxb_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}.wxb_card h3{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}.wxb_row{display:flex;align-items:center;justify-content:space-between;gap:10px}.wxb_label{color:var(--dsw-alias-label-secondary);font-size:13px}.wxb_value{color:var(--dsw-alias-label-tertiary);font-size:12px}.wxb_status{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:13px}.wxb_dot{border-radius:999px;width:7px;height:7px;display:inline-block;background:var(--dsw-alias-label-tertiary)}.wxb_dot[data-on=\"true\"]{background:var(--dsw-alias-state-success-primary)}.wxb_btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:6px;padding:4px 12px;font-size:13px}.wxb_btn:hover{background:var(--dsw-alias-interactive-bg-hover)}.wxb_btn[data-danger=\"true\"]{color:var(--dsw-alias-state-error-primary)}.wxb_btn[data-primary=\"true\"]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}.wxb_accounts{display:flex;flex-direction:column;gap:8px}.wxb_account{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 12px;display:flex;flex-direction:column;gap:4px}.wxb_accountTop{display:flex;align-items:center;justify-content:space-between;gap:8px}.wxb_qr{display:flex;flex-direction:column;align-items:center;gap:10px}.wxb_qr img{width:256px;height:256px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.wxb_err{color:var(--dsw-alias-state-error-primary);font-size:13px}.wxb_sel{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;border-radius:6px;padding:4px 8px;font-size:13px;max-width:320px;min-width:200px}.wxb_sel:disabled{opacity:.5;cursor:default}.wxb_field{display:flex;flex-direction:column;gap:4px}.wxb_switch{position:relative;flex:none;width:40px;height:22px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);cursor:pointer;padding:0;font:inherit}.wxb_switch::after{content:\"\";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:left .15s ease,background .15s ease}.wxb_switch[data-on=\"true\"]{background:var(--dsw-alias-state-success-primary);border-color:transparent}.wxb_switch[data-on=\"true\"]::after{left:20px;background:#fff}.wxb_switch:disabled{opacity:.5;cursor:default}.wxb_input{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;border-radius:6px;padding:6px 8px;font-size:13px;resize:vertical}.wxb_input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}.wxb_input:disabled{opacity:.5}.wxb_chips{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.wxb_chip{border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;border-radius:999px;padding:2px 10px;cursor:pointer}.wxb_chip:hover{color:var(--dsw-alias-label-primary);border-style:solid}.wxb_chip:disabled{opacity:.5;cursor:default}";
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

		// ── allowlist list editing helpers ─────────────────────────────
		// Canonical form: comma-separated trimmed ids (also accepts Chinese/
		// full-width commas typed by hand). Empty result = deny everyone.
		function normalizePeerList(text) {
			return String(text ?? "").split(/[,\uFF0C;]/).map((x) => x.trim()).filter(Boolean).join(", ");
		}
		function appendPeerId(existing, id) {
			const parts = String(existing ?? "").split(",").map((x) => x.trim()).filter(Boolean);
			if (!parts.includes(id)) parts.push(id);
			return parts.join(", ");
		}

		// ── Section component ─────────────────────────────────────────────
		const { useState, useEffect, useCallback } = react;
		const { jsx, jsxs, Fragment } = react_jsx_runtime;

		function WeixinBridgeSection(props) {
			const [status, setStatus] = useState(null);
			const [error, setError] = useState(null);
			const [qr, setQr] = useState(null); // { sessionId, qrImage }
			const [busy, setBusy] = useState(false);
			const [options, setOptions] = useState({ providers: [] }); // model dropdown options
			const [selProvider, setSelProvider] = useState("");
			const [selModel, setSelModel] = useState("");
			// Allowlist editor state: `saved` mirrors the persisted value, `draft`
			// is what the operator types. load() only overwrites the draft when it
			// has no unsaved edits (draft === saved), so toggling other controls
			// never clobbers in-progress whitelist edits.
			const [peers, setPeers] = useState({ saved: "", draft: "" });

			const load = useCallback(async () => {
				try {
					const [s, o] = await Promise.all([
						api("GET", "status"),
						api("GET", "model-options"),
					]);
					setStatus(s);
					setOptions(o ?? { providers: [] });
					setSelProvider((prev) => prev || s.defaultProvider || "");
					setSelModel((prev) => prev || s.defaultModel || "");
					setPeers((prev) => {
						const ap = s.allowedPeers || "";
						return prev.draft === prev.saved ? { saved: ap, draft: ap } : { ...prev, saved: ap };
					});
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
			// Notification toggle: default ON; a missing field (older host) also reads as on.
			const notifyOn = status !== null && status?.notifyEnabled !== false;
			const knownPeers = status?.knownPeers ?? [];

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
					jsx("h3", { children: "会话通知" }),
					jsxs("div", { className: "wxb_row", children: [
						jsxs("span", { className: "wxb_status", children: [
							jsx("button", {
								className: "wxb_switch",
								role: "switch",
								"aria-checked": notifyOn ? "true" : "false",
								"data-on": notifyOn ? "true" : "false",
								disabled: busy || status === null,
								onClick: () => act(() => api("POST", "config", { notifyEnabled: !notifyOn })),
							}),
							notifyOn ? "已开启" : "已关闭",
						] }),
					] }),
					jsx("div", { className: "wxb_value", children: "任何顶层 DSH 会话的回合结束时，向白名单微信推送固定模板简讯（单向通知，不进入桥接会话；子代理回合不推）。状态持久化到 settings.yaml。" }),
				] }),
				jsxs("div", { className: "wxb_card", children: [
					jsx("h3", { children: "入站白名单" }),
					jsx("textarea", {
						className: "wxb_input",
						rows: 2,
						disabled: busy || status === null,
						placeholder: "NhatoCola_F, another_id",
						value: peers.draft,
						onChange: (ev) => setPeers((prev) => ({ ...prev, draft: ev.target.value })),
					}),
					knownPeers.length > 0 && jsxs("div", { className: "wxb_chips", children: [
						jsx("span", { className: "wxb_label", children: "已对话过的 ID（点击加入白名单）：" }),
						...knownPeers.map((p) => jsx("button", {
							className: "wxb_chip",
							disabled: busy || status === null || peers.draft.includes(p),
							onClick: () => setPeers((prev) => ({ ...prev, draft: appendPeerId(prev.draft, p) })),
							children: p,
						}, p)),
					] }),
					jsxs("div", { className: "wxb_row", children: [
						jsx("span", { className: "wxb_value", children: "留空 = 拒绝所有人" }),
						jsx("button", {
							className: "wxb_btn",
							"data-primary": "true",
							disabled: busy || status === null,
							onClick: () => act(() => api("POST", "config", { allowedPeers: normalizePeerList(peers.draft) })),
							children: "保存",
						}),
					] }),
					jsx("div", { className: "wxb_value", children: "注意：这里的 ID 不是微信号或昵称，而是机器人的内部 ID（一串奇怪的字符），无法从微信资料里查到。获取方式：用对方微信给机器人发一条消息——即使未入白名单，机器人也会自动回复该 ID，同时它会出现在上方「已对话过的 ID」里，点一下即可填入。多个 ID 用英文逗号分隔。" }),
				] }),
				jsxs("div", { className: "wxb_card", children: [
					jsx("h3", { children: "默认模型" }),
					jsxs("div", { className: "wxb_row", children: [
						jsxs("span", { className: "wxb_field", children: [
							jsx("span", { className: "wxb_label", children: "Provider" }),
							jsx("select", {
								className: "wxb_sel",
								disabled: busy,
								value: selProvider,
								onChange: (ev) => { setSelProvider(ev.target.value); setSelModel(""); },
								children: [
									jsx("option", { value: "", children: "跟随全局默认" }),
									...(options.providers || []).map((pr) =>
										jsx("option", { value: pr.id, children: pr.name || pr.id }, pr.id)),
								],
							}),
						] }),
						jsxs("span", { className: "wxb_field", children: [
							jsx("span", { className: "wxb_label", children: "Model" }),
							jsx("select", {
								className: "wxb_sel",
								disabled: busy,
								value: selModel,
								onChange: (ev) => setSelModel(ev.target.value),
								children: [
									jsx("option", { value: "", children: "跟随全局默认" }),
									...((options.providers || []).find((pr) => pr.id === selProvider)?.models || []).map((m) =>
										jsx("option", { value: m.id, children: m.name || m.id }, m.id)),
								],
							}),
						] }),
						jsx("button", {
							className: "wxb_btn",
							"data-primary": "true",
							disabled: busy,
							onClick: () => act(() => api("POST", "config", { defaultProvider: selProvider, defaultModel: selModel })),
							children: "保存",
						}),
					] }),
					jsx("div", { className: "wxb_value", children: "微信会话使用的模型；留空则跟随 DSH 全局默认。选择持久化到 settings.yaml。" }),
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
