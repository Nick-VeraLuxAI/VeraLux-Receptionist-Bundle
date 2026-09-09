"use strict";
/**
 * VERA_DEMO_SHOP_SLOTCARD_20260907 + VERA_DEMO_SHOP_WRITECONFIRM_20260908
 * Watcher-owned call board. Talker obeys HAVE/MISSING/NEXT.
 * Prefer shared Call Board when the runtime image has it.
 */
Object.defineProperty(exports, "__esModule", { value: true });
try {
    const shared = require("@veralux/shared");
    if (typeof shared.formatTalkerBoard === "function" && typeof shared.buildDemoShopTalkerBoard === "function") {
        exports.formatTalkerBoard = shared.formatTalkerBoard;
        exports.buildDemoShopTalkerBoard = shared.buildDemoShopTalkerBoard;
    }
} catch (_e) {
    /* image without callBoard */
}
if (!exports.formatTalkerBoard) {
    exports.formatTalkerBoard = formatTalkerBoard;
    exports.buildDemoShopTalkerBoard = buildDemoShopTalkerBoard;
}

function formatTalkerBoard(input) {
    const have = input.have && input.have.length
        ? input.have.map((line) => `- ${line}`).join('\n')
        : '- (none yet)';
    const missing = input.missing && input.missing.length
        ? input.missing.map((line) => `- ${line}`).join('\n')
        : '- (none)';
    return [
        'This is the live call board from the watcher. Obey it over conversation history and over any urge to collect extra fields.',
        'HAVE:',
        have,
        'MISSING:',
        missing,
        `NEXT: ${input.next}`,
        'Do not re-ask HAVE. Do not read HAVE back as a list. Ask at most NEXT. Phone or email is one contact slot — if either is HAVE, do not ask for the other.',
    ].join('\n');
}

function buildDemoShopTalkerBoard(input) {
    const have = [];
    const missing = [];
    if (input.start)
        have.push(`time: ${input.startSpeak || input.start}`);
    else
        missing.push('day-and-time (with AM or PM)');
    if (input.name)
        have.push(`name: ${input.name}`);
    else
        missing.push('name');
    if (input.phone)
        have.push(`phone: ${input.phone}`);
    if (input.email)
        have.push(`email: ${input.email}`);
    if (!input.phone && !input.email)
        missing.push('phone-or-email (one is enough)');
    let next;
    if (input.posted) {
        next = 'Calendar write succeeded. Confirm they are booked in one short sentence. Do not re-collect. Do not list fields.';
    }
    else if (input.writable) {
        next = 'Board is complete. Do not ask for email, phone, name, or time. Do not say booked or all set. Brief hold only — the system is writing and will speak the booked confirm when the write finishes.';
    }
    else if (missing.includes('day-and-time (with AM or PM)') && missing.includes('name')) {
        next = 'Ask name and a day/time with AM or PM in one short question.';
    }
    else if (missing[0] === 'day-and-time (with AM or PM)') {
        next = 'Ask what day and time (with AM or PM).';
    }
    else if (missing.includes('name')) {
        next = 'Ask their name.';
    }
    else if (missing.some((item) => item.startsWith('phone-or-email'))) {
        next = 'Ask for a phone number or an email — one, not both. They may say the ten digits or tap them on the keypad.';
    }
    else {
        next = `Ask only: ${missing[0] || 'how you can help'}.`;
    }
    return { have, missing, next };
}
