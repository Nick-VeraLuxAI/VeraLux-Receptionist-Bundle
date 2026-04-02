# Audio quality: product bar, metrics, and SLOs

This document matches the **10/10 product definition** for VeraLux voice: callers rarely hear artifacts; bad lines degrade gracefully (reprompt, no bogus intent); duplicates are rare and **explained in logs/metrics**; drops are not promised away but **measured**; latency is **bounded targets** on a defined profile, not “zero lag.”

## Defined network profile

Tune and validate SLOs on a **fixed** profile so numbers are comparable:

- **Transport:** PSTN via Telnyx (or your production path), same codec profile as prod.
- **Load:** Steady concurrent calls within your expected range (avoid comparing idle vs saturated).
- **Whisper / LLM / TTS:** Same models and regions as production.

Re-run validation after changing codecs, chunk sizes, or provider regions.

## Metrics (Prometheus)

Exported on the runtime **`/metrics`** endpoint (prefix `veralux_voice_runtime_`).

| Metric | Type | Use |
|--------|------|-----|
| `turn_final_accepted_to_first_playback_ms` | histogram | **Turn latency:** final user transcript accepted (post-dedupe) → first `playback.play` for assistant audio. |
| `stage_duration_ms` | histogram | Per-stage breakdown (`stt`, `llm`, `tts`, `telnyx_playback`, `webrtc_playback_ms`, `stt_silence_to_finalize_ms`, `stt_finalize_to_result_ms`, …). |
| `transcript_near_duplicate_suppressed_total` | counter `{match_kind}` | Near-duplicate finals dropped before LLM: `identical`, `substring`, `levenshtein`. |
| `transcript_ignored_after_accept_total` | counter `{source}` | Extra transcript after a final was already accepted (`final`, `partial_fallback`). |
| `media_inbound_seq_gap_frames_total` | counter | Estimated missing inbound media frames from Telnyx sequence jumps. |
| `inbound_audio_frames_total` | counter | Inbound frames counted for ingest (denominator for gap pressure). |
| `unclear_reprompts_total` | counter `{reason}` | Graceful degradation when STT is empty/noisy/short. |

Structured log events (grep / SIEM):

- `transcript_near_duplicate_suppressed` — fields: `duplicate_gate`, `near_duplicate_match_kind`
- `transcript_ignored_duplicate` — fields: `duplicate_gate=utterance_already_accepted`
- `transcript_unclear_filler_or_short` — skipped LLM, reprompt path

## Example PromQL

**P95 turn latency (final accepted → first playback), all tenants:**

```promql
histogram_quantile(
  0.95,
  sum(rate(veralux_voice_runtime_turn_final_accepted_to_first_playback_ms_bucket[5m])) by (le)
)
```

**P95 Whisper HTTP final (per tenant):**

```promql
histogram_quantile(
  0.95,
  sum(rate(veralux_voice_runtime_stage_duration_ms_bucket{stage="stt_whisper_http_final"}[5m])) by (le, tenant)
)
```

**Inbound sequence-gap pressure** (higher = more suspected loss/reordering on the media stream; not a substitute for carrier QoS):

```promql
sum(rate(veralux_voice_runtime_media_inbound_seq_gap_frames_total[5m]))
  /
sum(rate(veralux_voice_runtime_inbound_audio_frames_total[5m]))
```

**Near-duplicate suppression rate** (should stay low; spikes may indicate double endpointing or echo):

```promql
sum(rate(veralux_voice_runtime_transcript_near_duplicate_suppressed_total[5m]))
```

Break down with `sum by (match_kind) (...)`.

## Starting SLO targets (tune per deployment)

Replace with baselines from **your** week of metrics on the profile above:

| SLO | Starting point | Notes |
|-----|----------------|--------|
| Turn latency P95 | **&lt; 3500 ms** | Includes LLM + TTS + telephony handoff; tighten only if stack is consistently faster. |
| Turn latency P99 | **&lt; 8000 ms** |
| STT final P95 | **&lt; 2500 ms** | `stage=stt` or `stt_whisper_http_final`. |
| Seq-gap / frame ratio | **&lt; 0.5%** over 1h steady load | Raise threshold on noisy carriers; alert on **sudden** spikes. |
| Duplicate suppression | Stable low rate | Alert on **step change**, not a fixed tiny number. |

## Validation (listening + artifacts)

1. **WAV dumps** (short-lived in prod): enable per `.env.example` (`STT_DEBUG_*`), reproduce calls, copy from `STT_DEBUG_DIR`.
2. **Scripts:** `scripts/whisper_wav_sweep.py` (repo root) on finals; pairwise hashes for duplicate finals.
3. **Logs:** confirm `near_duplicate_match_kind` and `duplicate_gate` when duplicates are suppressed or ignored.

This is **“everything reasonable for the stack”** evidence for the product bar—not a guarantee of zero packet loss or zero milliseconds latency.
