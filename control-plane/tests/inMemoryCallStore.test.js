const test = require("node:test");
const assert = require("node:assert/strict");
const { InMemoryCallStore } = require("../dist/state.js");

test("countLiveCalls ignores hydrated history and ended rows", () => {
  const store = new InMemoryCallStore("tenant-a", [
    { id: "ended-history", tenantId: "tenant-a", stage: "end", lead: {}, history: [] },
    { id: "hydrated-no-ts", tenantId: "tenant-a", stage: "greeting", lead: {}, history: [] },
  ]);
  assert.equal(store.listCalls().length, 2);
  assert.equal(store.countLiveCalls(), 0);

  store.createCall("caller-1", "live-1");
  assert.equal(store.countLiveCalls(), 1);
  store.dispose();
});

test("createCall aliases a non-uuid Telnyx id onto one postgres row", () => {
  const store = new InMemoryCallStore("tenant-a");
  const call = store.createCall("+15551234567", "v3:not-a-uuid");
  assert.match(call.id, /^[0-9a-f-]{36}$/i);
  assert.equal(call.lead.voiceCallControlId, "v3:not-a-uuid");
  assert.equal(store.getCall("v3:not-a-uuid")?.id, call.id);
  assert.equal(store.listCalls().length, 1);
  store.deleteCall("v3:not-a-uuid");
  assert.equal(store.getCall(call.id), undefined);
  assert.equal(store.listCalls().length, 0);
  store.dispose();
});
