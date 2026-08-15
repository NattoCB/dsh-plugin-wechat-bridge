// dsh-plugin-wechat-bridge
//
// A DSH cordis bundle that bridges WeChat (ilink bot) private-chat messages into
// a DSH agent session, and sends the agent's reply back as plain text.
//
// One session per peer per calendar day (local timezone): the first inbound
// message after local midnight lazily creates that day's session, titled
// "<YYYY-MM-DD>". Days without conversation never materialize a session.
//
// Runtime enable/disable (hot plug):
//   - Boot reads settings `wechatBridge.enabled`. If true, the poll loop starts.
//   - The `settings/updated` event re-reads the flag and starts/stops live.
//   - The `/wechat` slash command toggles enable/disable/status without editing
//     files, and writes the flag back to settings.yaml so it persists.
//
// Ported from CodePilot's bridge subsystem (src/lib/bridge/adapters/weixin/*).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { Store } from './store.js';
import {
  getUpdates,
  sendMessage,
  sendTextMessage,
  sendTyping,
  getConfig,
  startLoginQr,
  pollLoginQrStatus,
} from './weixin-api.js';
import { encodeWeixinChatId, decodeWeixinChatId } from './weixin-ids.js';
import { ERRCODE_SESSION_EXPIRED } from './weixin-types.js';
import { downloadMediaFromItem, uploadMediaToCdn } from './weixin-media.js';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import QRCode from 'qrcode';

const name = 'wechat-bridge';
// kebab-case required by DSH settings namespace validation.
const SETTINGS_NS = settingsNamespace('wechat-bridge');
const SETTINGS_SCHEMA = z.object({
  enabled: z.boolean().default(false),
  mediaEnabled: z.boolean().default(true),
  defaultProvider: z.string().default(''),
  defaultModel: z.string().default(''),
});

/** Local-calendar day key YYYY-MM-DD in this machine's timezone. */
function localDateKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

function chunkText(text, limit) {
  const out = [];
  for (let i = 0; i < text.length; i += limit) out.push(text.slice(i, i + limit));
  return out;
}

function stripMarkup(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`{3}[\s\S]*?`{3}/g, (m) => m.replace(/`{3}\w*\n?/g, '').replace(/`{3}/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

export const apply = (ctx, config) => {
  new WeixinBridgeService(ctx, config);
};

class WeixinBridgeService {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config || {};
    this.store = new Store(this.config.dataDir || '');
    this.running = false;
    this._stop = null;
    this._loginSessions = new Map(); // qr sessionId -> { qrcode, qrImage, status, ... }
    this._pauses = new Map(); // accountId -> resumeAt
    this._typingTickets = new Map(); // `accountId:peer` -> ticket
    this._driveQueues = new Map(); // chatId -> promise chain (serializes _driveAgent per chat)
    // Cross-process poll lock: only one DSH process may poll WeChat accounts.
    // A second process (launchd keep-alive racing a manual restart) would
    // otherwise poll the same account twice and interleave writes into the
    // same session log — the seq-gap corruption trigger.
    this._pollLockPath = path.join(
      process.env.DSH_HOME || path.join(process.env.HOME, '.dsh'),
      'wechat-bridge', 'poll.lock',
    );
    this._pollLockHeld = false;
    this._pollLockTimer = null;

    // Release the poll lock on service dispose (graceful shutdown path).
    ctx.on('dispose', () => { void this._releasePollLock(); });

    // Sessions are created under <DSH_HOME>/wechat-bridge/WeChatSpace by
    // default; make sure it exists before the first inbound message.
    try {
      fs.mkdirSync(this.workspaceDir(), { recursive: true });
    } catch (err) {
      this.ctx.logger?.warn?.(`[wechat-bridge] workspace dir create failed: ${err.message}`);
    }

    ctx.commands?.register({
      name: 'wechat',
      description: 'Control the WeChat (ilink bot) bridge: enable / disable / status / qrlogin / accounts',
      input: { hint: '[enable|disable|status|qrlogin|accounts|rm <accountId>]' },
      handler: (inv) => this.handleCommand(inv),
    });

    // Register the outbound media tool so the agent can send generated
    // images/files back to the WeChat peer it is talking to.
    ctx.inject(['tools', 'attachments'], (sctx) => { this._registerSendFileTool(sctx); });

    // One-time rename of the settings.yaml section from the weixin-bridge era
    // so an existing `enabled: true` survives the plugin rename. The settings
    // file provider hot-publishes external edits, so no restart is needed.
    // Registered before installSettingsSection so the renamed section is
    // resolved by the new namespace registration below.
    ctx.inject(['settings'], (sctx) => this._migrateLegacySettingsSection(sctx.settings));

    // Canonical DSH settings wiring: registers the `wechat-bridge` namespace
    // (so writes persist to settings.yaml), uses composition config as base,
    // and re-applies enable/disable live on every settings change.
    this._settingsSource = () => ({
      enabled: this.config.enabled,
      mediaEnabled: this.config.mediaEnabled,
      defaultProvider: this.config.defaultProvider || '',
      defaultModel: this.config.defaultModel || '',
    });
    installSettingsSection(ctx, SETTINGS_NS, SETTINGS_SCHEMA, {
      enabled: this.config.enabled,
      mediaEnabled: this.config.mediaEnabled,
      defaultProvider: this.config.defaultProvider || '',
      defaultModel: this.config.defaultModel || '',
    }, {
      setSource: (current) => { this._settingsSource = current; },
      onChange: () => this._applySettings(),
    });

    this.ctx.logger?.info?.('[wechat-bridge] service mounted (hot-plug via /wechat or settings wechat-bridge.enabled)');

    // Optional wiring: when a webServer exists (web profile), serve the
    // settings-tab JSON API under /wechat-bridge/*.
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => sctx.webServer.register({
        kind: 'prefix',
        path: '/wechat-bridge',
        handler: (req, res) => this.httpHandler(req, res),
      }), 'wechat-bridge: http api route');
    });
  }

  /** Default session cwd: <DSH_HOME>/wechat-bridge/WeChatSpace. */
  workspaceDir() {
    return path.join(
      process.env.DSH_HOME || path.join(process.env.HOME, '.dsh'),
      'wechat-bridge', 'WeChatSpace',
    );
  }

  _applySettings() {
    const s = this._settingsSource();
    this.setEnabled(!!s?.enabled);
  }

  /**
   * Rename a legacy `weixin-bridge:` section in the settings document to
   * `wechat-bridge:` once, so the enabled flag survives the plugin rename.
   * Best-effort: any failure just logs and leaves the section untouched.
   */
  _migrateLegacySettingsSection(settings) {
    const docPath = settings?.documentPath;
    if (!docPath) return;
    try {
      const text = fs.readFileSync(docPath, 'utf8');
      if (!/^weixin-bridge:/m.test(text)) return;
      if (/^wechat-bridge:/m.test(text)) return; // already migrated
      const migrated = text.replace(/^weixin-bridge:/m, 'wechat-bridge:');
      fs.writeFileSync(docPath, migrated, 'utf8');
      this.ctx.logger?.info?.('[wechat-bridge] migrated legacy settings section weixin-bridge -> wechat-bridge');
    } catch (err) {
      this.ctx.logger?.warn?.(`[wechat-bridge] settings section migration skipped: ${err.message}`);
    }
  }

  // ── hot plug ──
  setEnabled(enabled) {
    if (enabled && !this.running) this.start();
    else if (!enabled && this.running) this.stop();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const controller = new AbortController();
    this._stop = controller;
    this._loop(controller.signal);
    this.ctx.logger?.info?.('[wechat-bridge] started');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this._stop?.abort();
    this._stop = null;
    void this._releasePollLock();
    this.ctx.logger?.info?.('[wechat-bridge] stopped');
  }

  async _loop(signal) {
    while (this.running && !signal.aborted) {
      if (!this._pollLockHeld) {
        if (await this._acquirePollLock()) {
          this.ctx.logger?.info?.('[wechat-bridge] poll lock acquired');
        } else {
          await sleep(5_000, signal);
          continue;
        }
      }
      const accounts = this.store.listAccounts().filter((a) => a.enabled === 1 && a.token);
      if (accounts.length === 0) {
        await sleep(5_000, signal);
        continue;
      }
      // Run each account poll concurrently; wait for all, then re-loop.
      await Promise.all(accounts.map((acc) => this._pollAccount(acc, signal)));
      if (!this.running) break;
      await sleep(500, signal);
    }
  }

  /**
   * Atomically create the poll lock (O_EXCL) recording pid + heartbeat
   * timestamp. An existing lock belongs to a live, fresh holder and blocks
   * this process from polling; a stale lock (dead pid or heartbeat older than
   * the long-poll window) is taken over.
   */
  async _acquirePollLock() {
    try {
      const fh = await fsp.open(this._pollLockPath, 'wx');
      await fh.writeFile(JSON.stringify({ pid: process.pid, ts: Date.now() }));
      await fh.close();
      this._pollLockHeld = true;
      this._startPollLockHeartbeat();
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        this.ctx.logger?.warn?.(`[wechat-bridge] poll lock unavailable: ${err.message}`);
        return false;
      }
    }
    try {
      const data = JSON.parse(await fsp.readFile(this._pollLockPath, 'utf8'));
      const staleByTs = Date.now() - (data.ts || 0) > 120_000;
      let holderAlive = true;
      try { process.kill(data.pid, 0); } catch { holderAlive = false; }
      if (staleByTs || !holderAlive) {
        await fsp.unlink(this._pollLockPath).catch(() => {});
        return this._acquirePollLock();
      }
    } catch {
      // Unparsable lock: treat as stale and retry once.
      await fsp.unlink(this._pollLockPath).catch(() => {});
      return this._acquirePollLock();
    }
    return false;
  }

  /**
   * Background heartbeat: a single WeChat message can drive the agent for
   * minutes, during which the poll loop never ticks, so the lock timestamp
   * must be refreshed by its own timer to avoid a false "stale" takeover.
   */
  _startPollLockHeartbeat() {
    if (this._pollLockTimer) return;
    this._pollLockTimer = setInterval(() => {
      if (!this._pollLockHeld) return;
      fsp.writeFile(this._pollLockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }))
        .catch(() => { this._pollLockHeld = false; });
    }, 30_000);
    if (this._pollLockTimer.unref) this._pollLockTimer.unref();
  }

  /** Drop the lock when this process stops polling or disposes. */
  async _releasePollLock() {
    if (this._pollLockTimer) {
      clearInterval(this._pollLockTimer);
      this._pollLockTimer = null;
    }
    if (!this._pollLockHeld) return;
    this._pollLockHeld = false;
    try { await fsp.unlink(this._pollLockPath); } catch { /* already gone */ }
  }

  async _pollAccount(account, signal) {
    const accountId = account.account_id;
    const creds = {
      botToken: account.token,
      ilinkBotId: account.account_id,
      baseUrl: account.base_url || 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: account.cdn_base_url || 'https://novac2c.cdn.weixin.qq.com/c2c',
    };
    const offsetKey = `wechat:${accountId}`;
    let failures = 0;
    const BACKOFF_BASE = 2_000;
    const BACKOFF_MAX = 30_000;

    while (this.running && !signal.aborted) {
      // session-expired pause (errcode -14)
      const paused = this._pauses.get(accountId);
      if (paused && Date.now() < paused) {
        await sleep(10_000, signal);
        continue;
      } else if (paused) {
        this._pauses.delete(accountId);
      }

      try {
        const buf = this.store.getOffset(offsetKey);
        const resp = await getUpdates(creds, buf === '0' ? '' : buf);

        if (resp.errcode === ERRCODE_SESSION_EXPIRED) {
          this._pauses.set(accountId, Date.now() + 60 * 60 * 1000);
          this.ctx.logger?.warn?.(`[wechat-bridge] account ${accountId} session expired, pausing 60m`);
          continue;
        }
        if (resp.errcode && resp.errcode !== 0) {
          throw new Error(`API error: ${resp.errcode} ${resp.errmsg || ''}`);
        }

        if (resp.msgs && resp.msgs.length > 0) {
          for (const msg of resp.msgs) {
            await this._handleInbound(account, creds, msg);
          }
          if (resp.get_updates_buf) this.store.setOffset(offsetKey, resp.get_updates_buf);
        }
        failures = 0;
      } catch (err) {
        if (signal.aborted) break;
        failures += 1;
        const backoff = Math.min(BACKOFF_BASE * 2 ** (failures - 1), BACKOFF_MAX);
        this.ctx.logger?.error?.(`[wechat-bridge] poll error ${accountId}: ${err.message}`);
        await sleep(backoff, signal);
      }
    }
  }

  async _handleInbound(account, creds, msg) {
    if (!msg.from_user_id) return;
    const accountId = account.account_id;
    const peer = msg.from_user_id;
    const chatId = encodeWeixinChatId(accountId, peer);

    // Dedupe: the WeChat long-poll can re-deliver a batch when the process
    // dies before the offset is persisted, and a second DSH process polls the
    // same account during dual-process windows. The stable message id (or the
    // server seq as fallback) makes each message at-most-once.
    const messageId = msg.message_id || String(msg.seq || '');
    if (this.store.wasMessageProcessed(accountId, messageId)) {
      this.ctx.logger?.info?.(`[wechat-bridge] skipping duplicate message ${messageId} from ${peer}`);
      if (msg.context_token) this.store.upsertContextToken(accountId, peer, msg.context_token);
      return;
    }
    this.store.recordProcessedMessage(accountId, messageId);

    if (msg.context_token) this.store.upsertContextToken(accountId, peer, msg.context_token);

    let text = '';
    for (const item of msg.item_list || []) {
      if (item.type === 1 && item.text_item?.text) text += item.text_item.text;
    }
    if (msg.ref_message) {
      const parts = [];
      if (msg.ref_message.title) parts.push(msg.ref_message.title);
      if (msg.ref_message.content) parts.push(msg.ref_message.content);
      if (parts.length) text = `[引用: ${parts.join(' | ')}]\n${text}`;
    }
    text = text.trim();

    // Media items (image / file / video / voice): download, decrypt, and park
    // them in the inbox directory. Images are also offered as native image
    // content when the selected model declares image input.
    const mediaEnabled = this._settingsSource()?.mediaEnabled !== false;
    const content = [];
    if (text) content.push({ type: 'text', text });
    if (mediaEnabled) {
      const mediaBlocks = await this._collectInboundMedia(account, creds, msg, chatId);
      content.push(...mediaBlocks);
    }
    if (content.length === 0) return;

    try {
      const reply = await this._driveAgent(chatId, content);
      const contextToken = this.store.getContextToken(accountId, peer);
      if (!contextToken) {
        this.ctx.logger?.warn?.(`[wechat-bridge] no context_token for ${peer}; cannot reply`);
        return;
      }
      const plain = stripMarkup(reply);
      const limit = 4096;
      const chunks = chunkText(plain, limit);
      const effective = chunks.length > 5
        ? [...chunks.slice(0, 4), chunks.slice(4).join('\n').slice(0, limit - 30) + '\n\n[... response truncated]']
        : chunks;
      for (const c of effective) {
        await sendTextMessage(creds, peer, c, contextToken);
      }
    } catch (err) {
      this.ctx.logger?.error?.(`[wechat-bridge] agent drive failed: ${err.message}`);
      try {
        const contextToken = this.store.getContextToken(accountId, peer);
        if (contextToken) await sendTextMessage(creds, peer, `⚠️ 处理失败: ${err.message}`.slice(0, 4000), contextToken);
      } catch { /* ignore */ }
    }
  }

  /** Directory where inbound media files are parked for the agent to read. */
  mediaInboxDir() {
    return path.join(this.workspaceDir(), 'inbox', localDateKey());
  }

  /** Whether the model selected for bridged sessions declares image input. */
  async _modelAcceptsImages() {
    try {
      const llm = this.ctx.get('llm');
      if (!llm?.listModels) return false;
      const defaultModel = this.ctx.get('agentDefaultModel');
      const current = this._settingsSource();
      const provider = current?.defaultProvider || defaultModel?.currentSelection?.()?.provider;
      const model = current?.defaultModel || defaultModel?.currentSelection?.()?.model;
      if (!provider || !model) return false;
      const info = (await llm.listModels(provider)).find((m) => m.id === model);
      return info?.inputModalities?.includes('image') === true;
    } catch {
      return false;
    }
  }

  /**
   * Download and decrypt every media item of one inbound message. Files are
   * parked under the inbox directory and described to the agent by path; an
   * image is additionally attached as native image content when the selected
   * model declares image input and the attachment store is available.
   */
  async _collectInboundMedia(account, creds, msg, chatId) {
    const blocks = [];
    const attachments = this.ctx.get('attachments');
    const acceptsImages = attachments && await this._modelAcceptsImages();
    for (const item of msg.item_list || []) {
      if (![2, 3, 4, 5].includes(item.type)) continue;
      let media;
      try {
        media = await downloadMediaFromItem(item, creds.cdnBaseUrl);
      } catch (err) {
        this.ctx.logger?.warn?.(`[wechat-bridge] media download failed: ${err.message}`);
        continue;
      }
      if (!media) continue;

      const inbox = this.mediaInboxDir();
      try {
        await fsp.mkdir(inbox, { recursive: true });
        const name = `${Date.now()}-${media.fileName || `media-${item.type}.bin`}`;
        const target = path.join(inbox, name);
        await fsp.writeFile(target, media.data);
        const note = `[微信${media.kind === 'image' ? '图片' : media.kind === 'file' ? '文件' : media.kind === 'video' ? '视频' : '语音'}已保存: ${target}]`;
        blocks.push({ type: 'text', text: note });

        if (media.kind === 'image' && acceptsImages) {
          try {
            const ref = await attachments.saveImage({
              data: new Uint8Array(media.data),
              mediaType: 'image/jpeg',
              name: media.fileName || 'wechat-image',
            });
            blocks.push({ type: 'image', attachment: ref });
          } catch (err) {
            this.ctx.logger?.warn?.(`[wechat-bridge] image attach failed: ${err.message}`);
          }
        }
      } catch (err) {
        this.ctx.logger?.warn?.(`[wechat-bridge] media park failed: ${err.message}`);
      }
    }
    return blocks;
  }

  // Drive one DSH agent session per peer per local calendar day. Messages for
  // the same chat are serialized through a per-chat promise chain: two inbound
  // messages must never drive the same session concurrently (concurrent writers
  // were the seq-gap corruption trigger of the 2026-08-15 incident).
  _driveAgent(chatId, content) {
    const prev = this._driveQueues.get(chatId) ?? Promise.resolve();
    const run = prev.then(
      () => this._driveAgentOnce(chatId, content),
      () => this._driveAgentOnce(chatId, content),
    );
    this._driveQueues.set(chatId, run);
    return run.finally(() => {
      if (this._driveQueues.get(chatId) === run) this._driveQueues.delete(chatId);
    });
  }

  async _driveAgentOnce(chatId, content) {
    const agents = this.ctx.get('agents');
    const sessions = this.ctx.get('sessions');
    const defaultModel = this.ctx.get('agentDefaultModel');
    if (!agents || !sessions) throw new Error('agents/sessions service unavailable');

    const current = this._settingsSource();
    const provider = current?.defaultProvider || defaultModel?.currentSelection?.()?.provider;
    const model = current?.defaultModel || defaultModel?.currentSelection?.()?.model;
    const selection = provider && model ? { provider, model } : defaultModel?.currentSelection?.();
    // Sessions live under <DSH_HOME>/wechat-bridge/WeChatSpace by default, not
    // the process cwd (~), so wechat conversations don't scatter sessions into
    // the home project directory. The directory is created on demand.
    const cwd = this.config.defaultCwd || this.workspaceDir();

    // One session per peer per local calendar day (this machine's timezone).
    // The date suffix rotates the session id at local midnight; a day without
    // conversation never materializes a session because creation stays lazy
    // (this code only runs on the first inbound text of the day).
    const dayKey = localDateKey();
    const sessionId = `wechat-${chatId}-${dayKey}`;
    const title = dayKey;
    // AgentSetup must return void or { commit() } — installModelSelection
    // returns a plain disposer function, so wrap it (headless pattern).
    const setup = (ac) => {
      installModelSelection(ac, { current: selection, assembled: undefined });
    };
    const agentOptions = { provider: selection?.provider, model: selection?.model };

    // Reuse the live agent when it is still registered; otherwise resume the
    // persisted session; otherwise create fresh (and attach to the workspace
    // so it shows up in the sidebar). create/resume return an AgentHandle
    // ({ agent, dispose }); agents.get() returns a bare Agent.
    let agent = agents.get(sessionId);
    let created = false;
    if (!agent) {
      try {
        agent = (await agents.resume({ resumeSessionId: sessionId, agentOptions, setup })).agent;
      } catch {
        try {
          agent = (await agents.create({ sessionId, meta: { cwd }, agentOptions, setup })).agent;
          created = true;
        } catch (createErr) {
          // A corrupt log blocks both resume (validation failure) and create
          // ("already exists"). Quarantine the artifact once, then recreate so
          // the rest of the day is usable instead of failing every message.
          if (String(createErr?.message || '').includes('already exists')) {
            if (await this._quarantineCorruptSession(sessionId)) {
              agent = (await agents.create({ sessionId, meta: { cwd }, agentOptions, setup })).agent;
              created = true;
            } else {
              throw createErr;
            }
          } else {
            throw createErr;
          }
        }
      }
    }
    if (created) {
      await this._attachToWorkspace(sessionId, cwd);
      // Pin the human-readable title "<date>" with the user source so
      // automatic title generation is superseded and never overwrites it.
      try {
        agent.session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } });
      } catch (err) {
        this.ctx.logger?.warn?.(`[wechat-bridge] title append failed for ${sessionId}: ${err.message}`);
      }
    }
    await agent.whenIdle();
    const firstSeq = agent.session.seq;
    agent.followup(createUserMessage({ content, source: { kind: 'user' } }));
    await agent.whenIdle();
    await sessions.flush(agent.session);

    let out = '';
    for (const ev of agent.session.events) {
      if (ev.seq < firstSeq) continue;
      if (ev.type === 'assistant/message') {
        const joined = ev.data?.message?.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') || '';
        if (joined) out = joined;
      }
    }
    return out || '(空回复)';
  }

  /**
   * Rename the persisted log of a corrupt session aside (`.corrupt-<ts>`)
   * using the persistence service's own locate(), so the raw bytes survive
   * for forensics while the session id becomes creatable again.
   * @returns true when the artifact was quarantined.
   */
  async _quarantineCorruptSession(sessionId) {
    try {
      const persistence = this.ctx.get('sessionPersistence');
      if (!persistence?.list || !persistence?.locate) return false;
      for (const header of await persistence.list()) {
        if (header.id !== sessionId) continue;
        const loc = persistence.locate(header);
        if (loc?.kind !== 'jsonl' || !loc.path) continue;
        const target = `${loc.path}.corrupt-${Date.now()}`;
        await fsp.rename(loc.path, target);
        this.ctx.logger?.warn?.(`[wechat-bridge] quarantined corrupt session log: ${loc.path} -> ${target}`);
        return true;
      }
      return false;
    } catch (err) {
      this.ctx.logger?.warn?.(`[wechat-bridge] quarantine attempt failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Register the `wechat_send_file` tool: the agent uploads a local image,
   * video, or file to the WeChat CDN and sends it to the peer of the session
   * it is driving. The peer is resolved from the session id
   * (`wechat-<chatId>-<dayKey>`), so no recipient argument is needed.
   */
  _registerSendFileTool(sctx) {
    try {
      const tools = sctx.tools;
      if (!tools?.register) return;
      tools.register(defineTool({
        name: 'wechat_send_file',
        description: 'Send a local file to the WeChat user of the current conversation. Uploads the file to the WeChat CDN and delivers it as an image, video, or file attachment (routed by file extension). Use it after generating an image, chart, report, or any artifact the WeChat user asked for.',
        parameters: {
          filePath: {
            type: 'string',
            required: true,
            description: 'Absolute path to the local file to send.',
          },
          caption: {
            type: 'string',
            description: 'Optional text caption sent as a separate message before the media.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              kind: { type: 'string' },
            },
          },
          render: (args, value) => [{
            type: 'text',
            text: value.ok
              ? `已发送${value.kind === 'image' ? '图片' : value.kind === 'video' ? '视频' : '文件'}到微信: ${args.filePath}`
              : '发送失败',
          }],
        },
        async execute(args, exec) {
          const sessionId = exec.agent?.session?.id;
          if (!sessionId) throw new Error('wechat_send_file has no calling agent session');
          return this._sendFileToPeer(sessionId, args.filePath, args.caption);
        },
      }));
    } catch (err) {
      this.ctx.logger?.warn?.(`[wechat-bridge] send-file tool registration failed: ${err.message}`);
    }
  }

  /** Resolve `{ accountId, peer }` from a wechat session id, if it is one. */
  _peerFromSessionId(sessionId) {
    const m = /^wechat-(.+)-\d{4}-\d{2}-\d{2}$/.exec(sessionId);
    if (!m) return null;
    const decoded = decodeWeixinChatId(m[1]);
    if (!decoded) return null;
    return decoded;
  }

  /** Upload one local file and deliver it to the WeChat peer of a session. */
  async _sendFileToPeer(sessionId, filePath, caption) {
    const ext = path.extname(filePath).toLowerCase();
    let kind = 'file';
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) kind = 'image';
    else if (['.mp4', '.mov', '.m4v'].includes(ext)) kind = 'video';

    const peerInfo = this._peerFromSessionId(sessionId);
    if (!peerInfo) throw new Error(`cannot resolve WeChat peer from session "${sessionId}"`);
    const { accountId, peerUserId } = peerInfo;

    const account = this.store.getAccount(accountId);
    if (!account?.token) throw new Error(`no stored account for ${accountId}`);
    const creds = {
      botToken: account.token,
      ilinkBotId: account.account_id,
      baseUrl: account.base_url || 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: account.cdn_base_url || 'https://novac2c.cdn.weixin.qq.com/c2c',
    };
    const contextToken = this.store.getContextToken(accountId, peerUserId);
    if (!contextToken) throw new Error(`no context_token for ${peerUserId}; cannot send`);

    const data = await fsp.readFile(filePath);
    if (data.length === 0) throw new Error(`file is empty: ${filePath}`);
    if (data.length > 100 * 1024 * 1024) throw new Error(`file exceeds 100MB: ${filePath}`);

    const uploaded = await uploadMediaToCdn(creds, getUploadUrl, data, peerUserId, kind);

    // Build the outbound media item per the ilink protocol.
    const media = {
      encrypt_query_param: uploaded.encryptQueryParam,
      aes_key: uploaded.aesKeyBase64,
      encrypt_type: 1,
    };
    let item;
    if (kind === 'image') {
      item = { type: 2, image_item: { media, mid_size: uploaded.fileSizeCiphertext } };
    } else if (kind === 'video') {
      item = { type: 5, video_item: { media, video_size: uploaded.fileSizeCiphertext } };
    } else {
      item = {
        type: 4,
        file_item: {
          media,
          file_name: path.basename(filePath),
          len: String(uploaded.fileSize),
        },
      };
    }

    if (caption) {
      await sendTextMessage(creds, peerUserId, String(caption).slice(0, 4000), contextToken);
    }
    await sendMessage(creds, peerUserId, [item], contextToken);
    return { ok: true, kind };
  }

  // ── workspace attachment (sidebar visibility) ──

  /** Attach a session to the workspace whose path equals its cwd (best-effort). */
  async _attachToWorkspace(sessionId, cwd) {
    try {
      const registry = this.ctx.get('workspaceRegistry');
      if (!registry) return;
      let ws = await registry.resolveByPath(cwd);
      if (!ws) ws = await registry.create(cwd);
      await ws.attachSession(sessionId);
    } catch (err) {
      // Non-fatal: the session still works; it just may not show in the sidebar.
      this.ctx.logger?.warn?.(`[wechat-bridge] workspace attach failed: ${err.message}`);
    }
  }

  // ── QR login (shared by /wechat command and settings-tab HTTP API) ──

  /** Start a QR login session; returns sessionId plus a scannable PNG data URL. */
  async startQrLogin() {
    const resp = await startLoginQr();
    if (!resp.qrcode || !resp.qrcode_img_content) throw new Error('failed to get QR from WeChat (bot_type=3 ilink account required)');
    const sessionId = `qr_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    this._loginSessions.set(sessionId, { qrcode: resp.qrcode, status: 'waiting', startedAt: Date.now() });
    // CodePilot renders a QR of the qrcode_img_content URL server-side.
    const qrImage = await QRCode.toDataURL(resp.qrcode_img_content, { width: 256, margin: 2 });
    return { sessionId, qrImage };
  }

  /** Poll one QR session; on confirmed, persists the account and enables the bridge. */
  async pollQrStatus(sessionId) {
    const s = this._loginSessions.get(sessionId);
    if (!s) throw new Error('unknown sessionId');
    const r = await pollLoginQrStatus(s.qrcode);
    s.status = r.status || s.status;
    if (r.status === 'confirmed' && r.bot_token && r.ilink_bot_id) {
      const accountId = r.ilink_bot_id.replace(/[@.]/g, '-');
      this.store.upsertAccount({
        accountId,
        userId: r.ilink_user_id || '',
        baseUrl: r.baseurl || 'https://ilinkai.weixin.qq.com',
        cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
        token: r.bot_token,
        name: accountId,
        enabled: true,
      });
      this._loginSessions.delete(sessionId);
      this.setEnabled(true);
      return { status: 'confirmed', accountId };
    }
    return { status: s.status };
  }

  /**
   * Enumerate selectable provider/model options from the live `llm` service:
   * registered provider routes plus each provider's adapter-discovered models.
   * The settings UI renders these as dropdown options (no free-text input).
   */
  async _modelOptions() {
    const llm = this.ctx.get('llm');
    if (!llm?.listProviders) return { providers: [] };
    const providers = [];
    for (const info of llm.listProviders()) {
      const models = [];
      if (typeof llm.listModels === 'function') {
        try {
          for (const m of await llm.listModels(info.id) || []) {
            models.push({ id: m.id, name: m.name || m.id });
          }
        } catch (err) {
          this.ctx.logger?.warn?.(`[wechat-bridge] model list failed for ${info.id}: ${err.message}`);
        }
      }
      providers.push({ id: info.id, name: info.name || info.id, models });
    }
    return { providers };
  }

  // ── HTTP API for the settings tab ──

  async httpHandler(req, res) {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const readBody = () => new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    });
    try {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname.replace(/^\/wechat-bridge\/?/, '');
      if (req.method === 'GET' && path === 'status') {
        const current = this._settingsSource();
        return send(200, {
          running: this.running,
          defaultProvider: current?.defaultProvider || '',
          defaultModel: current?.defaultModel || '',
          accounts: this.store.listAccounts().map((a) => ({
            accountId: a.account_id,
            name: a.name,
            enabled: a.enabled === 1,
            hasToken: !!a.token,
            lastLoginAt: a.last_login_at,
          })),
        });
      }
      if (req.method === 'GET' && path === 'model-options') {
        return send(200, await this._modelOptions());
      }
      if (req.method === 'POST' && path === 'config') {
        const body = await readBody();
        const settings = this.ctx.get('settings');
        if (!settings) return send(500, { error: 'settings service unavailable' });
        const patch = {};
        if (typeof body.defaultProvider === 'string') patch.defaultProvider = body.defaultProvider;
        if (typeof body.defaultModel === 'string') patch.defaultModel = body.defaultModel;
        if (Object.keys(patch).length === 0) return send(400, { error: 'no fields to update' });
        await settings.update(SETTINGS_NS, patch);
        return send(200, { ok: true, ...this._settingsSource() });
      }
      if (req.method === 'POST' && path === 'enable') { await this._persistEnabled(true); this.setEnabled(true); return send(200, { ok: true }); }
      if (req.method === 'POST' && path === 'disable') { await this._persistEnabled(false); this.setEnabled(false); return send(200, { ok: true }); }
      if (req.method === 'POST' && path === 'qrlogin') {
        const r = await this.startQrLogin();
        return send(200, { ok: true, ...r });
      }
      if (req.method === 'POST' && path === 'qrstatus') {
        const body = await readBody();
        const r = await this.pollQrStatus(body.sessionId || '');
        return send(200, { ok: true, ...r });
      }
      if (req.method === 'POST' && path === 'remove') {
        const body = await readBody();
        this.store.deleteAccount(body.accountId || '');
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && path === 'selftest') {
        const body = await readBody();
        const text = String(body.text || 'ping').slice(0, 2000);
        const chatId = String(body.chatId || `selftest::${Date.now()}`).slice(0, 200);
        const reply = await this._driveAgent(chatId, [{ type: 'text', text }]);
        return send(200, { ok: true, reply: reply.slice(0, 4000) });
      }
      if (req.method === 'POST' && path === 'refresh') {
        // Restart workers so account-list changes take effect immediately.
        if (this.running) { this.stop(); this.start(); }
        return send(200, { ok: true });
      }
      return send(404, { error: 'unknown endpoint' });
    } catch (err) {
      return send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── slash command ──
  async _persistEnabled(val) {
    const settings = this.ctx.get('settings');
    try {
      await settings?.update(SETTINGS_NS, { enabled: val });
    } catch (err) {
      this.ctx.logger?.warn?.(`[wechat-bridge] settings persist failed: ${err.message}`);
    }
  }

  async handleCommand(inv) {
    const arg = (inv.input?.trim?.() || '').trim();
    const [cmd, ...rest] = arg.split(/\s+/);

    switch (cmd) {
      case 'enable': {
        await this._persistEnabled(true);
        this.setEnabled(true);
        return { kind: 'success', text: 'WeChat bridge enabled.' };
      }
      case 'disable': {
        await this._persistEnabled(false);
        this.setEnabled(false);
        return { kind: 'success', text: 'WeChat bridge disabled.' };
      }
      case 'status':
        return { kind: 'success', text: `running=${this.running}, accounts=${this.store.listAccounts().length}` };
      case 'accounts':
        return { kind: 'success', text: this.store.listAccounts().map((a) => `${a.account_id} enabled=${a.enabled} hasToken=${!!a.token}`).join('\n') || '(none)' };
      case 'rm':
        if (!rest[0]) return { kind: 'error', text: 'usage: /wechat rm <accountId>' };
        this.store.deleteAccount(rest[0]);
        return { kind: 'success', text: `account ${rest[0]} removed` };
      case 'qrlogin': {
        try {
          const { sessionId, qrImage } = await this.startQrLogin();
          return { kind: 'success', text: `QR login started. sessionId=${sessionId}\n(poll status with /wechat qrstatus ${sessionId}, or use the Settings UI tab)` };
        } catch (e) {
          return { kind: 'error', text: `qrlogin failed: ${e.message}` };
        }
      }
      case 'qrstatus': {
        try {
          const r = await this.pollQrStatus(rest[0] || '');
          return { kind: 'success', text: r.status === 'confirmed' ? `login confirmed, account ${r.accountId} saved & bridge enabled` : `status=${r.status}` };
        } catch (e) {
          return { kind: 'error', text: `qrstatus failed: ${e.message}` };
        }
      }
      default:
        return { kind: 'success', text: 'usage: /wechat [enable|disable|status|accounts|qrlogin|qrstatus <sid>|rm <accountId>]' };
    }
  }
}

export { name };
