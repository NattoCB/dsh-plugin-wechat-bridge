// WeChat ilink bot protocol types.
// Ported from CodePilot's src/lib/bridge/adapters/weixin/weixin-types.ts
// (protocol-only; no runtime dependency on OpenClaw). Self-contained for DSH.

export const MessageType = { NONE: 0, USER: 1, BOT: 2 };
export const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 };
export const TypingStatus = { TYPING: 1, CANCEL: 2 };
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 };

export const ERRCODE_SESSION_EXPIRED = -14;
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

export class CDNMedia {
  constructor(encrypt_query_param, aes_key, encrypt_type) {
    this.encrypt_query_param = encrypt_query_param;
    this.aes_key = aes_key;
    this.encrypt_type = encrypt_type;
  }
}

export const PLATFORM_LIMITS = { weixin: 4096 };
export const WEIXIN_MAX_CHUNKS = 5;
