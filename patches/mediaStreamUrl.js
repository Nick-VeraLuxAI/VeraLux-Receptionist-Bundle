"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMediaStreamUrl = buildMediaStreamUrl;
const env_1 = require("../env");
function buildMediaStreamUrl(callControlId) {
    const trimmedBase = env_1.env.PUBLIC_BASE_URL.replace(/\/$/, '');
    let wsBase = trimmedBase;
    if (trimmedBase.startsWith('https://')) {
        wsBase = `wss://${trimmedBase.slice('https://'.length)}`;
    }
    else if (trimmedBase.startsWith('http://')) {
        wsBase = `ws://${trimmedBase.slice('http://'.length)}`;
    }
    else if (!trimmedBase.startsWith('ws://') && !trimmedBase.startsWith('wss://')) {
        wsBase = `wss://${trimmedBase}`;
    }
    return `${wsBase}/v1/telnyx/media/${callControlId}?token=${encodeURIComponent(env_1.env.MEDIA_STREAM_TOKEN)}`;
}
//# sourceMappingURL=mediaStreamUrl.js.map