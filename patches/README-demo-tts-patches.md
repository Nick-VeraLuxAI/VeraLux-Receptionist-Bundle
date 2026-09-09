Living ledger: see [DEMO-SHOP-FIX-LEDGER.md](./DEMO-SHOP-FIX-LEDGER.md) (markers, symptoms, mount vs bake).\n\nDemo TTS bind-mount patches (durable rules)

Do not regenerate patches/callSession.js in a way that drops methods.

Required until released into runtime/control images:
1. queueTtsSegment method definition must exist (call sites alone are insufficient).
2. Streaming must playAssistantTurn(response) when playbackDone is unset.
3. brainClient must serialize stream errors (err_message) and return partial text when tokens were seen.
4. Control action=end must always handleCallEnded from body history/transcript (Telnyx call_control_id often != in-memory start id).

Preflight: ./scripts/assert-demo-runtime-patches.sh

Source bake (2026-09-04):
- veralux-voice-runtime/src/calls/callSession.ts — queueTtsSegment already present; !playbackDone speak + serialized generation-failed err baked into source.
- control-plane/src/server.ts — already always fires handleCallEnded; live image was stale, so patches/control-server.js mounts until control image rebuild.

## Mid-call book (2026-09-04)
Product path for Demo Shop: on assistant booking confirmation, runtime POSTs `http://demo-shop-book-helper:8791/book` immediately (store_lead + GCal). Helper is idempotent on `call_control_id`. Hangup `call_ended` workflow remains safety net only. Marker: `VERA_DEMO_SHOP_MIDCALL_BOOK_20260904`.

## Normalize-then-write (2026-09-04)
Demo Shop durable booking path: `normalizeDemoShopBooking` resolves confirm + absolute PT start (month/day, weekday, today/tomorrow/next weekday), then mid-call and hangup both POST `/book`. Marker `VERA_DEMO_SHOP_NORMALIZE_20260904`. Idempotent on call_control_id in helper.


## Demo Shop harden (2026-09-04)
Marker `VERA_DEMO_SHOP_HARDEN_20260904` (extends TTS prep / normalize):
1. Contact/digit turns: when assistant asks for phone/email, raise ChunkedSTT `maxUtteranceMs` to 18s (baseline restored after contact captured). Demo Shop only.
2. Incomplete contact guard: openers like "my phone number is" with no/few digits → re-ask once; skip LLM "Got it". Optional rewrite if LLM claims confirm/email-on-file without ≥7 digits or email in history.
3. Bye → graceful close: goodbye transcripts skip LLM, speak short goodbye, hang up via transport.stop.
4. TTS: strip `**` / `__` markdown emphasis in `normalizeDemoShopSpeakText`.
5. Midcall confirm: Unicode apostrophes (U+2019 etc.) normalized to ASCII before confirm regex so "I've booked" fires midcall.

## Demo Shop turn harden (2026-09-05)
Marker `VERA_DEMO_SHOP_TURN_20260905` (Demo Shop only where noted):
1. **Barge-in stops playback**: wire `ChunkedSTT.onBargeInDetected` → `handleSpeechStart` → `clearTtsQueue` + `stopPlayback`. Fixes armed-without-stop (`frame_dropped_by_playback_gate` + monologue).
2. **Short replies**: cap spoken reply ~200 chars / max 2 TTS segments; truncate at sentence boundary; Demo Shop LLM hint via `brainAssistantContext`.
3. **Nonsense STT gate**: early Whisper garbage / hallucinated products (e.g. "spiritual") → clarify ask, skip LLM invent; rewrite invented products before TTS.
4. **Hangup /book guard**: hangup path requires confirm + absolute America/Los_Angeles start; no default 10:00; book-helper returns 400 if start missing or UTC/+00:00 (does not invent).
