# Unsupported deployment patterns

If a pattern appears here, it is **not** covered by **`DEPLOYMENT_CONTRACT.md`**. Support and correctness are **not** guaranteed.

---

## Compose topology

1. **Using any Compose file other than the repository root `docker-compose.yml` as the production stack** — including but not limited to:
   - `control-plane/docker-compose.yml`
   - `veralux-audio-stack/docker-compose.yml`
   - `veralux-audio-stack/docker-compose.gpu.yml`
   - A `docker-compose.yml` referenced only under `veralux-voice-runtime/docs/`

2. **Running two in-contract stacks on the same Docker engine** — fixed `container_name` values (`veralux-control`, `veralux-postgres`, etc.) collide.

3. **Changing Compose project name** for the production stack without forking `deploy.sh` — `deploy.sh` hardcodes `-p veralux`; scripts and docs assume container names above.

4. **Replacing `./up` / `./deploy.sh up` with raw `docker compose up -d`** as the standard operating procedure — audio services require `--profile gpu` or `--profile cpu` under the same rules as `deploy.sh detect_audio_profile`. Manual compose invocations that omit those profiles are unsupported for voice.

5. **Relying on default `docker compose up` with no profiles** when `TTS_MODE` is one of `coqui_xtts`, `kokoro_http`, `qwen3_tts_http`, or `chatterbox_http` — Whisper/XTTS/Kokoro/Qwen will not start; voice will fail.

---

## Voice / audio configuration

6. **`TTS_MODE=chatterbox_http` on a host where `./deploy.sh` selects `--profile cpu`** — there is no `chatterbox-cpu` service in `docker-compose.yml`; only `chatterbox-gpu` exists.

7. **Any `TTS_MODE` value not handled by `deploy.sh` `detect_audio_profile`** for a deployment that must perform STT/TTS — if `TTS_MODE` is not one of `coqui_xtts`, `kokoro_http`, `qwen3_tts_http`, `chatterbox_http`, the script passes **no** audio profile; no Whisper/TTS containers start.

8. **Expecting Chatterbox or Qwen3 images to start without acceptable Hugging Face access** when those services need gated models — failures occur inside containers; not a supported “air-gapped Chatterbox/Qwen without prep” scenario unless you provide images and assets that do not need downloads.

---

## Platform and packaging

9. **Electron or desktop-native installer** as the delivery mechanism for this bundle — not defined in this repo’s contract.

10. **Kubernetes / Swarm / Nomad manifests** in this repository as the supported deployment path — not provided; operators may wrap Compose-derived images at their own risk.

11. **Windows containers** — Dockerfiles and scripts target Linux images and shell tooling.

---

## Security and networking

12. **Production Telnyx webhook signature verification disabled** (`TELNYX_VERIFY_SIGNATURES=false` or runtime equivalents) — may be technically possible via env; not endorsed as a supported production pattern.

13. **Serving admin UI or runtime on unintended origins** without aligning `ADMIN_ALLOWED_ORIGINS`, `BASE_URL`, and public URLs — unsupported as a “works everywhere” configuration; operators must set URLs explicitly.

---

## Data and state

14. **Treating Redis or audio volume backups as part of the contracted automated backup** — only PostgreSQL via `./scripts/backup.sh` / `./deploy.sh backup` is run by repo automation. Optional operator procedures for other volumes are documented in **`BACKUP_RESTORE.md`** (not invoked by `./deploy.sh backup`).

15. **Editing Redis keys or Postgres schema by hand** for routine tenant changes — tenant behavior belongs in the control plane UI/API and migrations, not ad-hoc DBA edits, for supportability.

---

## Scripts and tooling

16. **`install.sh` as the ongoing orchestration tool** — bootstrap only; contract lifecycle is `./deploy.sh`.

17. **Relying on `install.sh` online login** without pinning your own **`INSTALLER_CONFIG_API_URL`** for enterprise or air-gapped guarantees** — the default URL is an external vendor service; not part of the self-contained Compose contract. Use offline mode or your own installer API (**`CUSTOMER_CONFIG_SURFACE.md`**).

18. **Expecting `scripts/backup.sh` to parse arbitrary `.env` syntax** — implementation uses `grep` + `xargs`; complex quoting in `.env` may break credential export; unsupported to rely on exotic `.env` encodings without fixing the script.

---

## Optional profiles without full configuration

19. **`--profile llm` (vLLM + brain) without setting runtime `BRAIN_URL` and validating GPU/memory** — services may run but calls will not use the local brain as intended.

20. **Tunnel profiles without valid tokens** — `cloudflared` / `ngrok` will fail; unsupported to assume tunnels come up without operator-supplied credentials.

---

## Documentation exceptions

Patterns described only in subpackage READMEs (e.g. “compose up Redis only” under `veralux-voice-runtime`) are **development shortcuts**, not the production contract unless explicitly merged into `DEPLOYMENT_CONTRACT.md`.
