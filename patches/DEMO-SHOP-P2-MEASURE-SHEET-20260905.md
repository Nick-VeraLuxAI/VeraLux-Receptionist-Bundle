# Demo Shop P2 measure sheet — 2026-09-05 (~10:55am PT)

**Status:** STREAMTTS live on mount; **no Nick dial yet** at ship time. Measure on next inbound Demo Shop dial.

## Live markers (runtime mount — verify before dial)

- THINKOFF, STREAMTTS, ONEWAV (playGen), PSTN_WAIT, SPEAKERPHONE, TURN, MUSTBOOK, TTS_PREP, HARDEN, NORMALIZE, NO_QR_LOOP, FIX
- STREAMBUF: superseded (bridge retired from callSession)
- STT_AEC_ENABLED=true (do not change)

## What to measure (next Nick dial)

| Metric | How / where | Pass band (target) | Notes |
|--------|-------------|--------------------|-------|
| TTFB first audio | Logs: first stream token → first tts_segment_queued → Telnyx play / tts_bytes_ready | First audio ≤ ~700ms after first-token intent (firstAudioMaxMs=700 demo-shop); feel ≤ ~1.2–1.5s after user final | STREAMTTS should beat ONEWAV/STREAMBUF full-buffer wait |
| Segment count | tts_segment_queued / demo_shop_segment_cap | 1–2 segments max (TURN) | Cap=2; invent/handoff abort may force 1 |
| Overlap / stale settle | demo_shop_pstn_segment_wait_done reason; listening while SPEAKING; double-talk | Wait settles on webhook or duration for current play_gen+segment_id only — never pre-play stale | Regression of ONEWAV dead-air = FAIL |
| False barge (speakerphone) | Early barge ignores first ~500ms; TURN stopPlayback after | No nuke of reply in first 500ms; intentional barge still stops | SPEAKERPHONE retained |
| Empty / fallback | Empty assistant content; fallback_error; THINKOFF | No blank WAV; thinking-off on stream + non-stream | Incident v3:yVCll2X |
| Invent / handoff | demo_shop_stream_invent_blocked / handoff_blocked / post_stream_rewrite | Mid-stream abort + rewrite; MUSTBOOK ask day/time | No Nicholas follow-up |
| Health | docker inspect health; AEC env | healthy + AEC on | After every recreate |

## Log greps (workstation)

    docker logs veralux-runtime --since 30m 2>&1 | grep -E 'demo_shop_pstn_segment_wait_done|tts_segment_queued|demo_shop_segment_cap|demo_shop_stream_|assistant_reply_|openai_direct_stream|barge|fallback_error'

## Redial-safe

Yes — outbound held; inbound Demo Shop redial OK after healthy recreate with markers above.
