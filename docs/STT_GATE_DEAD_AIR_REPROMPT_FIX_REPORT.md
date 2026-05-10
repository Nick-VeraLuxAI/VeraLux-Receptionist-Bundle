# STT gate and dead-air reprompt fix report

## Problem

Live PSTN calls showed inbound media (`media_ready`, `stt_first_pcm16_frame`, `stt_speech_decision`) but **no** `whisper_fetch_start` / `whisper_fetch_done`, **no** `stt_transcription_result`, **no** `turn_trigger`, and `transcripts_total=0`. Logs repeated `stt_gate_closed` with `below_rms_floor`, `below_peak_floor`, and `insufficient_frames`. Dead-air reprompts (“Are you still there?”) fired while the caller was likely speaking because **utterances never opened** under the previous **strict AND** gate plus a **hard streak reset** on any non-speech frame.

## Root cause (trace)

1. **Speech classification** (VAD off): `isSpeech` required **both** `gateRms` and `gatePeak` on the same frame. PSTN/codec frames often satisfy RMS or peak on alternating 20 ms frames, not both simultaneously.
2. **Opening streak**: `speechFrameStreak` incremented only when `isSpeech` was true and reset to **zero** on any `!isSpeech` frame, so intermittent syllables rarely reached `speechFramesRequired` (default **8**).
3. **Tier-5 caps**: Effective adaptive floors were already bounded; caps were tightened slightly upward so adaptive noise tracking does not sit slightly above typical AMR-WB speech as often.
4. **Dead-air**: `lastInboundMediaAtMs` advanced on media packets, but **gate-positive** energy without a finalized utterance did not defer reprompts, so timers could still fire during “stuck gate” situations.

## Changes (by phase)

### Phase 1–2 — Gate sensitivity and accumulation (`chunkedSTT.ts`)

- Default **`speech_frames_required`** lowered from **8 → 5** (`DEFAULT_SPEECH_FRAMES_REQUIRED` and constructor clamp input).
- **Rolling OR-path** (VAD off, hysteresis unset): if strict `gateRms && gatePeak` fails but rolling RMS/peak align with the effective floors and per-frame **max/min ratio** checks pass, the frame still counts as speech (`usedRollingOrPath`). Tunables: `STT_ALT_SPEECH_ROLLING_OR_PATH_ENABLED` (default true), `STT_ALT_SPEECH_ROLLING_RMS_MULT`, `STT_ALT_SPEECH_ROLLING_PEAK_MULT`, `STT_ALT_SPEECH_MAX_DIM_RATIO`, `STT_ALT_SPEECH_MIN_DIM_RATIO`.
- **Streak decay**: when `gate_rms || gate_peak` but the frame is not classified as speech, decay the streak by `STT_SPEECH_STREAK_PARTIAL_DECAY` (default **1**) instead of resetting to zero. True silence (`!gate_rms && !gate_peak`) still resets the streak and candidate counters.
- **Tier-5 effective floor caps** defaults: `STT_EFFECTIVE_RMS_CAP` **0.019 → 0.021**, `STT_EFFECTIVE_PEAK_CAP` **0.056 → 0.058** (still capped; set to `0` to disable caps).

### Phase 3 — Dead-air deferral (`callSession.ts`, `env.ts`)

- New env: **`DEAD_AIR_DEFER_RECENT_STT_SIGNAL_MS`** (default **4000**). While in `LISTENING`, if STT recently reported `gate_rms`, `gate_peak`, or `is_speech` via `onSttListeningGateActivity`, dead-air reprompt is **rescheduled** and **`dead_air_deferred_recent_speech`** is logged (no audio content, no PII).

### Phase 4 — Diagnostics (`chunkedSTT.ts`)

| Event | Purpose |
| --- | --- |
| `stt_gate_summary_per_utterance` | Counts and floors when an utterance **opens** (accepted candidate). |
| `stt_candidate_started` | First frame of a new pre-utterance streak. |
| `stt_candidate_dropped_reason` | Candidate abandoned to silence (throttled). |
| `whisper_not_called_reason` | Throttled reasons when final HTTP is skipped (`call_inactive`, `playback_gate_*`, `stt_inflight`, etc.). |
| `stt_speech_decision` | Adds `rolling_or_path`. |

### Phase 5 — Tests (`veralux-voice-runtime/tests/sttGate.test.ts`)

1. Steady speech → Whisper final (transcript stub: “what time do you close”).
2. One weak frame mid streak → still finalizes (streak decay / rolling path).
3. Very low energy → no transcribe.
4. `isPlaybackActive` true → no transcribe.
5. `onSttListeningGateActivity` invoked when listening with real inbound energy.

### Phase 6 — Validation

Commands run successfully:

- `npm run build -w veralux-voice-runtime`
- `npm test -w veralux-voice-runtime`
- `npm run test:production-readiness`

## Acceptance mapping

| Requirement | How it is met |
| --- | --- |
| Caller asks closing time → Whisper | Rolling OR-path + shorter streak + decay; unchanged HTTP provider and finalize path. |
| Logs `whisper_fetch_*` / `stt_transcription_result` / `turn_trigger` | Existing provider and `callSession` transcript handling unchanged once an utterance opens. |
| “Are you still there?” only when truly idle | `dead_air_deferred_recent_speech` + existing inbound-media and STT-in-flight guards. |
| No Telnyx signature / LLM routing / business-hours edits | Only `chunkedSTT.ts`, `callSession.ts`, `env.ts`, tests, and this doc. |
| No PII in new logs | Only booleans, counts, ratios, floor values, reason codes. |

## Operator knobs (summary)

- **Gate floors**: `STT_RMS_FLOOR`, `STT_PEAK_FLOOR`, `STT_SPEECH_*` (existing).
- **Frames to open**: `STT_SPEECH_FRAMES_REQUIRED`.
- **Streak softness**: `STT_SPEECH_STREAK_PARTIAL_DECAY`.
- **OR-path**: `STT_ALT_SPEECH_ROLLING_OR_PATH_ENABLED` and `STT_ALT_*` ratio/mult envs.
- **Dead-air**: `DEAD_AIR_MS`, `DEAD_AIR_NO_FRAMES_MS`, **`DEAD_AIR_DEFER_RECENT_STT_SIGNAL_MS`**.
