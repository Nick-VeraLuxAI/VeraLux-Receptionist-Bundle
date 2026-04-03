# Chatterbox-Turbo TTS — request flow and pooled workers

## How requests flow today (voice runtime → container)

1. **`CallSession.playText` / `synthesizeSpeech`** (`veralux-voice-runtime`) calls `synthesizeSpeechChatterbox` with tenant `chatterboxUrl`, `text`, optional `speakerWavUrl` (`chatterboxTTS.ts`).
2. **HTTP `POST /tts`** to `CHATTERBOX_URL` (e.g. `http://chatterbox:7005/tts`) with JSON `{ text, speaker_wav_url?, language_id? }`.
3. **Gunicorn** accepts the connection and assigns it to a **worker process** (see `CHATTERBOX_GUNICORN_WORKERS`). Each worker is an independent **lane**: its own Python process, own **ChatterboxTurboTTS** model on GPU, own `asyncio.Semaphore(1)` so **only one synthesis at a time per worker** (model is not thread-safe).
4. Worker may **download** `speaker_wav_url` to a temp file (or use `CHATTERBOX_DEFAULT_AUDIO_PROMPT` for Turbo).
5. **`model.generate(text, audio_prompt_path=...)`** runs in a thread pool; returns a full tensor → encoded as **one WAV** in the HTTP response.

**Implication:** True **multi-lane concurrency** = **multiple Gunicorn workers** (each loads a full model copy → VRAM × workers). There is no shared in-process queue across workers; the OS/Gunicorn master **distributes connections** across workers.

## Optional streaming (`POST /tts/stream`)

Turbo’s `generate()` returns a **full utterance tensor**, not token-by-token audio. Streaming is implemented as **sentence-chunked synthesis**: split text, generate one WAV per segment, stream **framed chunks** (`VLX1` binary protocol) so the client can measure **time to first chunk** and merge segments into one WAV for PSTN playback.

**Wire format:** body starts with ASCII `VLX1`, then for each segment `u32` big-endian length + raw WAV bytes. The voice runtime can set **`CHATTERBOX_STREAMING=true`** (turbo only) to call `/tts/stream` and merge via `mergeCompatibleWavBuffers`.

## Observability

- **`POST /tts` response headers:** `X-TTS-Worker-Pid`, `X-TTS-Queue-Wait-Ms`, `X-TTS-Synthesize-Ms`, `X-TTS-Total-Ms`, `X-TTS-Request-Id` (echoes `X-Request-Id` when sent).
- **Structured logs** (JSON-ish dict in message): `chatterbox_tts` events `lane_acquired`, `synthesize_done`; stream: `stream_lane_acquired`, `stream_first_chunk` (includes `time_to_first_chunk_ms`), `stream_done`.
- **`POST /tts/stream` headers:** `X-TTS-Stream-Segments`, `X-TTS-Worker-Pid`, `X-TTS-Request-Id`.
- **Body field `priority`:** logged only; cross-worker priority needs a future central queue (e.g. Redis).

## Voice preload / warmup

- **Warmup:** optional tiny `generate()` after model load to pay CUDA compile cost once per worker (`CHATTERBOX_CUDA_WARMUP`).
- **Speaker cache:** repeated `speaker_wav_url` downloads are cached on disk by URL hash (`CHATTERBOX_SPEAKER_CACHE_DIR`).

## Future: multi-GPU

Set **`CHATTERBOX_GPU_IDS`** per replica or run **multiple compose services** on different GPUs (different ports), fronted by nginx upstream. This repo keeps a **single** `chatterbox` hostname; scaling out is an ops concern.
