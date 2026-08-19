// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWeixinChatId, decodeWeixinChatId, isWeixinChatId } from "../src/weixin-ids.js";

test("encodeWeixinChatId composes the weixin:: prefix format", () => {
	assert.equal(encodeWeixinChatId("acct-1", "peer-9"), "weixin::acct-1::peer-9");
});

test("decodeWeixinChatId splits accountId and peerUserId", () => {
	assert.deepEqual(decodeWeixinChatId("weixin::acct-1::peer-9"), { accountId: "acct-1", peerUserId: "peer-9" });
});

test("decodeWeixinChatId rejects malformed ids", () => {
	assert.equal(decodeWeixinChatId(""), null);
	assert.equal(decodeWeixinChatId("acct-1::peer-9"), null);
	assert.equal(decodeWeixinChatId("weixin::acct-1"), null);
	assert.equal(decodeWeixinChatId("weixin::::"), null);
	assert.equal(decodeWeixinChatId("weixin::"), null);
	assert.equal(decodeWeixinChatId(undefined), null);
});

test("isWeixinChatId accepts encoded ids only", () => {
	assert.equal(isWeixinChatId("weixin::a::b"), true);
	assert.equal(isWeixinChatId("weixin::a::"), false);
	assert.equal(isWeixinChatId("other::a::b"), false);
});
