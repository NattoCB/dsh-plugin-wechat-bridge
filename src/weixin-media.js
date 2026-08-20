// WeChat (ilink bot) CDN media codec: AES-128-ECB + PKCS7 download/decrypt and
// encrypt/upload. Protocol details follow the reverse-engineered
// wechat-ilink-client (from Tencent's openclaw-weixin):
//   - download: GET <cdnBaseUrl>/download?encrypted_query_param=<param>
//   - upload:   GET /ilink/bot/getuploadurl {filekey, media_type, to_user_id,
//               rawsize, rawfilemd5, filesize, no_need_thumb, aeskey} ->
//               {upload_param}; then POST <cdnBaseUrl>/upload?encrypted_query_
//               param=<upload_param>&filekey=<filekey>; the response header
//               `x-encrypted-param` is the download param to echo in sendmessage.
import crypto from 'node:crypto';

export const MAX_MEDIA_SIZE = 100 * 1024 * 1024; // 100 MB
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** MessageItemType: image / file / video supported; voice downloads but is not transcribable here. */
const MEDIA_ITEMS = {
  2: { kind: 'image', field: 'image_item' },
  3: { kind: 'voice', field: 'voice_item' },
  4: { kind: 'file', field: 'file_item' },
  5: { kind: 'video', field: 'video_item' },
};

/** UploadMediaType for outbound uploads. */
const UPLOAD_TYPE = { image: 1, video: 2, file: 3, voice: 4 };

/**
 * Parse `CDNMedia.aes_key` (base64) into the raw 16-byte AES key. Two encodings
 * are observed: base64 of the 16 raw key bytes, or base64 of a 32-char hex
 * string that itself decodes to the 16-byte key.
 */
export function parseAesKey(aesKeyBase64) {
  if (!aesKeyBase64) return undefined;
  let decoded;
  try {
    decoded = Buffer.from(aesKeyBase64, 'base64');
  } catch {
    return undefined;
  }
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  return undefined;
}

/** AES-128-ECB decrypt (PKCS7 auto-padding, raw fallback). */
export function decryptAesEcb(cipher, key) {
  for (const autoPadding of [true, false]) {
    try {
      const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
      decipher.setAutoPadding(autoPadding);
      return Buffer.concat([decipher.update(cipher), decipher.final()]);
    } catch { /* try the other padding mode */ }
  }
  throw new Error('failed to decrypt WeChat media (AES-128-ECB)');
}

/** AES-128-ECB encrypt with PKCS7 padding. */
export function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Ciphertext size after AES-128-ECB + PKCS7 (pads to a 16-byte boundary). */
export function aesEcbPaddedSize(plaintextSize) {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function md5Hex(data) {
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Download and decrypt one inbound media item.
 * @returns `{ data, kind, fileName? }` or null when the item has no media.
 */
export async function downloadMediaFromItem(item, cdnBaseUrl = DEFAULT_CDN_BASE_URL) {
  const spec = MEDIA_ITEMS[item.type];
  if (!spec) return null;
  const payload = item[spec.field];
  const media = payload?.media;
  if (!media?.encrypt_query_param) return null;

  const url = `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`WeChat CDN download failed: ${res.status} ${res.statusText}`);
  const encrypted = Buffer.from(await res.arrayBuffer());
  if (encrypted.length > MAX_MEDIA_SIZE) throw new Error(`WeChat media exceeds ${MAX_MEDIA_SIZE} bytes`);

  // Images prefer the hex `aeskey` on the item; every kind falls back to
  // `media.aes_key` (base64), and a missing key means plaintext on the CDN.
  let aesKey;
  if (spec.kind === 'image' && typeof payload.aeskey === 'string' && /^[0-9a-fA-F]{32}$/.test(payload.aeskey)) {
    aesKey = Buffer.from(payload.aeskey, 'hex');
  } else {
    aesKey = parseAesKey(media.aes_key);
  }

  let data;
  if (aesKey) {
    data = decryptAesEcb(encrypted, aesKey);
  } else {
    data = encrypted; // unencrypted CDN object
  }

  const result = { data, kind: spec.kind };
  if (spec.kind === 'file' && payload.file_name) result.fileName = payload.file_name;
  return result;
}

/**
 * Encrypt and upload one outbound media buffer to the WeChat CDN.
 * @param getUploadUrl - the api-layer getuploadurl caller.
 * @param mediaType - 'image' | 'video' | 'file' | 'voice'.
 * @returns the fields sendmessage echoes into the outbound item's `media`.
 */
export async function uploadMediaToCdn(creds, getUploadUrl, data, toUserId, mediaType) {
  const rawsize = data.length;
  const rawfilemd5 = md5Hex(data);
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskey = crypto.randomBytes(16);

  const resp = await getUploadUrl(creds, {
    filekey,
    media_type: UPLOAD_TYPE[mediaType] ?? UPLOAD_TYPE.file,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString('hex'),
  });
  const uploadParam = resp.upload_param;
  if (!uploadParam && !resp.upload_full_url) {
    throw new Error('getuploadurl returned no upload_param nor upload_full_url');
  }

  const cdnBaseUrl = creds.cdnBaseUrl || DEFAULT_CDN_BASE_URL;
  // The server may hand back a complete upload URL (`upload_full_url`) or a
  // bare `upload_param`; both carry the same encrypted upload ticket. Keep
  // the filekey query arg that the classic upload URL carries either way.
  const uploadUrl = resp.upload_full_url
    ? `${resp.upload_full_url}${resp.upload_full_url.includes('?') ? '&' : '?'}filekey=${encodeURIComponent(filekey)}`
    : `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  const ciphertext = encryptAesEcb(data, aeskey);

  let downloadParam;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const put = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: AbortSignal.timeout(180_000),
      });
      if (put.status !== 200) {
        const errMsg = put.headers.get('x-error-message') ?? `status ${put.status}`;
        throw new Error(`WeChat CDN upload failed: ${errMsg}`);
      }
      downloadParam = put.headers.get('x-encrypted-param') ?? undefined;
      if (!downloadParam) throw new Error('CDN upload response missing x-encrypted-param header');
      break;
    } catch (err) {
      lastError = err;
      if (attempt >= 3) break;
    }
  }
  if (!downloadParam) {
    throw lastError instanceof Error ? lastError : new Error('CDN upload failed after 3 attempts');
  }

  return {
    encryptQueryParam: downloadParam,
    aesKeyBase64: aeskey.toString('base64'),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}
