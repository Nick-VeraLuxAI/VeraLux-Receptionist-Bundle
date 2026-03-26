"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractFirstJsonObject,
  stripMarkdownJsonFence,
} = require("../dist/utils/jsonObjectExtract.js");
const { parseReceptionistLlmOutput } = require("../dist/receptionistLlmParse.js");
const { isCallOutcome, isStage } = require("../dist/runTypes.js");

test("extractFirstJsonObject respects braces inside JSON strings", () => {
  const s = `Here: {"replyText": "use {curly} please", "nested": {"a": 1}}`;
  const j = extractFirstJsonObject(s);
  assert.ok(j);
  const o = JSON.parse(j);
  assert.equal(o.replyText, "use {curly} please");
  assert.equal(o.nested.a, 1);
});

test("extractFirstJsonObject picks first object when two exist", () => {
  const s = '{"a":1} trailing {"b":2}';
  const j = extractFirstJsonObject(s);
  assert.deepEqual(JSON.parse(j), { a: 1 });
});

test("stripMarkdownJsonFence unwraps json fence", () => {
  const inner = stripMarkdownJsonFence('```json\n{"x":1}\n```');
  assert.equal(inner, '{"x":1}');
});

test("parseReceptionistLlmOutput drops unknown lead keys and invalid outcomes", () => {
  const raw = `\`\`\`json
{"replyText":"Hi","leadUpdates":{"name":"Pat","injection":true,"evil":"x"},"outcome":"not-real","actions":["end-call","nope"]}
\`\`\``;
  const p = parseReceptionistLlmOutput(raw);
  assert.equal(p.replyText, "Hi");
  assert.equal(p.leadUpdates?.name, "Pat");
  assert.equal(p.leadUpdates?.evil, undefined);
  assert.equal(p.leadUpdates?.injection, undefined);
  assert.equal(p.outcome, undefined);
  assert.ok(p.actions.includes("end-call"));
  assert.equal(p.actions.includes("nope"), false);
});

test("isCallOutcome and isStage", () => {
  assert.equal(isCallOutcome("new-lead"), true);
  assert.equal(isCallOutcome("bogus"), false);
  assert.equal(isStage("scheduling"), true);
  assert.equal(isStage("foo"), false);
});
