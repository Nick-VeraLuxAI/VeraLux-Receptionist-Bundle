# Demo Shop fix ledger

Living record of `VERA_DEMO_SHOP_*` patches so we do not re-solve the same bugs.
**Status policy:** hot bind-mounts are proof-loop only. After next **feel PASS**, bake into `veralux-voice-runtime` + `veralux-control-plane` images, commit Bundle patches, drop interim mounts (see `DEBT-control-hangup-image-rebuild.md`).

**Durable coding path:** prefer Cursor cloud agent on `VeraLux-Receptionist-Bundle` for bake/commit work when not mid-dial firefighting. Hot mounts OK during live proof only.

**Last verified:** 2026-09-08 ~10:55am PT — Qwen3 `/tts/stream` live; first clause ~0.5s on a 3-sentence line, ~2.1s on a single sentence. Chatterbox+Kokoro stopped on GPU 0. Feel PASS still gates bake. Outbound held.

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
## Unfrozen for LISTENFINAL (2026-09-05 ~3:35pm PT)

Nick asked Cursor to ship the post-greeting silence fix. Marker `VERA_DEMO_SHOP_LISTENFINAL_20260905` is on the runtime mounts. Outbound still held. Bake still after feel PASS.


---

## Live mounts (interim — not baked)

| Source | Container destination |
|--------|----------------------|
| `patches/callSession.js` | `/app/veralux-voice-runtime/dist/calls/callSession.js` |
| `patches/chunkedSTT.js` | `/app/veralux-voice-runtime/dist/stt/chunkedSTT.js` |
| `patches/brainClient.js` | `/app/veralux-voice-runtime/dist/ai/brainClient.js` |
| `patches/llmProviderResolve.js` | `/app/veralux-voice-runtime/dist/ai/llmProviderResolve.js` |
| `patches/audioInvariantReport.js` | `/app/veralux-voice-runtime/dist/observability/audioInvariantReport.js` |
| `patches/callQualitySummary.js` | `/app/veralux-voice-runtime/dist/observability/callQualitySummary.js` |
| `patches/talkerBoard.js` | `/app/veralux-voice-runtime/dist/calls/talkerBoard.js` |
| `patches/demoShopDtmf.js` | `/app/veralux-voice-runtime/dist/calls/demoShopDtmf.js` |
| `patches/sessionManager.js` | `/app/veralux-voice-runtime/dist/calls/sessionManager.js` |
| `patches/qwen3Tts.js` | `/app/veralux-voice-runtime/dist/tts/qwen3Tts.js` |
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
| `VERA_DEMO_SHOP_LISTENFINAL_20260905` | Sep 5 ~3:35pm | Post-greeting silence (v3:A9wrcoPg): first turn discarded, 14s dead air, no re-ask | Listening-state abort of in-flight Whisper final + silent-empty + PSTN RTP resets dead-air | Demo-shop only: keep in-flight final while listening (playback barge still aborts); one re-ask for long empty finals; dead-air ignores continuous inbound RTP | **mount** |
| `VERA_DEMO_SHOP_CONTACTCLOCK_20260905` | Sep 5 ~3:55pm | v3:yb1vkj: spoke “I’ll book it” after “Tuesday at noon”; no contact ask; /book 400 missing_start | `noon` not a clock; future-tense book missed HARDEN/BOOKTRUTH rewrite | Named clocks noon/midnight; “I’ll book / let me book” → hold date + name/phone-email ask; /book still writable-only (name+contact+PT start) | **mount** |
| `VERA_DEMO_SHOP_LATENCY_20260905` | Sep 5 ~4:00pm | Need end-of-call latency report after next dial | No greppable per-turn STT/LLM/TTS/play deltas | `call_latency_turn` + `call_latency_report` on hangup (feel, speech→final, TTFT, TTS, play) | **mount** |
| `VERA_DEMO_SHOP_NAMETRUTH_20260905` | Sep 5 ~4:10pm | v3:pn5WDT: said “I've booked” but /book skipped; `has_name` flipped false | `/book` name regex required FIRST+LAST; rewrite used looser matcher; booked-speak not gated on write | First-name extract + persist; abort/rewrite unposted booked-claim; speak booked only after POST ok; after-name product-ask → day/time | **mount** |
| `VERA_DEMO_SHOP_TTS_REPLYTEXT_UNWRAP_20260906` | Sep 6 ~6:30pm | Caller heard JSON schema (`replyText`/`actions`/`stage`) spoken by Chatterbox | `brainClient` returned full JSON as `reply.text`; no unwrap before `/tts/stream` (thinking did NOT leak; THINKOFF intact) | `extractDemoShopSpokenText` + stream JSON buffer + choke-points in rewrite/`playAssistantTurn`/`normalizeDemoShopSpeakText`; speak `replyText` only | **mount** |
| `VERA_DEMO_SHOP_CONVOFEEL_20260906` | Sep 6 ~6:55pm | Structurally books, but sounds choppy / one-slot form (v3:AcP0zX4tMAX); 0 `tts_segment_queued`; TTFA 0.9–2.4s; 700ms silence + ~0.7–0.9s grace | Dialog rigidity; STREAMTTS fall-through dead (all PSTN ONEWAV); post-play grace 300–900 | Conversational voice rules + combine related asks; ban “got you down” until write; Demo Shop PSTN STREAMTTS ≤2 segs + PSTN_WAIT; grace 240–420; silence 550 / contact 800 | **mount** |
| `VERA_DEMO_SHOP_NO_REGREET_20260906` | Sep 6 ~7:40pm | Every turn after name opened “Hi Nick! …” (v3:YamCcptCIshmbAD29ofHJzzqwfcS6fz0jVzDDEw77O7-VXtHVEOxHw) | LLM replyText re-greeted; voice rules never forbade it; no speak rewrite | After first Hi+Name ack: prompt ban + `maybeRewriteDemoShopRegreet` strips Hi/Hello/Hey + name and “Great to meet you” before TTS (stream + play choke-points) | **mount** |
| `VERA_DEMO_SHOP_BARGE_SUSTAIN_20260906` | Sep 6 ~7:40pm | Same call: listen armed while TTS playing; brief “Tuesday at” / “Oh my gosh.” spawned full Hi-Nick turns | Barge ~100ms; listen during playbackActive; aborted fragments promoted | Demo Shop: 280ms+ RMS≥0.032 sustain before cancel; no listen while playbackActive; 280ms settle; discard short barge blips | **mount** |
| `VERA_DEMO_SHOP_STREAMTTS_REMAINDER_20260906` | Sep 6 ~8:20pm | v3:I3HbpytjaUY: spoke “Hi there!” + “My name's Sarah.” then ~13s silence; name/time ask never spoken | STREAMTTS max_segments=2 then silent discard; post-stream drained queue only | First-audio still ≤2 segs; leftover replyText queued as one PSTN_WAIT tail clip (`remainder_queued` / `_spoken`); no silent drop | **mount** (intent kept; DEDUP fixes wrong tail) |
| `VERA_DEMO_SHOP_STREAMTTS_REMAINDER_DEDUP_20260906` | Sep 6 ~8:40pm | v3:ys94d8gX: segs 1–2 then **full** replyText replayed (remainder_len=157 starts “Hi there!”) | Unwrap reset speakCursor→0; `longer(fromParts,fromCursor)` picked full reply | Remap cursor after unwrap; pick unsent suffix only; skip+log `remainder_skipped_duplicate` if tail restates seg1; combine tiny first clauses | **mount** |
| `VERA_DEMO_SHOP_PICKUP_HISTORY_20260906` | Sep 6 ~10:20pm | Pickup WAV then LLM “Hi there / I’m Sarah” second intro | Greeting played but never appended to conversationHistory | After successful `answerAndGreet`, inject exact greeting as assistant turn 0; prompt: already greeted, continue mid-call; light reopen strip as backup | **mount** |
| `VERA_DEMO_SHOP_NONAMEHALLUC_20260907` | Sep 7 ~12:05pm | v3:zzPdI6Mq: heard “Mo”; stream requested PCMU | Whisper “I was Mo”; Hi-strip left “Mo,”; STREAM_CODEC unset → PCMU fallback; reopen rewrite interrupted and restacked audio | Strip Hi+guessed name; no interrupt for opener-only strip; `TELNYX_STREAM_CODEC=AMR-WB` on runtime | **mount** + env |
| `VERA_DEMO_SHOP_PLAY16K_20260907` | Sep 7 ~12:34pm | Reverb/echo feel on AMR-WB PSTN after 24 kHz Chatterbox playback | `PLAYBACK_PSTN_SAMPLE_RATE=24000` sent Telnyx a 24 kHz WAV; AEC far-end tap linear-resampled 24→16 separately from Telnyx’s downsample | Keep Chatterbox 24 kHz synth; pipeline target **16000**; same 16 kHz file to Telnyx play + AEC. Inbound BE decode **not** touched | **env** (demo-tts overlay) |
| `VERA_DEMO_SHOP_PLAYSERIAL_20260907` | Sep 7 ~12:48pm | v3:fJJo: after email ask, two clips overlapped (“got you down” + “I’m booking now”); hangup skip despite name+contact+PT start | Stream abort still `playAssistantTurn(original)`; rewrite `beginPlayback` cleared `interrupted` so stale TTS still `playback.play`. Writable required assistant confirm phrase, which rewrite stripped | Play epoch drops stale TTS; rewrite-abort skips original play; dateconfirm does not interrupt. `/book` when name+contact+PT start (mid-call + hangup) | **mount** |
| `VERA_DEMO_SHOP_AUDIOINV_20260907` | Sep 7 ~1:25pm | No internal loop: decode_failures and stacked-play/rate bugs did not persist or classify | Hangup had latency only; quality summary had echo/latency labels; SID ticks counted as generic decode fails | Per-call `audio_invariant_report`: SID budget vs speech-decode spike / seq gap / stacked play / 16 kHz play vs AEC tap. Persist on `call_quality_summaries.audioInvariants`. **Does not** retune AMR-WB decode | **mount** |
| `VERA_DEMO_SHOP_BOOKCONFIRM_20260907` | Sep 7 ~3:45pm | v3:bf0q: name+phone+Tue 12:30 posted, helper 400 `missing_confirm`; hangup never retried; spoke “I’ll schedule” with no GCal | Helper still required confirm phrase; failed `demoShopMidCallBookPromise` blocked hangup; “I’ll go ahead and schedule” missed booked-claim rewrite | Helper accepts complete name+contact+PT start; POST `confirmSignal` when writable; clear promise on fail; hangup retries; treat I’ll-schedule as booked-claim | **mount** (runtime + book-helper) |
| `VERA_DEMO_SHOP_SLOTCARD_20260907` | Sep 7 ~4:30pm | v3:bf0q: after phone, asked email; shopping-list prompt drove collection | Talker never saw a live slot card; voice rules said collect name, time, and phone or email | Watcher `Call board` HAVE/MISSING/NEXT last in assistant context; phone HAVE → NEXT is not ask email; writable → brief ack, system writing; posted → confirm booked | **mount** |
| `VERA_DEMO_SHOP_LISTENOPEN_20260907` | Sep 7 ~4:40pm | v3:B0f4: greeting, “book a demo”, then dead air; `transcripts_total=0` | STT needed 5 consecutive 20ms frames above both floors; AEC-bursty speech peaked at streak=2 then `silence_reset`. Leftover far-end after play.ended can still cancel | Demo Shop: open utterance at 2 frames; one miss decays streak instead of wipe; flush leftover far-end + reset AEC on playback end. AMR-WB decode untouched; AEC stays ON | **mount** |
| `VERA_DEMO_SHOP_SLOTHEAR_20260907` | Sep 7 ~5:05pm | v3:4N9a: caller said “Nick De Santis” + Sep 8 12:30 + 2086251175; hangup `has_name=false` | Name extractor took 1–2 tokens after “use”; dropped particle last names; Whisper also wrote “DeSantis”. 9-digit fragments went to the LLM | Cue-scan keeps “Nick De Santis”; “and/on September” fallback; 10-digit phone; 4–9 digit skip LLM; contact silence 1400ms | **mount** |
| `VERA_DEMO_SHOP_DTMF_20260907` | Sep 7 ~5:35pm | Spoken 10-digit chopped; no keypad path; slam-dunk bookings fail under Whisper | Open-ended ASR on digits; webhook ignored `call.dtmf.received` | Say-or-tap: first complete 10 digits wins. DTMF buffer is keypad-only (`*` clears). Speech 10-digit still wins if it lands first. Incomplete reask + board mention keypad | **mount** |
| `VERA_DEMO_SHOP_BARGEKEEP_20260907` | Sep 7 ~5:50pm | Interrupt speech (“Tuesday at—”) dropped; 280ms was tripwire only | Pre-roll wiped on barge arm; frames dropped by playback gate until armed | Demo Shop: buffer AEC near-end during sustain (after first 500ms of her clip); do not wipe on arm; still stop her. Not full duplex / she does not keep talking | **mount** |
| `VERA_DEMO_SHOP_DUPLEX_20260907` | Sep 7 ~5:55pm | Half-duplex: listen gated for whole playback; 280ms settle after barge | `playbackGateActive` true until play ends; LISTENING blocked while TTS plays | After 280ms sustain barge: open STT gate while her clip dies (`bargeInArmed \|\| inSpeech`); arm LISTENING immediately; skip settle. She still **stops** (yield). AEC on. Not overlapping two talkers | **mount** |
| `VERA_DEMO_SHOP_COLLECTPASS_20260907` | Sep 7 ~6:45pm | v3:bZtq: stacked name+date chopped at 6s; pass never finished | 18s max-utt only armed after she asked for phone; default 6s cut the dump | 18s max from first listen until booking is writable. Contact silence 1400ms stays ask-only. Name/date still 550ms endpoint | **superseded** by PERSONEND (fuse still armed early; 18s guess retired) |
| `VERA_DEMO_SHOP_PERSONEND_20260907` | Sep 7 ~6:50pm | Time cap still guessed how long a person talks (6s then 18s) | Max-utt finalized mid-speech; silence already knew they were not done | Demo Shop: do not cut on max while caller has not gone silent. Endpoint = silence. 60s runaway fuse only | **mount** |
| `VERA_DEMO_SHOP_QWEN3_STREAM_20260908` | Sep 8 ~10:50am | Qwen3 audio great but a little slow vs Chatterbox Turbo | HTTP `/tts` waited for the full WAV; next STREAMTTS clause did not synth during playback; idle Chatterbox/Kokoro on GPU 0 | `POST /tts/stream` VLX1 + play first sentence immediately; prefetch next clause during play; CUDA warmup; stop unused Chatterbox/Kokoro. Not codec-frame Turbo (qwen-tts 0.1.1 has no PCM generator) | **mount** + qwen3 python bind |
| `VERA_DEMO_SHOP_MAGPIE_MELO_20260908` | Sep 8 ~3:20pm | Want Magpie + MeloTTS ready and hot-swappable from Voice | No local servers or TTS modes for either engine | Always-on `veralux-magpie-tts:7012` and `veralux-melo-tts:7013` on GPU 0. Voice engine selector swaps tenant `tts.mode`; Magpie temp/CFG/top-k and Melo speed/noise on the page. Default stays Qwen3 Serena. HF Magpie first warm line ~1.2s (not NIM 32–79ms). | **mount** + SPA docker-cp (feel-pass still gates bake) |


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
| v3:A9wrcoPg… post-greeting silence | Keep in-flight Whisper + one re-ask | LISTENFINAL |
| v3:yb1vkj… noon + I’ll book, no contact | Named clock + contact rewrite | CONTACTCLOCK |
| v3:XMzzkjc… JSON envelope spoken as TTS | Unwrap replyText before Chatterbox | TTS_REPLYTEXT_UNWRAP |
| v3:AcP0zX4tMAX… books but form-robot / dead air | Conversational feel + first-audio | CONVOFEEL |
| v3:YamCcptCI… Hi Nick every turn + false-barge loop; STREAMTTS never armed | Ban re-greet; sustain barge; stream despite shopPlaybook | NO_REGREET, BARGE_SUSTAIN, CONVOFEEL/STREAMTTS |
| v3:I3HbpytjaUY… silence after “My name's Sarah.”; leftover ask never spoken | Speak STREAMTTS remainder after 2-seg cap | STREAMTTS_REMAINDER |
| v3:ys94d8gX… remainder replayed entire “Hi there!…” after two clips | Remainder = unsent suffix only | STREAMTTS_REMAINDER_DEDUP |
| Pickup WAV + LLM second intro (Hi there / Sarah) | History injection; don’t re-open | PICKUP_HISTORY |
| v3:jv-Wcp0L… / v3:zzPdI6Mq… echo/reverb on 16 kHz AMR-WB | 24 kHz play vs 16 kHz AEC tap | PLAY16K |
| v3:fJJo2BDL… double speak after email + no GCal write | Stale playText + confirm-phrase gate | PLAYSERIAL |
| No closed audio loop (SID counted as decode “errors”) | Observe-only classifier + persist | AUDIOINV |
| v3:bf0q6yJQ… complete slot, no GCal | Helper confirm phrase + failed-promise hangup skip | BOOKCONFIRM |
| v3:bf0q6yJQ… asked email after phone | Talker had no HAVE/MISSING/NEXT board | SLOTCARD |
| v3:B0f4JV4A… “book a demo” then silence | 5-frame STT gate + leftover AEC far-end | LISTENOPEN |
| v3:4N9a1QsZ… name+phone spoken twice, no write | Watcher missed “use DeSantis”; chopped 9-digit phone → LLM | SLOTHEAR |
| Phone digits chopped; no keypad fallback | Open Whisper + ignored Telnyx DTMF | DTMF |
| Interrupt words dropped | 280ms tripwire wiped pre-roll | BARGEKEEP |
| Half-duplex listen gated whole TTS | Gate closed until play ends | DUPLEX |
| v3:bZtq… name+Tue 12:30 then chop; no phone | Guessed 6s/18s talk cap | PERSONEND (COLLECTPASS) |

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

---
## Nick-authorized restore (2026-09-06)

| Marker | Ship (PT) | Symptom | Root cause | Fix (summary) | State |
|--------|-----------|---------|------------|---------------|-------|
| `VERA_DEMO_SHOP_CHATTERBOX_RESTORE_20260906` | Sep 6 ~5:05pm | Greeting silence (`coqui_xtts`/`en_sample`→Kokoro); 401 `admin_auth_invalid` after control restart | demo-tts forced `kokoro_http`; tenant TTS stale XTTS; Bundle `.env` `ADMIN_API_KEY` ≠ control → compose overwrote `CONTROL_PLANE_API_KEY` | Durable Chatterbox turbo streaming default (`TTS_MODE=chatterbox_http`, `CHATTERBOX_STREAMING=true`); tenant Redis/DB + demo-tts/Bundle/override/effective env; auth key sync | **env+tenant durable** (Nick-authorized TTS restore; feel-pass still gates image bake) |
| `VERA_DEMO_SHOP_QWEN27_20260907` | Sep 7 ~10:20pm | Nano 30B-A3B is ~3B-active; want dense 27B on GPU 1 | Live vLLM was Nano NVFP4 | Deleted GLM-5.2 NVFP4 + ftw + Mixtral stub; serve `Qwen/Qwen3.5-27B-GPTQ-Int4` on `:8082` GPU 1 (text-only, thinking off, 8k ctx). Same container name. Old Nano model name still aliased. | **live vLLM + mount** (feel-pass still gates bake) |
| `VERA_DEMO_SHOP_QWEN3_TTS_20260907` | Sep 7 ~10:53pm | Want fastest non-robot TTS; Chatterbox 0.7–1.3s on DID | GPU 0 leftover + CustomVoice already on disk, unused | Qwen3-TTS 1.7B CustomVoice on GPU 0 (`veralux-qwen3-tts:7010`, local weights). Runtime `TTS_MODE=qwen3_tts_http`, Demo Shop Redis speaker **Serena**, 9-voice selector in `/app`. Greeting synth'd Qwen3 Serena. Chatterbox left loaded unused. | **env+tenant+SPA docker-cp** (feel-pass still gates bake) |
| `VERA_DEMO_SHOP_WRITECONFIRM_20260908` | Sep 8 ~7:50pm | After “just a moment while I confirm”, silence until caller asked if it was booked | Board said brief ack only; `finalizeDemoShopBookedSpeak` only awaits write on booked-claim / “I’m booking”; hold line returned to listen; write succeeded in background | After hold/DTMF ack, await `POST /book` and speak booked (or fail) on the same turn before listen | **mount** (runtime `callSession.js` + `talkerBoard.js`) |

