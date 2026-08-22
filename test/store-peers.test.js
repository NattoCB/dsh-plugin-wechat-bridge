// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

function tmpStore() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wxb-store-"));
	return new Store(dir);
}

test("listKnownPeers returns deduplicated peer ids holding context tokens", () => {
	const store = tmpStore();
	assert.deepEqual(store.listKnownPeers(), []);
	store.upsertContextToken("acct-1", "peer-A", "tok-1");
	store.upsertContextToken("acct-2", "peer-B", "tok-2");
	store.upsertContextToken("acct-1", "peer-A", "tok-3"); // refresh, not a duplicate entry
	assert.deepEqual(store.listKnownPeers(), ["peer-A", "peer-B"]);
});

test("listKnownPeers stays empty when only offsets/accounts exist", () => {
	const store = tmpStore();
	store.upsertAccount({ accountId: "acct-1", token: "t", enabled: true });
	store.setOffset("wechat:acct-1", "xyz");
	assert.deepEqual(store.listKnownPeers(), []);
});
