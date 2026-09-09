"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.claimStreamingStart = claimStreamingStart;
exports.releaseStreamingStart = releaseStreamingStart;
const started = new Set();
/** Returns true if this is the first streaming_start for the call. */
function claimStreamingStart(callControlId) {
    if (started.has(callControlId))
        return false;
    started.add(callControlId);
    return true;
}
function releaseStreamingStart(callControlId) {
    started.delete(callControlId);
}
//# sourceMappingURL=streamStartGuard.js.map