# Audio & transcript forensics (VeraLux voice runtime)

Opt-in per-call capture for debugging **where** inbound audio, STT, LLM, TTS, or Telnyx playback diverge. **Default is off.** Do not enable in production without an explicit operational reason and `ALLOW_PROD_DEBUG_CAPTURE=true` (the runtime enforces this guard).

## Product vs engineering forensics

- **Call Quality Analytics** (control plane + Postgres): stores **derived** per-call metrics and quality summaries **without** raw WAV capture by default. This is the normal admin workflow.
- **Raw Audio Diagnostics** (super-admin in control plane): temporary tenant-scoped capture that uses the **same** forensics pipeline as engineering mode, with reason and expiration recorded in `manifest.jsonl`.
- **`AUDIO_FORENSICS_*` env flags** remain the **emergency / operator override** on the voice runtime host. When `AUDIO_FORENSICS_ENABLED=true`, the runtime logs **operator override active** and captures regardless of tenant Redis policy. This is **not** the normal admin path; prefer Raw Audio Diagnostics from the admin console so policy stays tenant-scoped and audited.

See [CALL_QUALITY_ANALYTICS.md](./CALL_QUALITY_ANALYTICS.md) for the full model (basic metrics vs analytics vs raw diagnostics), retention, and client visibility.

## Enable

Set in the voice runtime environment (e.g. `veralux-voice-runtime/.env` or your process manager):

| Variable | Default | Purpose |
|----------|---------|---------|
| `AUDIO_FORENSICS_ENABLED` | `false` | Master switch. When `true`, creates a session directory per `call_control_id`. |
| `AUDIO_FORENSICS_DIR` | `/data/veralux/voice/forensics` | Root directory for call folders. |
| `AUDIO_FORENSICS_ALLOW_PII` | `false` | When `false`, JSON artifacts redact transcript-like fields and inline secrets; `.txt` LLM paths use inline PII redaction only. |
| `AUDIO_FORENSICS_MAX_EMIT_FRAMES` | `400` | Cap for `003_emit_frame_*.wav` and `004_session_stt_input_*.wav` per call (timeline still records). |

Related STT / alignment toggles (see `veralux-voice-runtime/src/env.ts`):

- `STT_CAPTURE_DURING_POST_PLAYBACK_GRACE` — buffer PCM during post-playback grace, replay after grace (default `false`).
- `STT_PLAYBACK_GRACE_BUFFER_MAX_MS` — max buffered ms for that path (default `1000`).
- `STT_USE_AUDIO_CLOCK_FOR_MEDIA_GAPS` — alternate media-gap heuristic in `CallAudioCoordinator` plus `media_gap_compare` timeline rows (default `false`).

### Assistant echo suppression (runtime)

When Whisper returns text that matches recent assistant/TTS lines, the runtime can reject the final before the LLM (`assistant_echo`). Forensics: timeline `transcript_rejected_assistant_echo`, and `008_transcript_policy_*.json` with `reason: assistant_echo` when enabled.

| Variable | Default | Notes |
|----------|---------|--------|
| `STT_ECHO_SUPPRESSION_MODE` | `balanced` | `permissive` = legacy: post-playback grace does not gate STT once `LISTENING`. `conservative` / `balanced` = gate for full grace after playback ends (reduces TTS→STT echo). |
| `STT_POST_PLAYBACK_ECHO_TAIL_MS` | `450` | After grace-buffer flush, first N ms of replayed audio: drop frames below echo-tail energy threshold. |
| `STT_ECHO_POST_PLAYBACK_RMS_MULT_*` | 1.75 / 1.28 / 1.05 | Multiply effective RMS/peak floor during that tail per mode. |

Recommended for noisy PSTN echo trials (adjust in your env, not defaults in code): `STT_ECHO_SUPPRESSION_MODE=conservative`, longer `STT_POST_PLAYBACK_GRACE_*`, `STT_CAPTURE_DURING_POST_PLAYBACK_GRACE=true`, larger `STT_PLAYBACK_GRACE_BUFFER_MAX_MS`.

## Directory layout

For each call, when enabled:

```text
{AUDIO_FORENSICS_DIR}/{callControlId}/{ISO-like-timestamp}/
  manifest.jsonl
  timeline.jsonl
  audio/
    001_raw_telnyx_*.bin
    002_decoded_pcm_*.wav
    003_emit_frame_*.wav
    004_session_stt_input_*.wav
    005_whisper_request_{utteranceId}.wav   # exact bytes sent to Whisper
  transcripts/
    006_whisper_response_{utteranceId}.json
    007a_whisper_text_{utteranceId}.txt
    007_normalized_transcript_{utteranceId}.txt
    008_transcript_policy_*.json
  llm/
    009_llm_request_{turnId}.json
    009_transcript_to_llm_{turnId}.txt
    010_llm_response_{turnId}.txt
    010_llm_response_meta_{turnId}.json
  tts/
    011_tts_request_*.json
    012_tts_raw_*.{wav|bin}
  playback/
    013_telnyx_playback_*.wav
    014_playback_events_{turnId}.jsonl
```

## One-command test call (watch + analyze)

From the **repository root** (or any directory that contains `scripts/live-call-test-watch.sh` when resolved upward), use:

```bash
./scripts/run-voice-test-call.sh
```

This script **does not** change STT/TTS/audio logic. It **does not** copy `.env` into bundles (the underlying watcher avoids that). Health responses are checked but **not** echoed in full (no secret dump).

**What it does**

1. Preflight: `docker`, `veralux-runtime` up, `scripts/live-call-test-watch.sh` + `scripts/analyze-audio-forensics.sh` present, `curl` to `http://localhost:4001/health` and `/health/voice`, and a short read-only dump of safe runtime env keys from the container (`AUDIO_FORENSICS_*`, `STT_ECHO_SUPPRESSION_MODE`, `STT_POST_PLAYBACK_GRACE_MS`, `STT_CAPTURE_DURING_POST_PLAYBACK_GRACE`). URLs are redacted to host-only / length.
2. Runs `live-call-test-watch.sh` for `--duration` seconds per call (captures logs + copies the latest forensics session under the run directory).
3. Runs `analyze-audio-forensics.sh` on the copied session folder.
4. Writes `COMBINED_TEST_SUMMARY.md` under the run directory when `--calls` > 1 (also written for a single call).
5. Prints a **COPY/PASTE FOR CURSOR ANALYSIS** block with absolute paths to each call’s `analysis/` folder and the combined summary.

**Examples**

```bash
./scripts/run-voice-test-call.sh --duration 240 --label echo-test
./scripts/run-voice-test-call.sh --calls 3 --duration 180 --label regression
./scripts/run-voice-test-call.sh --out /tmp/veralux-live-tests --call-id 'v3:YOUR_CALL_CONTROL_ID'
./scripts/run-voice-test-call.sh --dry-run
./scripts/run-voice-test-call.sh --calls 2 --no-prompt
```

**Flags**

| Flag | Purpose |
|------|---------|
| `--duration SEC` | Watcher window (default 180) |
| `--label SLUG` | Names the run directory (default `voice-test`) |
| `--calls N` | Run N sequential calls; between calls, prompts unless `--no-prompt` |
| `--out DIR` | Base directory (default `/tmp/veralux-live-tests`) |
| `--call-id ID` | Forwarded to the watcher to pick a specific forensics subtree |
| `--dry-run` | Preflight only; no watcher or analyzer |
| `--enable-forensics` | If forensics is off: `sudo` appends a minimal safe block to `VERALUX_VOICE_ENV_FILE` (default `/etc/veralux/voice-runtime.env`) and runs `start-production.sh`. **Requires sudo and a production-style host**; skip on pure dev laptops without that file. |
| `--allow-old-session` | Allow analyzing a forensics session whose embedded folder time is **before** the call-window start (default is to reject stale sessions). |
| `--debug-session-selection` | Print candidate `timeline.jsonl` paths, sort keys, and the chosen session (stderr). |

Session selection uses `scripts/lib/select_forensics_session.py`: prefers timestamps parsed from session folder names (e.g. `2026-05-09T05-08-51-437Z`), then `timeline.jsonl` mtime. It does **not** pick the lexicographically last path. By default, sessions older than the watcher start time (UTC, with a small skew buffer) are excluded so multi-call runs do not reuse an old bundle.

**Layout**

```text
/tmp/veralux-live-tests/<UTC_TS>-<label>/
  call-1/
    <watcher_ts>/          # created by live-call-test-watch.sh
      forensics_copy/...
    preflight_health_call-1.json
  call-2/...
  call_meta.jsonl
  COMBINED_TEST_SUMMARY.md
```

**Handing results to Cursor**

After the script finishes, copy the printed block **COPY/PASTE FOR CURSOR ANALYSIS**. Optionally add a manual `analysis/HUMAN_DIAGNOSIS.md` under a call folder if you maintain that report.

**Cleanup**

Remove run trees under `/tmp/veralux-live-tests/` when done. Inside the container, old sessions remain under `AUDIO_FORENSICS_DIR` until you delete them.

## Inspect a call

1. Locate the folder under `AUDIO_FORENSICS_DIR` for the Telnyx `call_control_id` and the run timestamp.
2. Open `timeline.jsonl` — one JSON object per line; filter by `event` (`playback_gate_active`, `frame_dropped_by_playback_gate`, `whisper_request_sent`, `transcript_accepted`, etc.).
3. Compare **bytes**: raw Telnyx payload (`001`) → decoded (`002`) → emitted frame (`003`) → post-headroom/AEC STT input (`004`) → Whisper request (`005`).
4. Compare **text**: Whisper raw/normalized (`007*`, `006`) vs transcript sent to the LLM (`llm/009_transcript_to_llm_*.txt` and redacted `009_llm_request_*.json`).
5. Compare **playback**: TTS raw (`012`), telephony-optimized WAV sent toward Telnyx (`013`), and `014_playback_events_*.jsonl`.

## Pack a call for support

From the repo root:

```bash
./scripts/collect-audio-forensics.sh <callControlId> [AUDIO_FORENSICS_DIR]
```

Produces a zip under `/tmp` (or override with the script’s printed path) and **does not** include `.env` files.

## Disable & cleanup

1. Set `AUDIO_FORENSICS_ENABLED=false` and restart the runtime.
2. Remove old trees under `AUDIO_FORENSICS_DIR` when no longer needed (`rm -rf` the call id or timestamp subfolders).

## Tests

- `veralux-voice-runtime/tests/audioForensics.test.ts` — WAV helper, disabled path, subprocess enabled path with redaction checks.
- Run: `npm test -w veralux-voice-runtime` (or `cd veralux-voice-runtime && npm test`).
