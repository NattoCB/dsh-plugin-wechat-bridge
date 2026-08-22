// One-way session turn-end notifications (no LLM, fixed template).
//
// Every top-level DSH session's completed turn produces a short WeChat ping:
//
//   【会话通知：<session name ≤15 chars>（<session id first 6>）】
//   <turn response ≤200 chars>
//
// The helpers here are pure functions over the session event log so they can
// be unit-tested without a live DSH context. Sending lives in index.js.

export const NAME_PREFIX_LIMIT = 15;
export const RESPONSE_PREFIX_LIMIT = 200;
export const SESSION_ID_PREFIX_CHARS = 6;
const ELLIPSIS = '...';

/**
 * Strip the common Markdown decorations down to plain text — WeChat renders
 * nothing fancy. Shared with the reply path in index.js.
 */
export function stripMarkup(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/`{3}[\s\S]*?`{3}/g, (m) => m.replace(/`{3}\w*\n?/g, '').replace(/`{3}/g, ''))
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

/**
 * Flatten any whitespace (newlines included) to single spaces and strip
 * control characters — a notification must stay one compact line per row.
 */
export function flattenText(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First `limit` characters; appends "..." only when actually truncated. */
export function prefixWithEllipsis(text, limit) {
  const flat = flattenText(text);
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit) + ELLIPSIS;
}

/**
 * The turn's response text: the LAST non-empty assistant text message that
 * belongs to `turn` (same selection rule as the reply path in index.js).
 * Intermediate step texts are superseded by the final answer.
 */
export function extractTurnResponse(events, turn) {
  let out = '';
  for (const ev of events || []) {
    if (ev?.type !== 'assistant/message') continue;
    if (ev.data?.turn !== turn) continue;
    const blocks = ev.data?.message?.content || [];
    const joined = blocks
      .filter((b) => b?.type === 'text')
      .map((b) => b.text || '')
      .join('');
    if (joined.trim()) out = joined;
  }
  return out;
}

/**
 * Fixed-template fallback when a turn produced no assistant text at all
 * (aborted before the first word, failed request, blocked on approval…).
 * `reason` is the `turn/end` payload's reason field.
 */
export function turnEndFallbackText(reason) {
  switch (reason?.kind) {
    case 'error':
      return `⚠️ 回合失败: ${flattenText(reason.error?.message || '未知错误').slice(0, RESPONSE_PREFIX_LIMIT)}`;
    case 'aborted':
      return '(回合被中断，无文本回复)';
    case 'blocked':
      return '(回合受阻，无文本回复)';
    default:
      return '(本轮无文本回复)';
  }
}

/**
 * WeChat-facing text for a drive whose final turn ended in an error and
 * produced no assistant message — the actual failure (e.g. the upstream
 * auth error) instead of a generic "(空回复)". `selection` names the
 * provider/model that was pinned for the call so the operator can tell
 * WHICH route failed. Truncated to one WeChat chunk.
 */
export function formatTurnErrorReply(reason, selection) {
  const rawError = reason?.error;
  const detail = flattenText(String(rawError?.message || (typeof rawError === 'string' ? rawError : '') || '未知错误')).slice(0, RESPONSE_PREFIX_LIMIT);
  const provider = selection?.provider || '';
  const model = selection?.model || '';
  const label = [provider, model].filter(Boolean).join('/');
  return `⚠️ 模型调用失败${label ? `（${label}）` : ''}：${detail}`.slice(0, 4000);
}

/**
 * Session display name for the notification header: the latest logged
 * `session/title`, else the first real user prompt (source.kind === "user"),
 * else a fixed fallback. Mirrors how dsh-session-title folds titles.
 */
export function deriveSessionName(events, fallback = '未命名会话') {
  const list = events || [];
  const titleEvent = list.findLast?.((ev) => ev?.type === 'session/title');
  if (titleEvent?.data?.title) return String(titleEvent.data.title);
  for (const ev of list) {
    if (ev?.type !== 'user/message') continue;
    if (ev.data?.source?.kind !== 'user') continue;
    const blocks = ev.data?.content || [];
    const text = blocks
      .filter((b) => b?.type === 'text')
      .map((b) => b.text || '')
      .join('\n')
      .trim();
    if (text) return text.split('\n')[0];
  }
  return fallback;
}

/**
 * Whether a session kind should produce one-way notifications at all.
 * Skipped:
 *  - the bridge's OWN daily sessions (`wechat-…`): the peer already receives
 *    those replies directly, and echoing them would both duplicate messages
 *    and risk a notify→reply→notify loop (mutual non-pollution rule);
 *  - subagent children (`header.origin === "subagent"` or any positive
 *    delegation depth): one main turn can fan out to many child turns.
 * Reload artifacts (`interrupted` crash-orphan closers) are skipped by the
 * caller via the turn reason, not here.
 */
export function shouldNotifySession(sessionId, header) {
  if (!sessionId) return false;
  if (String(sessionId).startsWith('wechat-')) return false;
  if (header?.origin === 'subagent') return false;
  if ((header?.delegationDepth ?? 0) > 0) return false;
  return true;
}

/**
 * Short disambiguating badge for a session id. Naively slicing the first
 * chars of ids like `session-abcdef12-…` renders the constant prefix
 * ("sessio") which carries zero information; strip a known `session-` /
 * `wechat-` prefix first so the badge shows the distinctive part.
 */
export function sessionIdBadge(sessionId, limit = SESSION_ID_PREFIX_CHARS) {
  const raw = String(sessionId || '');
  if (!raw) return '';
  const stripped = raw.replace(/^(session|wechat)[-_]/i, '');
  if (!stripped) return raw;
  return stripped.slice(0, limit);
}

/**
 * Build the complete two-line notification text for one finished turn.
 * Pure: takes everything it needs as arguments.
 */
export function formatTurnNotification({ events, turn, reason, sessionId }) {
  const raw = extractTurnResponse(events, turn) || turnEndFallbackText(reason);
  const response = stripMarkup(raw);
  const name = stripMarkup(deriveSessionName(events));
  const header = `【会话通知：${prefixWithEllipsis(name, NAME_PREFIX_LIMIT)}（${sessionIdBadge(sessionId)}）】`;
  return `${header}\n${prefixWithEllipsis(response, RESPONSE_PREFIX_LIMIT)}`;
}
