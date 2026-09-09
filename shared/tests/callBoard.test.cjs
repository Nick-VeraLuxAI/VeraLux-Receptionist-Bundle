const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applySpeakPolicy,
  bookingMissingFields,
  buildDemoShopTalkerBoard,
  classifyDeskIntent,
  clockContextFromDate,
  extractCallerName,
  extractIntakeSlots,
  extractPhone,
  formatConfirmDateFromIso,
  greetingWithCallerName,
  isBusinessHoursBleed,
  isIncompleteContact,
  matchTransferProfile,
  normalizeIntakeProfile,
  parseAmPmHour,
  ingestDtmfDigit,
  planReceptionistTurn,
  resolveSpokenStart,
  rewriteWeekdayOnlyConfirm,
  speakClaimsBooked,
} = require("../dist/callBoard.js");

const ctx = clockContextFromDate(new Date("2026-09-05T18:14:00.000Z"), -7);
const EXPECTED_TUE_1230 = "2026-09-08T12:30:00-07:00";
const BAD_HOURS_BLEED = "2026-09-07T09:00:00-07:00";

test("demo profile defaults from tenant id", () => {
  assert.equal(normalizeIntakeProfile(null, "demo-shop").kind, "demo");
  assert.equal(normalizeIntakeProfile(null, "demo-shop").writer, "gcal");
  assert.equal(normalizeIntakeProfile(null, "acme-plumbing").kind, "trades");
  assert.equal(normalizeIntakeProfile(null, "acme-plumbing").writer, "fsm");
});

test("user clock wins and hours bleed is rejected", () => {
  const got = resolveSpokenStart("this coming Tuesday at 1230 PM", ctx, "user");
  assert.equal(got && got.start, EXPECTED_TUE_1230);
  assert.notEqual(got && got.start, BAD_HOURS_BLEED);
  const { hour, minute } = parseAmPmHour("12", "30", "PM");
  assert.equal(hour, 12);
  assert.equal(minute, 30);
  const bleedSample = "We are open Monday through Friday 9 AM to 5 PM.";
  const bleedRe =
    /\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:[^\d]{0,48}?)(?:at\s+)?(\d{1,2})(?:[:.](\d{2})|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)/i;
  const bm = bleedRe.exec(bleedSample);
  assert.ok(bm);
  assert.equal(isBusinessHoursBleed(bleedSample, bm.index, bm.index + bm[0].length), true);
  const noon = resolveSpokenStart("Tuesday at noon", ctx, "user");
  assert.equal(noon && noon.start, "2026-09-08T12:00:00-07:00");
});

test("date confirm is concrete month+day", () => {
  assert.equal(
    formatConfirmDateFromIso("2026-09-08T14:00:00-07:00"),
    "Tuesday, September 8th at 2 PM",
  );
  const after = rewriteWeekdayOnlyConfirm(
    "Perfect — you're booked for Tuesday at 2 PM.",
    "2026-09-08T14:00:00-07:00",
  );
  assert.match(after, /Tuesday, September 8th at 2 PM/);
});

test("name and phone extractors match Demo Shop truth", () => {
  assert.equal(extractCallerName("My name is Nick."), "Nick");
  assert.equal(extractCallerName("I'm hoping to book a demo."), undefined);
  assert.equal(extractCallerName("can we use Nick De Santis and September 8th at 1230 p.m."), "Nick De Santis");
  assert.equal(extractPhone("can we use Nick De Santis and September 8th at 1230 p.m. 2086251175"), "2086251175");
  assert.equal(extractPhone("Ooh, can we use DeSantis on September 8th at 1230 p.m.?"), undefined);
  assert.equal(isIncompleteContact("208-621-175"), true);
});

test("board does not ask email after phone and blocks booked-before-write", () => {
  const phoneBoard = buildDemoShopTalkerBoard({
    name: "DeSantis",
    start: EXPECTED_TUE_1230,
    startSpeak: "Tuesday, September 8th at 12:30 PM",
    phone: "208-625-1175",
    writable: true,
    posted: false,
  });
  assert.equal(phoneBoard.missing.length, 0);
  assert.match(phoneBoard.next, /Board is complete/);
  assert.equal(/^Ask /i.test(phoneBoard.next), false);

  const spoken = applySpeakPolicy({
    replyText: "I've booked you for Tuesday at 12:30 PM.",
    posted: false,
    writable: true,
  });
  assert.match(spoken, /write that down/i);
  assert.equal(speakClaimsBooked(spoken), false);
});

test("demo booking missing does not require a service address", () => {
  const missing = bookingMissingFields(
    { kind: "demo", writer: "gcal" },
    { name: "Nick", phone: "2086251175", start: EXPECTED_TUE_1230 },
  );
  assert.deepEqual(missing, []);
  const trades = bookingMissingFields(
    { kind: "trades", writer: "fsm" },
    { name: "Nick", phone: "2086251175" },
    "+15095550100",
  );
  assert.ok(trades.includes("service address"));
  assert.ok(trades.includes("service type"));
});

test("plan: FAQ skip LLM, transfer-or-message, book collect, shop refuse", () => {
  const faq = planReceptionistTurn({
    utterance: "What are your hours today?",
    history: [{ role: "user", content: "What are your hours today?" }],
    quickReply: "We are open Monday through Friday 9 to 5.",
    tenantId: "demo-shop",
  });
  assert.equal(faq.intent, "faq");
  assert.equal(faq.skipLlm, true);
  assert.match(faq.speak || "", /open Monday/);

  const xferOff = planReceptionistTurn({
    utterance: "Can you transfer me to Nick?",
    history: [{ role: "user", content: "Can you transfer me to Nick?" }],
    transfersAllowed: false,
    callerId: "+15095550100",
    tenantId: "demo-shop",
  });
  assert.equal(xferOff.intent, "message");
  assert.match(xferOff.speak || "", /take a message/i);

  const xferOn = planReceptionistTurn({
    utterance: "Connect me to billing",
    history: [{ role: "user", content: "Connect me to billing" }],
    transfersAllowed: true,
    transferProfiles: [
      { id: "billing", name: "Billing", destination: "+15095550999", responsibilities: ["billing"] },
    ],
    tenantId: "acme",
  });
  assert.equal(xferOn.transferTo, "+15095550999");

  const collect = planReceptionistTurn({
    utterance: "I'd like to book a demo",
    history: [{ role: "user", content: "I'd like to book a demo" }],
    tenantId: "demo-shop",
    now: new Date("2026-09-05T18:14:00.000Z"),
  });
  assert.equal(collect.skipLlm, true);
  assert.equal(collect.writeBook, false);
  assert.match(collect.speak || "", /name/i);

  const faqOpen = planReceptionistTurn({
    utterance: "What are your hours today?",
    history: [{ role: "user", content: "What are your hours today?" }],
    tenantId: "demo-shop",
  });
  assert.equal(faqOpen.intent, "faq");
  assert.equal(faqOpen.skipLlm, false);

  const quoteHold = planReceptionistTurn({
    utterance: "How much for a water heater?",
    history: [{ role: "user", content: "How much for a water heater?" }],
    tenantId: "acme",
  });
  assert.equal(quoteHold.intent, "quote");
  assert.equal(quoteHold.skipLlm, true);
  assert.match(quoteHold.speak || "", /hold it for the owner/i);

  const quoteList = planReceptionistTurn({
    utterance: "How much for a water heater?",
    history: [{ role: "user", content: "How much for a water heater?" }],
    tenantId: "acme",
    pricingItems: [{ name: "water heater", price: "1895" }],
  });
  assert.match(quoteList.speak || "", /1,895|1895/);

  const complete = extractIntakeSlots({
    history: [
      { role: "user", content: "My name is Nick. Tuesday at 12:30 PM 2086251175" },
    ],
    profile: { kind: "demo", writer: "gcal" },
    tenantId: "demo-shop",
    now: new Date("2026-09-05T18:14:00.000Z"),
  });
  assert.equal(complete.writable, true);
  assert.equal(complete.start, EXPECTED_TUE_1230);

  const refuse = planReceptionistTurn({
    utterance: "Please book service at 00000",
    history: [{ role: "user", content: "Please book service at 00000" }],
    playbook: { serviceArea: { zips: ["99201"], cities: [] } },
    tenantId: "acme",
  });
  assert.equal(refuse.shop.decision, "refuse");
  assert.equal(refuse.skipLlm, true);
});

test("intent classifier and greeting personalization", () => {
  assert.equal(classifyDeskIntent("I smell gas"), "emergency");
  assert.equal(classifyDeskIntent("How much for a water heater?"), "quote");
  assert.equal(classifyDeskIntent("Where is my technician?"), "status");
  assert.match(greetingWithCallerName("Hi! Thanks for calling. How can I help you today?", "Nick De Santis"), /^Hi Nick!/);
  const hit = matchTransferProfile("talk to sales", [
    { id: "sales", name: "Sales", destination: "+15551112222", responsibilities: ["new jobs"] },
  ]);
  assert.equal(hit && hit.destination, "+15551112222");
});

test("DTMF ingest completes on the tenth digit and ignores extras", () => {
  let state = { buffer: "", phone: null };
  for (const digit of "208625117") {
    state = ingestDtmfDigit(state, digit);
    assert.equal(state.phone, null);
  }
  state = ingestDtmfDigit(state, "5");
  assert.equal(state.phone, "2086251175");
  assert.equal(ingestDtmfDigit(state, "9").action, "ignore");
  assert.equal(ingestDtmfDigit(state, "*").action, "clear");
});
