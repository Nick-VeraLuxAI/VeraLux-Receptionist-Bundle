# Telnyx + local voice (ownership, not beauty)

VeraLux sells a **completed night desk**, not a prettier voice. ElevenLabs stays optional TTS. This page is the leave-behind for the $5k / $2k white-glove offer.

## Telephony

| Mode | Who holds the Telnyx key | When to use |
|---|---|---|
| Platform Telnyx | VeraLux | Fastest cutover. We own the connection, DID, and SMS from-number. |
| Tenant-owned Telnyx | Shop / franchise | Cost control and portability. Staff store the encrypted API key, connection ID, sending number, and webhook public key. Owner never pastes raw provider URLs. |

Failover: if a tenant key is missing, the runtime keeps using the platform key. When configured, call-control commands and SMS use the tenant key while webhook signatures use that tenant account's Ed25519 public key.

## Speech stack

| Slot | Owned / local | Cloud fallback |
|---|---|---|
| STT | Whisper HTTP on the shop or VeraLux GPU | Deepgram, OpenAI Whisper (named presets only) |
| TTS | Kokoro / Miso / Chatterbox / Qwen3 | ElevenLabs (optional beauty, never the pitch) |
| LLM | On-prem Nemotron when the host can run it | Tenant BYOK routed by Pipeline |

The owner portal **Owned voice stack** picker writes `stt.mode` only (`whisper_http` · `deepgram` · `openai_whisper`). Raw STT/TTS URLs stay staff-only.

## COGS pointer

Use the Pipeline estimator (`/admin/pipeline`) for per-minute STT/TTS/LLM cost. Local Whisper + Kokoro is the default Inland NW margin story. Cloud STT is a burst valve, not the product.

## What this is not

Not a 24/7 headline. Not Reception.ai resale. Not a language-count war. The demo proof is: refuse out-of-area, page gas, hold a big quote, Jobber job before hang-up, 7am digest.
