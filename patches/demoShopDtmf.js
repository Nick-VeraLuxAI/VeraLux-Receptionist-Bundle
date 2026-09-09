"use strict";
/**
 * VERA_DEMO_SHOP_DTMF_20260907
 * Spoken 10-digit OR ten keypad digits — first complete 10 wins.
 * Never stitch spoken fragments with keypad digits.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ingestDemoShopDtmfDigit = ingestDemoShopDtmfDigit;

function ingestDemoShopDtmfDigit(state, rawDigit) {
    const prevBuffer = String((state && state.buffer) || "");
    const prevPhone = state && state.phone ? String(state.phone) : null;
    const alreadyHasPhone = !!(state && state.alreadyHasPhone) || !!(prevPhone && prevPhone.length === 10);
    const ch = String(rawDigit || "").trim();
    if (ch === "*") {
        return { buffer: "", phone: null, action: "clear" };
    }
    if (alreadyHasPhone && prevPhone) {
        return { buffer: prevPhone, phone: prevPhone, action: "ignore" };
    }
    if (ch === "#") {
        if (prevBuffer.length === 10) {
            return { buffer: prevBuffer, phone: prevBuffer, action: "complete" };
        }
        return { buffer: prevBuffer, phone: null, action: "ignore" };
    }
    if (!/^[0-9]$/.test(ch)) {
        return { buffer: prevBuffer, phone: prevPhone, action: "ignore" };
    }
    let buffer = prevBuffer + ch;
    if (buffer.length > 10)
        buffer = buffer.slice(0, 10);
    if (buffer.length === 10) {
        return { buffer, phone: buffer, action: "complete" };
    }
    return { buffer, phone: null, action: "digit" };
}
