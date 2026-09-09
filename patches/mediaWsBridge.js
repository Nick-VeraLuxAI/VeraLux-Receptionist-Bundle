"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bindMediaWsBridge = bindMediaWsBridge;
exports.sendMediaWsJson = sendMediaWsJson;
exports.waitForMediaWs = waitForMediaWs;
let sendFn = null;
let waitFn = null;
function bindMediaWsBridge(send, wait) {
    sendFn = send;
    waitFn = wait;
}
function sendMediaWsJson(callControlId, json) {
    return sendFn?.(callControlId, json) ?? false;
}
async function waitForMediaWs(callControlId, timeoutMs) {
    if (!waitFn)
        return false;
    return waitFn(callControlId, timeoutMs);
}
//# sourceMappingURL=mediaWsBridge.js.map