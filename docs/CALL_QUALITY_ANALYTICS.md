# Call Quality Analytics & Raw Audio Diagnostics

This document describes the **three-level** model for call telemetry on the VeraLux Receptionist platform, how admins configure it, what clients see, and how it relates to engineering audio capture.

## 1. Three levels

### Basic Call Metrics (always on)

- Lightweight per-call metadata: duration, outcome/teardown reason, STT/LLM/TTS timing samples where available, transcript counts, empty transcript rate.
- **No raw WAV** capture at this tier.
- Emitted as **Call Quality** summaries to the control plane when `CONTROL_PLANE_URL` / `CONTROL_PLANE_API_KEY` are set on the voice runtime.

### Call Quality Analytics (tenant / admin configurable)

- When **enabled** (default), the voice runtime builds a **quality summary** per call (derived metrics only) and `POST`s it to the control plane.
- Summaries include latency risk, echo risk, transcript quality, dead-air / barge-in flags, counts such as assistant-echo rejections, and an **audio invariant** scorecard (`audioInvariants` on the stored JSON).
- Audio invariants classify SID / comfort-noise decode ticks (budget) vs product-class fails: stacked Telnyx plays, playback sample rate ≠ 16 kHz AEC tap, speech-decode spikes, large sequence gaps. They **do not** retune AMR-WB decode.
- Hangup also logs `event=audio_invariant_report` with marker `VERA_DEMO_SHOP_AUDIOINV_20260907`.
- **No raw WAV** by default.
- Client portal visibility is controlled with **Show quality summary in client portal** (on by default).

### Raw Audio Diagnostics (super-admin only, temporary)

- Uses the same on-disk pipeline as engineering **audio forensics** (WAVs, `timeline.jsonl`, `manifest.jsonl`, Telnyx payloads, etc.).
- Enabled only from the **admin console** (or equivalent API) with a **required reason** and **required expiration** (`expiresAt` ISO-8601).
- Modes: **Off**, **next call** (one-shot arm), **failed calls** (armed; same one-shot consume behavior as next call in the current implementation — see implementation report), **temporary all calls** until `expiresAt`.
- After the voice runtime starts a **next-call** or **failed-calls** armed capture, it calls the control plane to **clear the arm** and republish Redis so the next call does not accidentally capture again.
- **Warning:** Raw diagnostics may capture **caller voice** and sensitive content. Disable after troubleshooting.

## 2. Engineering env override (`AUDIO_FORENSICS_*`)

- `AUDIO_FORENSICS_ENABLED=true` on the **voice runtime** remains an **emergency / operator** override.
- When active, the runtime logs **operator override active** and captures **regardless** of tenant Redis policy.
- This is **not** the normal product workflow; prefer **Raw Audio Diagnostics** from the control plane so actions are **tenant-scoped, audited, and expiring**.

## 3. Admin usage

1. Select the business in the admin console.
2. Open the **Call Quality** tab.
3. Toggle **Call Quality Analytics**, transcript storage, retention days, and client summary visibility; click **Save settings** (tenant owners with JWT admin can change these fields only).
4. For **Raw Audio Diagnostics**, use **Reason** + **Expiration**, choose a **Mode**, then **POST enable**. Use **POST disable** when finished.
5. **Publish to voice runtime** (existing flow) so Redis `tenantcfg:<tenantId>` includes the latest `callQuality` block.

## 4. Client portal visibility

- If **Show quality summary in client portal** is on, owners may see high-level labels (e.g. Good / Needs review / Poor, transcript quality, AI response delay, coarse “issue detected” tags).
- Owners **never** receive raw WAV paths, forensic timelines, provider URLs, stack traces, or JSON dumps from this feature.
- If **Store transcripts** is off, the API returns a clear message: *“Transcripts are disabled for this business.”*
- Optional: store `voiceCallControlId` on workflow `lead` to attach summaries to a specific owner-portal call row (otherwise use `GET /api/owner/call-quality-summary/:callControlId` when the id is known).

## 5. Privacy & retention

| Artifact | Retention guidance |
|----------|---------------------|
| **Quality summaries** (Postgres `call_quality_summaries`) | Longer retention is acceptable; contains derived metrics only. |
| **Transcripts** | Honor `transcriptRetentionDays` (tenant setting) for transcript storage features elsewhere. |
| **Raw diagnostics** (disk under `AUDIO_FORENSICS_DIR`) | Short-lived; use **expiration** and `scripts/cleanup-call-quality-artifacts.sh` (`--dry-run` supported) to prune old session trees. Never delete active calls. |

## 6. Troubleshooting workflow

1. Confirm **Call Quality Analytics** is on and a summary row exists for the `call_control_id` (control plane DB).
2. If echo or latency issues persist, arm **Raw Audio Diagnostics** for **one call**, reproduce, collect the session folder, then **disable** and run cleanup.
3. If the runtime ignores tenant policy, check for **`AUDIO_FORENSICS_ENABLED`** operator override in container env.

## 7. Recommended pilot defaults

- **Call Quality Analytics:** on  
- **Store transcripts:** on (unless a customer forbids storage)  
- **Transcript retention:** 30 days  
- **Client summary:** on  
- **Raw Audio Diagnostics:** off unless actively investigating  
- **Raw artifacts visible to client:** always **false** (super-admin only if ever needed)
