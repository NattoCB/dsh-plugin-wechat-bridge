// Minimal JSON-file persistence for the WeChat bridge.
// Replaces CodePilot's SQLite weixin_accounts / weixin_context_tokens /
// channel_offsets tables with a single atomic JSON document, so the plugin is
// self-contained (no DB dependency). Thread/process-safe enough for one DSH
// process: all mutations go through load -> mutate -> save.
import fs from 'node:fs';
import path from 'node:path';

function defaultData() {
  return { accounts: [], contextTokens: {}, offsets: {}, processed: {} };
}

const LEGACY_DIR_NAME = 'weixin-bridge';
const CURRENT_DIR_NAME = 'wechat-bridge';

export class Store {
  constructor(dataDir) {
    const home = process.env.DSH_HOME || path.join(process.env.HOME, '.dsh');
    this.dir = dataDir || path.join(home, CURRENT_DIR_NAME);
    // One-time migration from the weixin-bridge era: move the data directory
    // as a whole so accounts, tokens, and poll offsets survive the rename.
    if (!dataDir) this._migrateLegacyDir(home);
    this.file = path.join(this.dir, 'state.json');
    this._cache = null;
  }

  _migrateLegacyDir(home) {
    const legacy = path.join(home, LEGACY_DIR_NAME);
    try {
      if (fs.existsSync(legacy) && !fs.existsSync(this.dir)) {
        fs.renameSync(legacy, this.dir);
      }
    } catch {
      // Non-fatal: the bridge just starts with an empty store.
    }
  }

  _ensure() {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, JSON.stringify(defaultData(), null, 2));
    }
  }

  _load() {
    if (this._cache) return this._cache;
    this._ensure();
    try {
      this._cache = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this._cache = defaultData();
    }
    if (!this._cache.accounts) this._cache.accounts = [];
    if (!this._cache.contextTokens) this._cache.contextTokens = {};
    if (!this._cache.offsets) this._cache.offsets = {};
    if (!this._cache.processed) this._cache.processed = {};
    this._migrateOffsetKeys();
    return this._cache;
  }

  // One-time migration of poll-offset keys from the `weixin:` prefix to
  // `wechat:`; losing them would re-deliver every historical message.
  _migrateOffsetKeys() {
    const d = this._cache;
    let changed = false;
    for (const key of Object.keys(d.offsets)) {
      if (key.startsWith('weixin:')) {
        const next = `wechat:${key.slice('weixin:'.length)}`;
        if (!(next in d.offsets)) d.offsets[next] = d.offsets[key];
        delete d.offsets[key];
        changed = true;
      }
    }
    if (changed) this._save();
  }

  _save() {
    this._ensure();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._cache, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // ── accounts ──
  listAccounts() {
    return this._load().accounts;
  }
  getAccount(accountId) {
    return this._load().accounts.find((a) => a.account_id === accountId);
  }
  upsertAccount(params) {
    const d = this._load();
    const now = new Date().toISOString().replace('T', ' ').split('.')[0];
    const idx = d.accounts.findIndex((a) => a.account_id === params.accountId);
    const row = {
      account_id: params.accountId,
      user_id: params.userId || '',
      base_url: params.baseUrl || '',
      cdn_base_url: params.cdnBaseUrl || '',
      token: params.token || '',
      name: params.name || params.accountId,
      enabled: params.enabled !== false ? 1 : 0,
      last_login_at: now,
      created_at: idx >= 0 ? d.accounts[idx].created_at : now,
      updated_at: now,
    };
    if (idx >= 0) d.accounts[idx] = row;
    else d.accounts.push(row);
    this._save();
    return row;
  }
  setAccountEnabled(accountId, enabled) {
    const d = this._load();
    const a = d.accounts.find((x) => x.account_id === accountId);
    if (!a) return false;
    a.enabled = enabled ? 1 : 0;
    a.updated_at = new Date().toISOString().replace('T', ' ').split('.')[0];
    this._save();
    return true;
  }
  deleteAccount(accountId) {
    const d = this._load();
    d.accounts = d.accounts.filter((a) => a.account_id !== accountId);
    delete d.contextTokens[accountId];
    delete d.offsets[`wechat:${accountId}`];
    delete d.offsets[`weixin:${accountId}`];
    this._save();
  }

  // ── context tokens ──
  getContextToken(accountId, peerUserId) {
    return this._load().contextTokens[accountId]?.[peerUserId];
  }
  upsertContextToken(accountId, peerUserId, token) {
    const d = this._load();
    if (!d.contextTokens[accountId]) d.contextTokens[accountId] = {};
    d.contextTokens[accountId][peerUserId] = token;
    this._save();
  }
  deleteContextTokensByAccount(accountId) {
    const d = this._load();
    delete d.contextTokens[accountId];
    this._save();
  }
  /**
   * Deduplicated peer ids holding a context token across all accounts —
   * the people who have messaged the bot at least once. The Settings tab
   * lists these as clickable chips: internal peer ids are opaque and only
   * become known through an actual conversation.
   */
  listKnownPeers() {
    const d = this._load();
    const out = [];
    for (const peers of Object.values(d.contextTokens || {})) {
      for (const peer of Object.keys(peers || {})) {
        if (!out.includes(peer)) out.push(peer);
      }
    }
    return out;
  }

  // ── poll offsets ──
  getOffset(key) {
    return this._load().offsets[key] ?? '0';
  }
  setOffset(key, value) {
    const d = this._load();
    d.offsets[key] = value;
    this._save();
  }

  // ── inbound-message dedupe ──
  // Records the last N processed message ids per account so a re-delivered
  // batch (poll crash, offset rollback, or a second DSH process) cannot
  // drive the same WeChat message twice. Kept bounded; entries older than
  // 24h are pruned on access.

  /** Whether `messageId` for `accountId` was already processed. */
  wasMessageProcessed(accountId, messageId) {
    if (!messageId) return false;
    const d = this._load();
    return d.processed[`${accountId}:${messageId}`] !== undefined;
  }

  /** Mark `messageId` for `accountId` processed; prunes stale entries. */
  recordProcessedMessage(accountId, messageId) {
    if (!messageId) return;
    const d = this._load();
    const now = Date.now();
    for (const key of Object.keys(d.processed)) {
      if (now - d.processed[key] > 24 * 60 * 60 * 1000) delete d.processed[key];
    }
    const keys = Object.keys(d.processed);
    if (keys.length >= 500) {
      // Bounded: drop the oldest half before adding one more.
      keys.sort((a, b) => d.processed[a] - d.processed[b]);
      for (const key of keys.slice(0, 250)) delete d.processed[key];
    }
    d.processed[`${accountId}:${messageId}`] = now;
    this._save();
  }
}
