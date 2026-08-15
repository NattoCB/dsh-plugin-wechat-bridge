// WeChat ilink bot HTTP protocol client.
// Ported from CodePilot src/lib/bridge/adapters/weixin/weixin-api.ts.
// Pure protocol layer: no business logic or state.
import crypto from 'node:crypto';

const CHANNEL_VERSION = 'dsh-wechat-bridge/0.1';
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
const QR_LOGIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
const QR_LOGIN_TIMEOUT_MS = 40_000;

function generateWechatUin() {
  return crypto.randomBytes(4).toString('base64');
}

function buildHeaders(creds, routeTag) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${creds.botToken}`,
    'X-WECHAT-UIN': generateWechatUin(),
  };
  if (routeTag) headers['SKRouteTag'] = routeTag;
  return headers;
}

async function weixinRequest(creds, endpoint, body, timeoutMs = API_TIMEOUT_MS, routeTag) {
  const baseUrl = creds.baseUrl || 'https://ilinkai.weixin.qq.com';
  const url = `${baseUrl}/ilink/bot/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(creds, routeTag),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`WeChat API error: ${res.status} ${res.statusText}`);
  const rawText = await res.text();
  if (!rawText.trim()) return {};
  try {
    return JSON.parse(rawText);
  } catch (err) {
    throw new Error(`WeChat API returned non-JSON body for ${endpoint}: ${err.message}`);
  }
}

export async function getUpdates(creds, getUpdatesBuf, timeoutMs = LONG_POLL_TIMEOUT_MS) {
  try {
    return await weixinRequest(
      creds,
      'getupdates',
      { get_updates_buf: getUpdatesBuf ?? '', base_info: { channel_version: CHANNEL_VERSION } },
      timeoutMs + 5_000,
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

function generateClientId() {
  return `dsh-wx-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

export async function sendMessage(creds, toUserId, items, contextToken) {
  const clientId = generateClientId();
  await weixinRequest(creds, 'sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: items.length > 0 ? items : undefined,
      context_token: contextToken || undefined,
    },
    base_info: { channel_version: CHANNEL_VERSION },
  });
  return { clientId };
}

export async function sendTextMessage(creds, toUserId, text, contextToken) {
  return sendMessage(creds, toUserId, [{ type: 1, text_item: { text } }], contextToken);
}

export async function getUploadUrl(creds, fileKey, fileType, fileSize, fileMd5, cipherFileSize) {
  return weixinRequest(creds, 'getuploadurl', {
    file_key: fileKey,
    file_type: fileType,
    file_size: fileSize,
    file_md5: fileMd5,
    cipher_file_size: cipherFileSize,
  });
}

export async function getConfig(creds, ilinkUserId, contextToken) {
  return weixinRequest(
    creds,
    'getconfig',
    { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: { channel_version: CHANNEL_VERSION } },
    CONFIG_TIMEOUT_MS,
  );
}

export async function sendTyping(creds, ilinkUserId, typingTicket, typingStatus) {
  try {
    await weixinRequest(
      creds,
      'sendtyping',
      { ilink_user_id: ilinkUserId, typing_ticket: typingTicket, status: typingStatus, base_info: { channel_version: CHANNEL_VERSION } },
      CONFIG_TIMEOUT_MS,
    );
  } catch {
    /* best-effort */
  }
}

export async function startLoginQr() {
  const url = `${QR_LOGIN_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`QR login start failed: ${res.status}`);
  return res.json();
}

export async function pollLoginQrStatus(qrcode) {
  const url = `${QR_LOGIN_BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(QR_LOGIN_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`QR status poll failed: ${res.status}`);
  return res.json();
}
