# Demo Shop fix ledger

Living record of `VERA_DEMO_SHOP_*` patches so we do not re-solve the same bugs.
**Status policy:** hot bind-mounts are proof-loop only. After next **feel PASS**, bake into `veralux-voice-runtime` + `veralux-control-plane` images, commit Bundle patches, drop interim mounts (see `DEBT-control-hangup-image-rebuild.md`).

**Durable coding path:** prefer Cursor cloud agent on `VeraLux-Receptionist-Bundle` for bake/commit work when not mid-dial firefighting. Hot mounts OK during live proof only.

**Last verified:** 2026-09-05 ~12:00pm PT — **FROZEN** bot ships. See `patches/DEMO-SHOP-FAILURE-REPORT-20260905.md` (Nick Cursor). Outbound held.

---
## Standing rule (Nick — do not regress)

Before **any** Demo Shop patch/ship:

1. Read this ledger.
2. Verify live `VERA_DEMO_SHOP_*` markers still present on the runtime container.
3. Diff the proposed change against each listed win — especially ONEWAV, PSTN_WAIT/overlap, barge→stopPlayback, nonsense STT, hangup PT+confirm, HHMM, NO_QR_LOOP, TTS_PREP, HARDEN contact, NORMALIZE midcall, SPEAKERPHONE early-barge/AEC-on.
4. If a proposed fix would undo or weaken a listed marker → **STOP** and escalate to Vera/Nick; do not ship.
5. After every ship, append this ledger (symptom → root → marker → mount vs baked).

Feel-pass still gates image bake. Outbound held until Nick says otherwise.

---
## FROZEN (2026-09-05 ~12:00pm PT)

Bot Demo Shop code ships **stopped**. Failure handoff: [`DEMO-SHOP-FAILURE-REPORT-20260905.md`](./DEMO-SHOP-FAILURE-REPORT-20260905.md). Resume only when Nick asks.


---

## Live mounts (interim — not baked)

| Source | Container destination |
|--------|----------------------|
| `patches/callSession.js` | `/app/veralux-voice-runtime/dist/calls/callSession.js` |
| `patches/chunkedSTT.js` | `/app/veralux-voice-runtime/dist/stt/chunkedSTT.js` |
| `patches/brainClient.js` | `/app/veralux-voice-runtime/dist/ai/brainClient.js` |
| `patches/llmProviderResolve.js` | `/app/veralux-voice-runtime/dist/ai/llmProviderResolve.js` |
| `~/.config/veralux/book-helper-app.py` | `demo-shop-book-helper:/app/app.py` |
| `~/.config/veralux/demo-shop-bookings.json` | idempotency store |

Compose overlay: `docker-compose.demo-tts.yml` + env `~/.config/veralux/voice-runtime.env.override`. **Outbound held.**

---

## Marker ledger

| Marker | Ship (PT) | Symptom | Root cause | Fix (summary) | State |
|--------|-----------|---------|------------|---------------|-------|
| `VERA_DEMO_SHOP_FIX_20260904` | Sep 4 AM | Feel pass / write miss; hang after book; runtime recreate lost hangup | Missing `queueTtsSegment`; stream errors silent; hangup skipped if session gone | Restore queue/speak; serialize errors; always-fire `call_ended` register | **mount** |
| `VERA_DEMO_SHOP_MIDCALL_BOOK_20260904` | Sep 4 ~11am | Booking only on hangup → misses on recreate | Hangup-only write path | Mid-call POST `/book` on confirm; hangup safety-net; idempotent `call_control_id` | **superseded** by NORMALIZE (logic remains; marker string retired from callSession) |
| `VERA_DEMO_SHOP_NORMALIZE_20260904` | Sep 4 ~11:55am | Brittle month-only regex misses weekday/relative | Confirm detector shape too narrow | `normalizeDemoShopBooking` → absolute PT ISO; mid-call + hangup | **mount** |
| `VERA_DEMO_SHOP_TTS_PREP_20260904` | Sep 4 ~12pm | “2 p--m”; phone as cardinals | Chunk split on `p.m.`; TTS numeric magnitude | `normalizeDemoShopSpeakText` AM/PM + digit-by-digit; boundary skip | **mount** |
| `VERA_DEMO_SHOP_NO_QR_LOOP_20260904` | Sep 4 ~12:15pm | Loop “What day and time work best?” | Mid-call QR matched “book”/hours | Demo Shop QR only on first user turn; compact HHMM in parse | **mount** |
| `VERA_DEMO_SHOP_HARDEN_20260904` | Sep 4 ~3:55pm | Cut off on phone; incomplete “my phone number is…” → Got it; bye → trouble hearing; `**` in TTS; curly `I’ve` missed midcall | 6s max-utt; LLM fake confirm; markdown; Unicode apostrophe | Contact max-utt 18s; incomplete re-ask; bye close; strip `**`; ASCII apostrophe | **mount** |
| `VERA_DEMO_SHOP_TURN_20260905` | Sep 4 ~10:53pm | Never stopped talking; “spiritual demo”; junk hangup GCal UTC 10:00 | Barge armed without stop; long multi-seg TTS; Whisper garbage → LLM invent; hangup book too loose | Wire `onBargeInDetected`→stop; short replies; nonsense STT gate; hangup needs PT+confirm | **mount** |
| `VERA_DEMO_SHOP_PSTN_WAIT_20260905` | Sep 4 ~10:58pm | Overlapping monologue (HTTP 200 ≠ audio end); fake-confirm race | Segment chain advanced on Telnyx accept | Await `playback.ended`/duration; interrupt+clear before rewrite | **mount** (mostly unused after ONEWAV) |
| `VERA_DEMO_SHOP_ONEWAV_20260905` | Sep 4 ~11:32pm | Super long pauses; “Are you still there?” after name ask | PSTN wait resolved on **stale** seg1 `playback.ended` → early listen + dead air | Demo Shop PSTN = full reply → **one** `playAssistantTurn` (no stream segments) | **mount** (current) |
| `VERA_DEMO_SHOP_MUSTBOOK_20260905` | Sep 5 ~9:15am | After name, LLM: “I’ll have Nicholas follow up…” instead of asking day/time | Prompt allowed human handoff/callback; no speak-path rewrite | Prompt: you book on this call; never Nicholas/human follow-up; after name ask day/time+am/pm then book. Guard: `maybeRewriteDemoShopHandoff` → on-call ask | **mount** |
| `VERA_DEMO_SHOP_SPEAKERPHONE_20260905` | Sep 5 ~10:15am | Speakerphone residual energy false-barge + empty Whisper handoff → “I didn’t catch that” / nuked reply | Early TTS energy + near-silent post-play scraps + grace stall | Demo-shop only: ignore barge first ~500ms (keep TURN stop after); skip near-silent handoff; flush grace on loud RMS≥0.05; silent empty finals (no unclear); AEC stays ON | **mount** |
| `VERA_DEMO_SHOP_THINKOFF_20260905` | Sep 5 ~10:46am | Empty/blank LLM content (thinking tokens eating reply) | Non-stream OpenAI-direct body lacked thinking-off (stream already had it) | Non-stream `generateOpenAiDirectReply`: `chat_template_kwargs: { enable_thinking: false }` | **mount** |
| `VERA_DEMO_SHOP_STREAMBUF_20260905` | Sep 5 ~10:50am | Non-stream LLM path still high TTFT / empty-content risk; need stream tokens before TTS | PSTN forced `generateAssistantReply` then one WAV | Demo Shop PSTN: `generateAssistantReplyStream` collect full text → rewrite/truncate → one `playAssistantTurn` (ONEWAV kept); stream fail → non-stream THINKOFF. **Superseded by STREAMTTS same day (mandatory P1→P2 exit).** | **superseded** |
| `VERA_DEMO_SHOP_STREAMTTS_20260905` | Sep 5 ~10:55am | Buffered one-WAV still misses first-audio band / TTFT goal | ONEWAV/STREAMBUF delayed first audio until full LLM | Demo Shop PSTN: fall through to stream LLM + chunked TTS (max 1–2 segs/TURN); await real playback.ended + ONEWAV playGen; mid-stream invent/handoff abort; SPEAKERPHONE+TURN kept | **mount** |
| `VERA_DEMO_SHOP_BOOKTRUTH_20260905` | Sep 5 ~11:20am | Spoken Tue 12:30 but midcall wrote 09:00; bare Yes + “on file” without collecting contact | `normalize` searched assistant hours first (“Mon–Fri 9 AM”); /book gated only on confirm+start; HARDEN missed “on file”/I’ve-booked variants | Prefer user-spoken clock + reject hours-bleed; compact HHMM; POST /book only if scheduleable+name+(phone\|email); extend fake-confirm/on-file rewrite; selfcheck | **mount** |
| `VERA_DEMO_SHOP_DATECONFIRM_20260905` | Sep 5 ~11:35am | Confirm spoke weekday-only ("Tuesday at 2 PM") without calendar date | LLM confirm omitted absolute month/day after normalize resolved PT start | Deterministic `maybeRewriteDemoShopDateConfirm` + `formatDemoShopConfirmDateFromIso`; wire post-stream + stream segment + playAssistantTurn; selfcheck extended. Nick ask: speak concrete date e.g. "Monday, September 8th at 2 PM" | **mount** |


---
## P1→P2 exit (dated 2026-09-05)

`STREAMBUF` was a **bridge**. Proceeded to P2 (`STREAMTTS`) same day (mandatory exit; do not stop at buffered one-WAV). STREAMTTS now live on mount.

### Helper (not a VERA_ marker; still interim mount)

| Area | Ship | Symptom | Fix | State |
|------|------|---------|-----|-------|
| book-helper HHMM + PT/confirm refuse | Sep 4 | `1230`→12:00; hangup invent UTC 10:00 | Compact HHMM; prefer runtime ISO; **400** `missing_start` / `start_not_pt` / `missing_confirm` | **mount** `book-helper-app.py` |

---

## Incident → marker quick index

| Call / feel | Outcome | Primary markers |
|-------------|---------|-----------------|
| v3:nM6q… FEEL PASS WRITE MISS | Mid-call book required | MIDCALL → NORMALIZE |
| v3:Xe1Nrv0… QR loop + 12:00 | NO_QR_LOOP + helper HHMM | NO_QR_LOOP, helper |
| v3:5hqb… clean-proof PASS (weird ending) | Write OK; harden package | HARDEN |
| v3:Chcbrnfk… spiritual / never stop | TURN + PSTN_WAIT | TURN, PSTN_WAIT |
| v3:0y68… dead air “still there” | ONEWAV | ONEWAV |
| v3:eLovEijx… name→Nicholas follow-up | Must book on call | MUSTBOOK |
| v3:50OV6H9b… speakerphone / false barge + empty handoff | Protect early barge; silent empty | SPEAKERPHONE |
| v3:yVCll2X… empty content / thinking | Disable non-stream thinking | THINKOFF |
| v3:RcqF… Tue 12:30 spoken → wrote 09:00 + on-file | Slot truth + contact gate | BOOKTRUTH |
| v3:… Nick ask concrete date speak | Confirm weekday-only → month+day | DATECONFIRM |

---

## After next feel PASS (bake checklist)

1. Cursor cloud agent on `VeraLux-Receptionist-Bundle`: fold `patches/callSession.js` (+ brainClient / llmProviderResolve as needed) into image build; same for control hangup bake.
2. Bake helper into book-helper image or Bundle path — stop relying on `~/.config/veralux/book-helper-app.py` alone.
3. Publish runtime + control images; recreate without demo-tts bind mounts.
4. Re-run `scripts/assert-demo-runtime-patches.sh` against **image** contents (not only mounts).
5. Commit ledger + patches; mark rows **baked** with image tags/SHAs.
6. Outbound unlock only on Nick’s call.

---

## Cursor models note

- **Firefights (mid-dial):** Builder hot-patches via bind mounts on workstation (fast proof).
- **Durable work (bake/commit/PR):** use **Cursor cloud agent** on the Bundle repo — not mount-only edits.
- Do not treat mounts as the long-term source of truth.
