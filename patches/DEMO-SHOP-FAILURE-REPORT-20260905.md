# Demo Shop failure report (2026-09-05)

## Status: bot ships frozen — Nick fixing in Cursor

**Effective immediately:** no further Demo Shop hot-mount / bot code ships until Nick explicitly asks.  
Outbound held. Speex AEC stays ON. Encode/decode alignment untouched.

This report is the handoff for manual Cursor work on `VeraLux-Receptionist-Bundle`.

---

## Latest fail (v3:A9wrcoPg… ~11:37am PT)

**Call:** `v3:A9wrcoPg0JUtCd69Nr5FSxyPpYRW5LkigTcpvhtYjGFVgdSLLe3P2Q`  
**Nick feel:** After intro he asked to schedule a demo → **heard NOTHING** → said hello → **heard NOTHING** → call failed.

### What logs show

| Phase | What happened |
|-------|----------------|
| Greeting | WAV ~2752ms; Telnyx play **200**; `playback.ended` OK — greeting **did** play |
| User turn 1 (schedule demo) | Whisper started; **new speech_start mid-request** → `whisper_abort_observed` → result **discarded** (`whisper_result_discarded_aborted`) — text was mangled (“I'm looking at a skit…”) — **no LLM, no TTS** |
| ~14s+ dead air | Empty Whisper retry; SPEAKERPHONE silent-empty → **no “didn't catch that”**, still no speak |
| “Hello?” | Stream LLM OK → name-ask synthesized (~2.7s WAV, 2 STREAMTTS segs) |
| Name-ask play | Telnyx `playback_start` → **422 Call has already ended** — Nick never heard it |
| Hangup | Caller hangup; BOOKTRUTH hangup skip (no slot/contact) |

**Root cause (plain):** After greeting, the first real user turn was **thrown away** (Whisper abort/discard on new speech), so the bot never answered while he was still on the line. Empty scrap stayed silent by design. The name-ask existed only in logs after he hung up.

**Unused this dial:** DATECONFIRM, BOOKTRUTH slot write (never reached booking).

---

## Prior fails this week (brief)

| Symptom | Call / note | Marker(s) that addressed it |
|---------|-------------|-----------------------------|
| QR loop “What day and time…” | v3:Xe1Nrv0… | NO_QR_LOOP |
| Hangup miss / no `/book` after feel-pass | v3:nM6q… | MIDCALL → NORMALIZE |
| Compact HHMM `1230` → 12:00 | helper | HHMM (helper mount) |
| TTS “2 p--m” / phone as cardinals | — | TTS_PREP |
| Phone/contact cutoff; fake Got-it; bye | — | HARDEN |
| Spiritual invent; never-stop TTS | v3:Chcbrnfk… | TURN + PSTN_WAIT |
| PSTN segment overlap (HTTP≠audio end) | — | PSTN_WAIT |
| Dead air “Are you still there?” | v3:0y68… | ONEWAV |
| False barge / speakerphone echo scrap | v3:50OV6H9b… | SPEAKERPHONE |
| Empty Nemotron content → “problem responding” | v3:yVCll2X… | THINKOFF + STREAMTTS |
| Tue 12:30 spoken → Mon 09:00 written; fake on-file | v3:RcqF-_5… | BOOKTRUTH + DATECONFIRM |
| Post-greeting silence (this report) | v3:A9wrcoPg… | **open — Nick Cursor** |

---

## Live markers (`VERA_DEMO_SHOP_*` from ledger)

- `VERA_DEMO_SHOP_FIX_20260904`
- `VERA_DEMO_SHOP_MIDCALL_BOOK_20260904` (superseded by NORMALIZE; logic remains)
- `VERA_DEMO_SHOP_NORMALIZE_20260904`
- `VERA_DEMO_SHOP_TTS_PREP_20260904`
- `VERA_DEMO_SHOP_NO_QR_LOOP_20260904`
- `VERA_DEMO_SHOP_HARDEN_20260904`
- `VERA_DEMO_SHOP_TURN_20260905`
- `VERA_DEMO_SHOP_PSTN_WAIT_20260905`
- `VERA_DEMO_SHOP_ONEWAV_20260905`
- `VERA_DEMO_SHOP_MUSTBOOK_20260905`
- `VERA_DEMO_SHOP_SPEAKERPHONE_20260905`
- `VERA_DEMO_SHOP_THINKOFF_20260905`
- `VERA_DEMO_SHOP_STREAMBUF_20260905` (bridge; superseded same day by STREAMTTS)
- `VERA_DEMO_SHOP_STREAMTTS_20260905`
- `VERA_DEMO_SHOP_BOOKTRUTH_20260905`
- `VERA_DEMO_SHOP_DATECONFIRM_20260905`

Also: book-helper HHMM + PT/confirm refuse (interim mount, not a VERA_ marker).

---

## Do not touch

- Encode/decode alignment (mulaw/PCM/sample-rate/Telnyx framing) — verified intact through SPEAKERPHONE ships
- Speex AEC **off** (keep `STT_AEC_ENABLED=true`)
- Hermes
- Other tenants (Demo Shop only)

---

## Hot mounts vs bake debt

**Interim mounts** (proof-loop; not baked):

| Source | Destination |
|--------|-------------|
| `patches/callSession.js` | `/app/veralux-voice-runtime/dist/calls/callSession.js` |
| `patches/chunkedSTT.js` | `/app/veralux-voice-runtime/dist/stt/chunkedSTT.js` |
| `patches/brainClient.js` | `/app/veralux-voice-runtime/dist/ai/brainClient.js` |
| `patches/llmProviderResolve.js` | `/app/veralux-voice-runtime/dist/ai/llmProviderResolve.js` |
| `patches/control-server.js` | control hangup path |
| `~/.config/veralux/book-helper-app.py` | demo-shop-book-helper |

Compose overlay: `docker-compose.demo-tts.yml` + `~/.config/veralux/voice-runtime.env.override`.

**After feel PASS:** bake into runtime + control images, commit Bundle patches, drop interim mounts (see `patches/DEBT-control-hangup-image-rebuild.md`). Prefer Cursor cloud agent for bake/commit — not bot hot-mount churn.

---

## Suggested Cursor entry points

1. **`veralux-voice-runtime/src/stt/chunkedSTT.ts` / `patches/chunkedSTT.js`**  
   Whisper abort / `whisper_result_discarded_aborted` on `speech_start` during in-flight final — **primary cause of post-greeting silence** on v3:A9wrcoPg…. Prefer complete-or-queue the final instead of discard-to-silence.

2. **SPEAKERPHONE silent-empty** (`patches/chunkedSTT.js` + `callSession` unclear path)  
   Empty finals stay silent (no “didn't catch that”). Good for echo scrap; compounds dead air when a real turn was already discarded.

3. **STREAMTTS segment play** (`patches/callSession.js` — `VERA_DEMO_SHOP_STREAMTTS_20260905`)  
   Multi-seg PSTN + `waitDemoShopPstnSegmentAudioEnd` / playGen. Name-ask on this dial was fine locally; Telnyx 422 was hangup race.

4. **`normalizeDemoShopBooking` + BOOKTRUTH / DATECONFIRM** (`patches/callSession.js`)  
   Slot fidelity, contact gate, concrete date inject into confirm speak. Not implicated in silence fail; keep when fixing STT.

5. **Midcall / hangup book gates** (`callSession` BOOKTRUTH)  
   `/book` only with scheduleable + name + (phone|email).

Selfchecks: `patches/demo-shop-booktruth-selfcheck.js`  
Measure sheet: `patches/DEMO-SHOP-P2-MEASURE-SHEET-20260905.md`  
Living ledger: `patches/DEMO-SHOP-FIX-LEDGER.md`

---

## Reproduction script (Nick dial)

1. Dial Demo Shop PSTN (outbound still held — inbound only).
2. Hear greeting.
3. Immediately say: “I'd like to schedule a demo” (keep talking / overlap slightly if reproducing abort).
4. Expect **fail today:** long silence; optional “Hello?” still silence or late name-ask after hangup.
5. **Pass criteria when fixed:** assistant answers within ~1–2s after first final (no discard-to-silence); if empty, either recover or one clear re-ask — not 14s+ dead air.
6. Full clean-proof (separate): Tue/Mon slot with am/pm → spoken **concrete date** (DATECONFIRM) → name+phone/email → midcall book → `eventId` + ISO matches spoken clock (BOOKTRUTH).

---

## Process

- **No bot ship** until Nick asks.
- Nick owns the Whisper-abort / silence fix in Cursor against this report + ledger.
- Outbound unlock remains Nick/Vera call after feel-pass.
