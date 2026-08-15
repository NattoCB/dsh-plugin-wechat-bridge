// Synthetic chatId encode/decode for WeChat multi-account isolation.
// Format: weixin::<accountId>::<peerUserId>
// Ported from CodePilot src/lib/bridge/adapters/weixin/weixin-ids.ts

const WEIXIN_PREFIX = 'weixin::';
const SEPARATOR = '::';

export function encodeWeixinChatId(accountId, peerUserId) {
  return `${WEIXIN_PREFIX}${accountId}${SEPARATOR}${peerUserId}`;
}

export function decodeWeixinChatId(chatId) {
  if (!chatId || !chatId.startsWith(WEIXIN_PREFIX)) return null;
  const rest = chatId.slice(WEIXIN_PREFIX.length);
  const sepIdx = rest.indexOf(SEPARATOR);
  if (sepIdx < 0) return null;
  const accountId = rest.slice(0, sepIdx);
  const peerUserId = rest.slice(sepIdx + SEPARATOR.length);
  if (!accountId || !peerUserId) return null;
  return { accountId, peerUserId };
}

export function isWeixinChatId(chatId) {
  return chatId.startsWith(WEIXIN_PREFIX) && decodeWeixinChatId(chatId) !== null;
}
