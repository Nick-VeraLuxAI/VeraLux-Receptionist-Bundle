const test = require("node:test");
const assert = require("node:assert/strict");
const { redactControlPlaneLogValue } = require("../dist/observability/redaction.js");

test("redacts tokens, phone, email, stream url", () => {
  const input = {
    authorization: "Bearer supersecrettokenvalue123456789",
    phone: "+15551234567",
    email: "owner@example.com",
    stream: "wss://example.com/stream/token/abcdef",
  };
  const out = redactControlPlaneLogValue(input);
  assert.equal(out.authorization, "[REDACTED]");
  assert.equal(out.phone, "[REDACTED_PHONE]");
  assert.equal(out.email, "[REDACTED_EMAIL]");
  assert.equal(out.stream, "[REDACTED_STREAM_URL]");
});
