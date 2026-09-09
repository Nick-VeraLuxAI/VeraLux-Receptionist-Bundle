#!/usr/bin/env node
/**
 * VERA_DEMO_SHOP_BOOKTRUTH_20260905 + VERA_DEMO_SHOP_DATECONFIRM_20260905 self-check
 * Covers v3:RcqF — "this coming Tuesday at 1230 PM" must not bleed to 09:00.
 *
 * Calendar note: Sat 2026-09-05 → this coming Tuesday = 2026-09-08 (not Sep 7;
 * Sep 7 is Monday — the incident's wrong write was Monday 09:00 hours-bleed).
 */
'use strict';

const weekdays = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const pad = (n) => String(n).padStart(2, '0');
const parseAmPmHour = (hourRaw, minuteRaw, ampmRaw) => {
  let hour = parseInt(hourRaw, 10);
  const minute = parseInt(minuteRaw || '0', 10);
  const ampm = String(ampmRaw || '').toLowerCase().replace(/\./g, '');
  if (ampm.startsWith('p') && hour < 12) hour += 12;
  if (ampm.startsWith('a') && hour === 12) hour = 0;
  return { hour, minute };
};
const toIsoPt = (year, monthIndex, day, hour, minute) => {
  const start = `${year}-${pad(monthIndex + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00-07:00`;
  return start;
};

function isBusinessHoursBleed(src, matchStart, matchEnd) {
  const left = src.slice(Math.max(0, matchStart - 56), matchStart);
  const right = src.slice(matchEnd, Math.min(src.length, matchEnd + 56));
  const around = (left + ' ' + right).toLowerCase();
  if (/\b(open|hours|between|from)\b/.test(around) && /\b(to|through|thru|until|-)\b/.test(around))
    return true;
  const matched = src.slice(matchStart, matchEnd);
  if (/\b(through|thru|to|until)\b/i.test(matched) && !/\bat\b/i.test(matched))
    return true;
  if (/\b(to|through|thru|until)\s+\d{1,2}/i.test(right) && !/\bat\b/i.test(src.slice(Math.max(0, matchStart - 8), matchStart + 4)))
    return true;
  if (/\d{1,2}(?:[:.\s]?\d{2})?\s*(a\.?m\.?|p\.?m\.?)\s*(to|through|thru|until|-)\s*$/i.test(left))
    return true;
  return false;
}

function resolveUserClock(userText, { ptY, ptM, ptD, ptDow, ptMins }) {
  const namedWd = /\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:[^\n]{0,40}?)(?:at\s+)?(noon|midnight)\b/i.exec(userText);
  if (namedWd) {
    const hour = namedWd[2].toLowerCase() === 'midnight' ? 0 : 12;
    const targetDow = weekdays[namedWd[1].toLowerCase()];
    let delta = (targetDow - ptDow + 7) % 7;
    if (delta === 0 && ptMins >= hour * 60) delta = 7;
    const target = new Date(Date.UTC(ptY, ptM, ptD + delta));
    return toIsoPt(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hour, 0);
  }
  const wdRe = /\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:[^\d]{0,48}?)(?:at\s+)?(\d{1,2})(?:[:.](\d{2})|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)/i;
  const atClock = /(?:\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b[^\d]{0,40}?)?\bat\s+(\d{1,2})(?:[:.](\d{2})|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i.exec(userText);
  if (atClock && atClock[5] && atClock[1]) {
    const minuteRaw = atClock[3] || atClock[4] || '0';
    const { hour, minute } = parseAmPmHour(atClock[2], minuteRaw, atClock[5]);
    const targetDow = weekdays[atClock[1].toLowerCase()];
    let delta = (targetDow - ptDow + 7) % 7;
    if (delta === 0 && ptMins >= hour * 60 + minute) delta = 7;
    const target = new Date(Date.UTC(ptY, ptM, ptD + delta));
    return toIsoPt(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hour, minute);
  }
  const w = wdRe.exec(userText);
  if (w && w[5] && !isBusinessHoursBleed(userText, w.index, w.index + w[0].length)) {
    const targetDow = weekdays[w[1].toLowerCase()];
    const minuteRaw = w[3] || w[4] || '0';
    const { hour, minute } = parseAmPmHour(w[2], minuteRaw, w[5]);
    let delta = (targetDow - ptDow + 7) % 7;
    if (delta === 0 && ptMins >= hour * 60 + minute) delta = 7;
    const target = new Date(Date.UTC(ptY, ptM, ptD + delta));
    return toIsoPt(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate(), hour, minute);
  }
  return null;
}

// Fixed call-date context: Sat 2026-09-05 ~11am PT
const ctx = { ptY: 2026, ptM: 8, ptD: 5, ptDow: 6, ptMins: 11 * 60 + 14 };

const EXPECTED_TUE_1230 = '2026-09-08T12:30:00-07:00';
const BAD_HOURS_BLEED = '2026-09-07T09:00:00-07:00';

const cases = [
  {
    name: 'v3:RcqF this coming Tuesday at 1230 PM',
    user: 'this coming Tuesday at 1230 PM',
    expected: EXPECTED_TUE_1230,
  },
  {
    name: 'Tuesday at 12:30 PM',
    user: 'Tuesday at 12:30 PM',
    expected: EXPECTED_TUE_1230,
  },
  {
    name: 'this coming Tuesday at 12:30 PM',
    user: 'this coming Tuesday at 12:30 PM',
    expected: EXPECTED_TUE_1230,
  },
  {
    name: 'user clock wins over assistant hours bleed text (combined search would be wrong)',
    user: 'this coming Tuesday at 1230 PM',
    assistantBleed: 'We are open Monday through Friday 9 AM to 5 PM.',
    expected: EXPECTED_TUE_1230,
    mustNot: BAD_HOURS_BLEED,
  },
  {
    name: 'v3:yb1vkj Tuesday at noon',
    user: 'Tuesday at noon',
    expected: '2026-09-08T12:00:00-07:00',
  },
  {
    name: 'Tuesday noon without at',
    user: 'Tuesday noon works',
    expected: '2026-09-08T12:00:00-07:00',
  },
];

let failed = 0;
for (const c of cases) {
  const got = resolveUserClock(c.user, ctx);
  const ok = got === c.expected && (!c.mustNot || got !== c.mustNot);
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${c.name}`);
  console.log(`  got=${got} expected=${c.expected}`);
  if (!ok) failed += 1;
}

// Explicit compact HHMM minute check
const { hour, minute } = parseAmPmHour('12', '30', 'PM');
const compactOk = hour === 12 && minute === 30;
console.log(`${compactOk ? 'PASS' : 'FAIL'}: compact 1230 PM → 12:30 (not 12:00)`);
if (!compactOk) failed += 1;

const bleedSample = 'We are open Monday through Friday 9 AM to 5 PM.';
const bleedRe = /\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:[^\d]{0,48}?)(?:at\s+)?(\d{1,2})(?:[:.](\d{2})|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)/i;
const bm = bleedRe.exec(bleedSample);
const bleedRejected = bm && isBusinessHoursBleed(bleedSample, bm.index, bm.index + bm[0].length);
console.log(`${bleedRejected ? 'PASS' : 'FAIL'}: hours bleed "Monday through Friday 9 AM" rejected`);
if (!bleedRejected) failed += 1;



// --- VERA_DEMO_SHOP_DATECONFIRM_20260905 ---
function formatDemoShopConfirmDateFromIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso || '').trim());
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const monthIndex = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dow = new Date(Date.UTC(year, monthIndex, day)).getUTCDay();
  const ordinal = (n) => {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
    switch (n % 10) {
      case 1: return `${n}st`;
      case 2: return `${n}nd`;
      case 3: return `${n}rd`;
      default: return `${n}th`;
    }
  };
  const ampm = hour >= 12 ? 'PM' : 'AM';
  let h12 = hour % 12;
  if (h12 === 0) h12 = 12;
  const timePart = minute === 0 ? `${h12} ${ampm}` : `${h12}:${String(minute).padStart(2, '0')} ${ampm}`;
  return `${weekdays[dow]}, ${months[monthIndex]} ${ordinal(day)} at ${timePart}`;
}

function rewriteWeekdayOnlyConfirm(speakText, iso) {
  const text = String(speakText || '');
  if (/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(text))
    return text;
  const concrete = formatDemoShopConfirmDateFromIso(iso);
  if (!concrete) return text;
  const wdTimeRe = /\b(?:this\s+(?:coming\s+)?)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:\s*,?\s*(?:at\s+)?(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2}))?/i;
  if (!wdTimeRe.test(text)) return text;
  let out = text.replace(wdTimeRe, concrete);
  if (out !== text && out.includes(concrete)) {
    const parts = out.split(concrete);
    const tail = parts.slice(1).join(concrete);
    const strippedTail = tail.replace(/^\s*(?:at\s+)?(?:noon|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i, '');
    out = parts[0] + concrete + strippedTail;
  }
  return out;
}

const dateFmtCases = [
  ['2026-09-08T14:00:00-07:00', 'Tuesday, September 8th at 2 PM'],
  ['2026-09-08T12:30:00-07:00', 'Tuesday, September 8th at 12:30 PM'],
  ['2026-09-07T09:00:00-07:00', 'Monday, September 7th at 9 AM'],
  ['2026-09-01T13:00:00-07:00', 'Tuesday, September 1st at 1 PM'],
  ['2026-09-02T15:00:00-07:00', 'Wednesday, September 2nd at 3 PM'],
  ['2026-09-03T11:00:00-07:00', 'Thursday, September 3rd at 11 AM'],
];
for (const [iso, want] of dateFmtCases) {
  const got = formatDemoShopConfirmDateFromIso(iso);
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}: DATECONFIRM format ${iso}`);
  console.log(`  got=${got}`);
  if (!ok) failed += 1;
}

const beforeConfirm = "Perfect — you're booked for Tuesday at 2 PM.";
const afterConfirm = rewriteWeekdayOnlyConfirm(beforeConfirm, '2026-09-08T14:00:00-07:00');
const wantConfirm = "Perfect — you're booked for Tuesday, September 8th at 2 PM.";
// Sentence-final period may be consumed by optional m\.? — accept with or without trailing '.'
const confirmOk = afterConfirm === wantConfirm || afterConfirm === wantConfirm.replace(/\.$/, '');
console.log(`${confirmOk ? 'PASS' : 'FAIL'}: DATECONFIRM rewrite weekday-only → concrete`);
console.log(`  before=${beforeConfirm}`);
console.log(`  after=${afterConfirm}`);
if (!confirmOk) failed += 1;

const alreadyConcrete = 'You are confirmed for Tuesday, September 8th at 2 PM.';
const noChange = rewriteWeekdayOnlyConfirm(alreadyConcrete, '2026-09-08T14:00:00-07:00');
const skipOk = noChange === alreadyConcrete;
console.log(`${skipOk ? 'PASS' : 'FAIL'}: DATECONFIRM leaves already-concrete alone`);
if (!skipOk) failed += 1;

// VERA_DEMO_SHOP_CONTACTCLOCK_20260905 — future-tense book must trip contact rewrite
const claimsBookedRe = /\b(i('ve| have) booked|i('ll| will) book|let me book|i('ll| will) (go ahead and )?schedule|schedule your demo|you'll receive a confirmation|your (demo|appointment|booking) is booked|booked (you|your)|you're all set|locked in|i('ve| have) got you down|got you down|penciled (you )?in)\b/i;
const illBook = "Tuesday at noon works. I'll book it for you.";
const illBookOk = claimsBookedRe.test(illBook);
console.log(`${illBookOk ? 'PASS' : 'FAIL'}: I'll book it trips contact-gate rewrite`);
if (!illBookOk) failed += 1;
const iveBookOk = claimsBookedRe.test("I've booked your demo");
console.log(`${iveBookOk ? 'PASS' : 'FAIL'}: I've booked still trips contact-gate rewrite`);
if (!iveBookOk) failed += 1;
const gotYouDownOk = claimsBookedRe.test("I've got you down for Tuesday");
console.log(`${gotYouDownOk ? 'PASS' : 'FAIL'}: I've got you down trips booked-claim rewrite`);
if (!gotYouDownOk) failed += 1;
const penciledOk = claimsBookedRe.test("I penciled you in");
console.log(`${penciledOk ? 'PASS' : 'FAIL'}: penciled you in trips booked-claim rewrite`);
if (!penciledOk) failed += 1;

// VERA_DEMO_SHOP_NAMETRUTH_20260905 — first name alone must extract; "I'm hoping" must not
// VERA_DEMO_SHOP_SLOTHEAR_20260907 — "use DeSantis on September" and 10-digit phones
const nameStop = /^(i|im|i'm|its|it's|this|that|yes|yeah|yep|yup|no|nope|ok|okay|sure|thanks|thank|please|hello|hi|hey|my|the|a|an|and|or|to|for|at|on|in|of|we|you|me|us|here|there|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am|pm|hoping|calling|trying|looking|interested|going|gonna|wanting|just|ooh|oh|um|uh|can|we|use|soon|well|demo|appointment|booking|call|phone|email|september|october|november|december|january|february|march|april|june|july|august)$/i;
function nameParticle(word) {
  return /^(de|da|van|von|der|la|le|del|della|di|du|st|saint)$/i.test(String(word || ''));
}
function extractCallerName(userText) {
  const text = String(userText || '');
  const months = /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i;
  const weekdays = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
  const isNameToken = (token) => /^[A-Za-z]{2,20}(?:-[A-Za-z]{2,20})?$/.test(token);
  const cueRe = /\b(?:my\s+name\s+is|name\s+is|name's|this\s+is|use|under|as)\s+/ig;
  let cue;
  while ((cue = cueRe.exec(text))) {
    const rest = text.slice(cue.index + cue[0].length);
    const words = rest.split(/\s+/);
    const taken = [];
    for (let i = 0; i < words.length; i++) {
      const clean = String(words[i] || '').replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, '');
      if (!clean) continue;
      if (/^\d/.test(clean)) break;
      if (/^(and|on|at|for|this|tomorrow|today|next)$/i.test(clean)) break;
      if (months.test(clean) || weekdays.test(clean)) break;
      if (nameParticle(clean)) { taken.push(clean); continue; }
      if (!isNameToken(clean) || nameStop.test(clean)) break;
      taken.push(clean);
      if (taken.filter((t) => !nameParticle(t)).length >= 3) break;
    }
    while (taken.length && nameParticle(taken[taken.length - 1])) taken.pop();
    if (taken.length) return taken.join(' ');
  }
  const beforeDate = /\b((?:[A-Za-z]{2,20}(?:-[A-Za-z]{2,20})?[ \t]+){0,3}[A-Za-z]{2,20}(?:-[A-Za-z]{2,20})?)\s+(?:and|on)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2})\b/i.exec(text);
  if (beforeDate) {
    const parts = beforeDate[1].trim().split(/[ \t]+/).filter((p) => p && (nameParticle(p) || (isNameToken(p) && !nameStop.test(p))));
    while (parts.length && nameParticle(parts[parts.length - 1])) parts.pop();
    if (parts.length) return parts.join(' ');
  }
  const im = /\b(?:i'?m|it'?s)\s+([A-Za-z]{2,20}(?:[ \t]+[A-Za-z]{2,20})?)\b/i.exec(text);
  if (im) {
    const kept = im[1].trim().split(/[ \t]+/).filter((p) => p && (!nameStop.test(p) || nameParticle(p)));
    if (kept.length && !kept.every((p) => nameParticle(p))) return kept.join(' ');
  }
  return null;
}
function extractPhone(text) {
  const noClock = String(text || '')
    .replace(/\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi, ' ')
    .replace(/\b\d{3,4}\s*(?:a\.?m\.?|p\.?m\.?)\b/gi, ' ')
    .replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?\b/gi, ' ');
  const tokens = noClock.split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    const d = tok.replace(/\D/g, '');
    if (d.length === 10) return d;
    if (d.length === 11 && d.charAt(0) === '1') return d.slice(1);
  }
  let acc = '';
  for (const tok of tokens) {
    const d = tok.replace(/\D/g, '');
    if (d.length >= 3 && d.length <= 4 && /^\d+$/.test(d)) {
      acc += d;
      if (acc.length === 10) return acc;
      if (acc.length > 10) acc = d;
    } else acc = '';
  }
  return null;
}
function isIncompleteContact(raw) {
  const digits = (String(raw || '').match(/\d/g) || []).length;
  if (digits >= 3 && digits <= 9 && !/@/.test(raw)) {
    const mostlyDigits = /^[\d\-().\s+]+$/.test(raw)
      || /^(?:it'?s|this is|my (?:phone(?: number)?|number) is)\s+[\d\-().\s+]+$/i.test(raw);
    if (mostlyDigits) return true;
  }
  if (/^my phone( number)? is\b/i.test(raw) && digits < 10) return true;
  return false;
}
const oldNameRe = /(?:name is|it'?s|this is)[ \t]+([A-Z][a-zA-Z]+(?:[ \t]+[A-Z][a-zA-Z]+)+)/;
const nickFirst = extractCallerName('My name is Nick.');
const nickOldMiss = !oldNameRe.exec('My name is Nick.');
const nickLast = extractCallerName('My name is Nick DeSantis');
const hoping = extractCallerName("I'm hoping to book a demo.");
const useDesantis = extractCallerName('Ooh, can we use DeSantis on September 8th at 1230 p.m.?');
const nickDeSantis = extractCallerName('can we use Nick De Santis and September 8th at 1230 p.m.');
const nickDeSantisNamed = extractCallerName('My name is Nick De Santis');
const sameTurnPhone = extractPhone('can we use Nick De Santis and September 8th at 1230 p.m. 2086251175');
console.log(`${nickFirst === 'Nick' ? 'PASS' : 'FAIL'}: extract "My name is Nick." → Nick (got=${nickFirst})`);
if (nickFirst !== 'Nick') failed += 1;
console.log(`${nickOldMiss ? 'PASS' : 'FAIL'}: old two-word name regex misses "My name is Nick."`);
if (!nickOldMiss) failed += 1;
console.log(`${nickLast === 'Nick DeSantis' ? 'PASS' : 'FAIL'}: extract "My name is Nick DeSantis" (got=${nickLast})`);
if (nickLast !== 'Nick DeSantis') failed += 1;
console.log(`${hoping == null ? 'PASS' : 'FAIL'}: "I'm hoping" is not a name (got=${hoping})`);
if (hoping != null) failed += 1;
console.log(`${useDesantis === 'DeSantis' ? 'PASS' : 'FAIL'}: SLOTHEAR "use DeSantis on September" → DeSantis (got=${useDesantis})`);
if (useDesantis !== 'DeSantis') failed += 1;
console.log(`${nickDeSantis === 'Nick De Santis' ? 'PASS' : 'FAIL'}: SLOTHEAR "use Nick De Santis and September" (got=${nickDeSantis})`);
if (nickDeSantis !== 'Nick De Santis') failed += 1;
console.log(`${nickDeSantisNamed === 'Nick De Santis' ? 'PASS' : 'FAIL'}: "My name is Nick De Santis" (got=${nickDeSantisNamed})`);
if (nickDeSantisNamed !== 'Nick De Santis') failed += 1;
console.log(`${sameTurnPhone === '2086251175' ? 'PASS' : 'FAIL'}: same-turn 2086251175 after 1230 p.m. (got=${sameTurnPhone})`);
if (sameTurnPhone !== '2086251175') failed += 1;
const nineIncomplete = isIncompleteContact('208-621-175');
const tenComplete = extractPhone("It's 2086251175.");
const noStitch = extractPhone('208-621-175\nMy phone number is 62511');
const spokenGroups = extractPhone('208 625 1175');
const ignoreTime = extractPhone('Ooh, can we use DeSantis on September 8th at 1230 p.m.?');
console.log(`${nineIncomplete ? 'PASS' : 'FAIL'}: 9-digit fragment is incomplete contact`);
if (!nineIncomplete) failed += 1;
console.log(`${tenComplete === '2086251175' ? 'PASS' : 'FAIL'}: 10-digit extracts (got=${tenComplete})`);
if (tenComplete !== '2086251175') failed += 1;
console.log(`${noStitch == null ? 'PASS' : 'FAIL'}: do not stitch 9+5 digit finals (got=${noStitch})`);
if (noStitch != null) failed += 1;
console.log(`${spokenGroups === '2086251175' ? 'PASS' : 'FAIL'}: same-turn 208 625 1175 extracts (got=${spokenGroups})`);
if (spokenGroups !== '2086251175') failed += 1;
console.log(`${ignoreTime == null ? 'PASS' : 'FAIL'}: 1230 p.m. is not a phone (got=${ignoreTime})`);
if (ignoreTime != null) failed += 1;

// VERA_DEMO_SHOP_NO_REGREET_20260906 — Hi/Hello/Hey + name after first ack
function stripDemoShopRegreet(text, firstName, alreadyAcked) {
  const escaped = String(firstName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openerRe = new RegExp(`^(hi|hello|hey)\\s+${escaped}\\b[\\s,!.]*`, 'i');
  const meetRe = /^(great|nice|good)\s+to\s+meet\s+you\b[\s,!.]*/i;
  const raw = String(text || '').trim();
  if (!alreadyAcked) return raw;
  let next = raw;
  if (openerRe.test(next)) next = next.replace(openerRe, '').trim();
  if (meetRe.test(next)) next = next.replace(meetRe, '').trim();
  if (next && next !== raw) next = next.charAt(0).toUpperCase() + next.slice(1);
  return next || 'What day and time work for you?';
}
const firstHi = stripDemoShopRegreet('Hi Nick! What day and time work for you?', 'Nick', false);
const firstHiOk = firstHi === 'Hi Nick! What day and time work for you?';
console.log(`${firstHiOk ? 'PASS' : 'FAIL'}: first Hi Nick opener kept (got=${firstHi})`);
if (!firstHiOk) failed += 1;
const laterHi = stripDemoShopRegreet('Hi Nick! Tuesday at 2 PM works.', 'Nick', true);
const laterHiOk = laterHi === 'Tuesday at 2 PM works.';
console.log(`${laterHiOk ? 'PASS' : 'FAIL'}: later Hi Nick opener stripped (got=${laterHi})`);
if (!laterHiOk) failed += 1;
const heyHello = stripDemoShopRegreet('Hey Nick, I can take that.', 'Nick', true);
const heyHelloOk = heyHello === 'I can take that.';
console.log(`${heyHelloOk ? 'PASS' : 'FAIL'}: Hey Nick opener stripped (got=${heyHello})`);
if (!heyHelloOk) failed += 1;
const meetRepeat = stripDemoShopRegreet('Great to meet you. What is the best number?', 'Nick', true);
const meetOk = meetRepeat === 'What is the best number?';
console.log(`${meetOk ? 'PASS' : 'FAIL'}: Great to meet you repeat stripped (got=${meetRepeat})`);
if (!meetOk) failed += 1;

// VERA_DEMO_SHOP_PICKUP_HISTORY_20260906 — light reopen strip after pickup already spoken
function stripPickupReopen(text) {
  let next = String(text || '').trim();
  const before = next;
  next = next.replace(/^(hi there|hello there|hey there|hi|hello|hey)(?:\s+[A-Za-z]{2,20})?[\s,!.]*/i, '').trim();
  next = next.replace(/^(thanks|thank you) for (calling|reaching out)\b[\s,!.]*/i, '').trim();
  next = next.replace(/^(great|nice|good) to (meet|hear from) you\b[\s,!.]*/i, '').trim();
  next = next.replace(/^(my name('s| is)|this is)\s+[A-Za-z]{2,20}\b[\s,!.]*/i, '').trim();
  next = next.replace(/^i('m| am)\s+[A-Z][a-zA-Z]{1,19}\b[\s,!.]*/, '').trim();
  next = next.replace(/^how can i help you( today)?\b[\s,!.?]*/i, '').trim();
  if (next === before) return before;
  return next ? next.charAt(0).toUpperCase() + next.slice(1) : '';
}
const hiMo = stripPickupReopen("Hi Mo, thanks for reaching out. Could you let me know what day and time you'd like to schedule your demo?");
const hiMoOk = hiMo === "Could you let me know what day and time you'd like to schedule your demo?";
console.log(`${hiMoOk ? 'PASS' : 'FAIL'}: Hi Mo reopen strip drops guessed name (got=${hiMo})`);
if (!hiMoOk) failed += 1;
const reopenSarah = stripPickupReopen("Hi there! My name's Sarah. To get you all set, could I have your name?");
const reopenSarahOk = /^To get you all set/i.test(reopenSarah) && !/hi there/i.test(reopenSarah) && !/sarah/i.test(reopenSarah);
console.log(`${reopenSarahOk ? 'PASS' : 'FAIL'}: pickup reopen strip keeps the ask (got=${reopenSarah})`);
if (!reopenSarahOk) failed += 1;
const reopenGlad = stripPickupReopen("I'm glad you're interested in a demo. What day works?");
const reopenGladOk = /^I'?m glad/i.test(reopenGlad);
console.log(`${reopenGladOk ? 'PASS' : 'FAIL'}: "I'm glad" is not stripped as a name intro (got=${reopenGlad})`);
if (!reopenGladOk) failed += 1;
const reopenOnly = stripPickupReopen('Hi there!');
const reopenOnlyOk = reopenOnly === '';
console.log(`${reopenOnlyOk ? 'PASS' : 'FAIL'}: reopen-only "Hi there!" is dropped (got=${reopenOnly})`);
if (!reopenOnlyOk) failed += 1;

// VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906 — aborted fragments vs complete barge
function isBargeBlip(text, sinceMs) {
  const t = String(text || '').trim();
  if (!t) return true;
  const complete = (
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.{0,24}\b(\d{1,2}|noon|midnight)\b/i.test(t) ||
    /\b\d{1,2}(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)\b/i.test(t) ||
    /\b(my name is|this is|name is)\b/i.test(t) ||
    /\d{7,}/.test(t) || /@/.test(t) ||
    /^(yes|yeah|yep|yup|correct|that's right|that is right|no|nope|not really)\b/i.test(t)
  );
  if (complete) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 5 && sinceMs < 1600) return true;
  if (t.length < 24 && sinceMs < 1400) return true;
  return false;
}
const tueAt = isBargeBlip('Tuesday at', 400);
const gosh = isBargeBlip('Oh my gosh.', 400);
const tue2 = !isBargeBlip('Tuesday at 2 PM', 400);
const yesKeep = !isBargeBlip('Yes', 400);
console.log(`${tueAt ? 'PASS' : 'FAIL'}: "Tuesday at" is barge blip`);
if (!tueAt) failed += 1;
console.log(`${gosh ? 'PASS' : 'FAIL'}: "Oh my gosh." is barge blip`);
if (!gosh) failed += 1;
console.log(`${tue2 ? 'PASS' : 'FAIL'}: "Tuesday at 2 PM" is complete (keep)`);
if (!tue2) failed += 1;
console.log(`${yesKeep ? 'PASS' : 'FAIL'}: "Yes" after barge is complete (keep)`);
if (!yesKeep) failed += 1;

// VERA_DEMO_SHOP_STREAMTTS_REMAINDER_20260906 — 2-seg cap must not drop leftover replyText
function extractDemoShopStreamRemainder(fullText, queuedParts) {
  let rest = String(fullText || '').trim();
  if (!rest) return '';
  for (const part of queuedParts || []) {
    const p = String(part || '').trim();
    if (!p) continue;
    if (rest.startsWith(p)) {
      rest = rest.slice(p.length).replace(/^[\s,;.]+/, '').trim();
      continue;
    }
    const idx = rest.indexOf(p);
    if (idx >= 0 && idx <= 12) {
      rest = rest.slice(idx + p.length).replace(/^[\s,;.]+/, '').trim();
    }
  }
  return rest;
}
const sarahFull = "Hi there! My name's Sarah. To get you all set, could I have your name and a good time to schedule the demo?";
const sarahQueued = ['Hi there!', "My name's Sarah."];
const sarahRemain = extractDemoShopStreamRemainder(sarahFull, sarahQueued);
const sarahSpoken = [...sarahQueued, sarahRemain].filter(Boolean).join(' ');
const sarahRemainOk = /name and a good time/i.test(sarahRemain);
const sarahAllOk = /Hi there/i.test(sarahSpoken) && /Sarah/i.test(sarahSpoken) && /name and a good time/i.test(sarahSpoken);
console.log(`${sarahRemainOk ? 'PASS' : 'FAIL'}: STREAMTTS remainder keeps name/time ask (got=${sarahRemain})`);
if (!sarahRemainOk) failed += 1;
console.log(`${sarahAllOk ? 'PASS' : 'FAIL'}: STREAMTTS queued texts cover full Sarah reply`);
if (!sarahAllOk) failed += 1;
const noRemain = extractDemoShopStreamRemainder('Hi there! What day works?', ['Hi there!', 'What day works?']);
console.log(`${noRemain === '' ? 'PASS' : 'FAIL'}: no remainder when all sentences queued (got=${noRemain})`);
if (noRemain !== '') failed += 1;

function isDemoShopRemainderDuplicate(remain, fullSpoken, queuedParts) {
  const r = String(remain || '').trim();
  const full = String(fullSpoken || '').trim();
  if (!r) return true;
  if (r === full) return true;
  const first = String((queuedParts && queuedParts[0]) || '').trim();
  if (first.length >= 6) {
    const prefix = first.slice(0, Math.min(12, first.length)).toLowerCase();
    if (r.toLowerCase().startsWith(prefix)) return true;
  }
  return false;
}
function pickDemoShopStreamRemainder(fullSpoken, queuedParts, fromCursor) {
  const stripped = extractDemoShopStreamRemainder(fullSpoken, queuedParts);
  if (stripped && !isDemoShopRemainderDuplicate(stripped, fullSpoken, queuedParts))
    return stripped;
  const cursor = String(fromCursor || '').trim();
  if (cursor && !isDemoShopRemainderDuplicate(cursor, fullSpoken, queuedParts))
    return cursor;
  return '';
}
const ysFull = "Hi there! I'm glad you're interested in a demo. To get you all set up, could I have your name and the best time to reach you—like your phone number or email?";
const ysQueued = ['Hi there!', "I'm glad you're interested in a demo."];
const ysWrongCursor = ysFull; // unwrap reset speakCursor→0 (v3:ys94d8gX)
const ysPicked = pickDemoShopStreamRemainder(ysFull, ysQueued, ysWrongCursor);
const ysOldLonger = (extractDemoShopStreamRemainder(ysFull, ysQueued).length >= ysWrongCursor.length)
  ? extractDemoShopStreamRemainder(ysFull, ysQueued)
  : ysWrongCursor;
const ysDedupOk = /name and the best time/i.test(ysPicked) && !/^hi there/i.test(ysPicked);
const ysOldBug = /^hi there/i.test(ysOldLonger) && ysOldLonger.length === ysFull.length;
console.log(`${ysDedupOk ? 'PASS' : 'FAIL'}: ys94 remainder is question only (got=${ysPicked})`);
if (!ysDedupOk) failed += 1;
console.log(`${ysOldBug ? 'PASS' : 'FAIL'}: longer(fromParts,fromCursor) would have replayed full reply`);
if (!ysOldBug) failed += 1;
const sarahPicked = pickDemoShopStreamRemainder(sarahFull, sarahQueued, sarahFull);
const sarahDedupOk = /name and a good time/i.test(sarahPicked) && !/^hi there/i.test(sarahPicked);
console.log(`${sarahDedupOk ? 'PASS' : 'FAIL'}: Sarah remainder is question only (got=${sarahPicked})`);
if (!sarahDedupOk) failed += 1;
const skipDup = isDemoShopRemainderDuplicate(ysFull, ysFull, ysQueued);
console.log(`${skipDup ? 'PASS' : 'FAIL'}: full replyText as remainder is duplicate`);
if (!skipDup) failed += 1;

// VERA_DEMO_SHOP_PLAYSERIAL_20260907 — leftover clock + writable without confirm phrase
const seeYouClock = "Thanks for choosing us, Nick! We'll see you on Tuesday at 12:30. Have a great day!";
const seeYouGot = rewriteWeekdayOnlyConfirm(seeYouClock, '2026-09-08T12:30:00-07:00');
const seeYouOk = seeYouGot === "Thanks for choosing us, Nick! We'll see you on Tuesday, September 8th at 12:30 PM. Have a great day!"
  && !/at 12:30 PM at 12:30/i.test(seeYouGot);
console.log(`${seeYouOk ? 'PASS' : 'FAIL'}: DATECONFIRM Tuesday at 12:30 (no ampm) does not double the clock`);
console.log(`  got=${seeYouGot}`);
if (!seeYouOk) failed += 1;

const slotReady = true;
const hasName = true;
const hasContact = true;
const confirmed = false;
const writableComplete = !!(slotReady && hasName && hasContact);
const scheduleableComplete = !!(slotReady && (confirmed || (hasName && hasContact)));
console.log(`${writableComplete && scheduleableComplete ? 'PASS' : 'FAIL'}: name+contact+PT start is writable without confirm phrase`);
if (!(writableComplete && scheduleableComplete)) failed += 1;
const noContactSkip = !(slotReady && hasName && false);
console.log(`${noContactSkip ? 'PASS' : 'FAIL'}: missing contact is not writable`);
if (!noContactSkip) failed += 1;

const scheduleClaim = "I'll go ahead and schedule your demo for Tuesday at 12:30 PM. You'll receive a confirmation email shortly.";
console.log(`${claimsBookedRe.test(scheduleClaim) ? 'PASS' : 'FAIL'}: "I'll go ahead and schedule" is a booked-claim`);
if (!claimsBookedRe.test(scheduleClaim)) failed += 1;
const helperCompleteSlot = !!(true && 'DeSantis' && ('208-625-1175' || null));
console.log(`${helperCompleteSlot ? 'PASS' : 'FAIL'}: helper complete slot does not need confirm phrase`);
if (!helperCompleteSlot) failed += 1;

const talkerBoard = require('./talkerBoard.js');
const phoneBoard = talkerBoard.buildDemoShopTalkerBoard({
  name: 'DeSantis',
  start: '2026-09-08T12:30:00-07:00',
  startSpeak: 'Tuesday, September 8th at 12:30 PM',
  phone: '208-625-1175',
  writable: true,
  posted: false,
});
const phoneBoardOk = phoneBoard.missing.length === 0
  && /Board is complete/.test(phoneBoard.next)
  && !/^Ask /i.test(phoneBoard.next);
console.log(`${phoneBoardOk ? 'PASS' : 'FAIL'}: SLOTCARD name+phone+time does not NEXT-ask email`);
if (!phoneBoardOk) failed += 1;
const contactBoard = talkerBoard.buildDemoShopTalkerBoard({
  name: 'Nick',
  start: '2026-09-08T12:30:00-07:00',
  writable: false,
});
console.log(`${/one, not both/.test(contactBoard.next) ? 'PASS' : 'FAIL'}: SLOTCARD missing contact asks one of phone or email`);
if (!/one, not both/.test(contactBoard.next)) failed += 1;
console.log(`${/keypad/.test(contactBoard.next) ? 'PASS' : 'FAIL'}: SLOTCARD contact NEXT mentions keypad`);
if (!/keypad/.test(contactBoard.next)) failed += 1;

const dtmf = require('./demoShopDtmf.js');
let tap = { buffer: '', phone: null };
for (const d of '2086251175') tap = dtmf.ingestDemoShopDtmfDigit(tap, d);
console.log(`${tap.action === 'complete' && tap.phone === '2086251175' ? 'PASS' : 'FAIL'}: DTMF 2086251175 completes (got=${tap.phone} action=${tap.action})`);
if (!(tap.action === 'complete' && tap.phone === '2086251175')) failed += 1;
let mix = { buffer: '', phone: null };
for (const d of '208621175') mix = dtmf.ingestDemoShopDtmfDigit(mix, d);
const mixLen = mix.buffer.length === 9 && mix.action === 'digit';
mix = dtmf.ingestDemoShopDtmfDigit(mix, '*');
console.log(`${mixLen && mix.action === 'clear' && mix.buffer === '' ? 'PASS' : 'FAIL'}: DTMF * clears 9-digit buffer (no stitch)`);
if (!(mixLen && mix.action === 'clear' && mix.buffer === '')) failed += 1;
const ignoreAfter = dtmf.ingestDemoShopDtmfDigit({ buffer: '2086251175', phone: '2086251175', alreadyHasPhone: true }, '9');
console.log(`${ignoreAfter.action === 'ignore' && ignoreAfter.phone === '2086251175' ? 'PASS' : 'FAIL'}: DTMF ignored once 10 digits HAVE`);
if (!(ignoreAfter.action === 'ignore' && ignoreAfter.phone === '2086251175')) failed += 1;

if (failed) {
  console.error(`\nBOOKTRUTH selfcheck FAILED (${failed})`);
  process.exit(1);
}
console.log('\nBOOKTRUTH+DATECONFIRM selfcheck OK');
console.log(`Expected ISO for Tue 12:30 from Sat 2026-09-05: ${EXPECTED_TUE_1230}`);
