# Troubleshooting (deploy / runtime)

**Assumption:** You use **`./up`** or **`./deploy.sh up`** from the repo root. Commands below are copy-paste from that directory.

---

## Preflight fails (before any container starts)

```bash
./scripts/preflight.sh
```

| Symptom | Fix |
|---------|-----|
| Missing `.env` | `cp .env.example .env` and fill keys (**`QUICKSTART.md`**). |
| `docker compose config` errors | Fix `.env` / `.env.internal` syntax; unset empty required vars. |
| GPU / `TTS_MODE` mismatch | **`chatterbox_http`** requires NVIDIA + **gpu** profile (**`DEPLOYMENT_CONTRACT.md`**). |
| Port in use | Change **`CONTROL_PORT`** / **`RUNTIME_PORT`** in `.env` or free the port. |

Details: **`PRECHECKS.md`**.

---

## Containers exit or restart loop

```bash
./deploy.sh logs control
./deploy.sh logs runtime
./deploy.sh logs postgres
```

| Symptom | Fix |
|---------|-----|
| Control: `ADMIN_API_KEY` missing in production | Set in `.env`; restart control. |
| Postgres: auth failed | `.env` **`POSTGRES_*`** must match **existing** volume first init; or reset volume (data loss) — **`PERSISTENCE_CONTRACT.md`**. |
| Runtime: Zod/env validation | Fix **`.env`** combinations (**`veralux-voice-runtime`** logs show field names). |

---

## `healthcheck.sh` fails

```bash
./scripts/healthcheck.sh
curl -sS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${CONTROL_PORT:-4000}/ready"
curl -sS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${RUNTIME_PORT:-4001}/health/ready"
```

| HTTP code | Likely cause |
|-----------|----------------|
| **503** on **`/ready`** | Postgres or Redis down from control’s perspective. |
| **503** on **`/health/ready`** | Redis down, or Whisper/TTS URL not reachable (**`HEALTH_MODEL.md`**). |
| **000** / connection refused | Container not listening; wrong **ports** in `.env` vs compose. |

**Temporary redis-only readiness (tests only):** **`HEALTH_VOICE_DEPENDENCIES=false`** on runtime — **not** for production voice.

---

## Runtime healthy but no audio / STT

```bash
curl -sS "http://127.0.0.1:${WHISPER_PORT:-9000}/health" | head
docker logs veralux-whisper 2>&1 | tail -80
```

| Symptom | Fix |
|---------|-----|
| Whisper not running | You used plain **`docker compose up`** without **gpu/cpu** profile — use **`./up`**. |
| 502 / timeout to Whisper | Model still loading — wait (**`FIRST_BOOT_EXPECTATIONS.md`**). |
| Chatterbox/Qwen3 401 / download fail | Set **`HF_TOKEN`** in `.env`; accept model license on Hugging Face. |

---

## Telnyx / webhooks (not diagnosed by container health)

| Symptom | Check |
|---------|--------|
| No webhook hits | **`PUBLIC_BASE_URL`** must be **HTTPS** and reachable from internet; firewall/tunnel must forward to **runtime** host port. |
| Signature errors | **`TELNYX_PUBLIC_KEY`**, **`TELNYX_VERIFY_SIGNATURES`**; runtime logs. |
| Media stream fails | **`MEDIA_STREAM_TOKEN`**, **`AUDIO_PUBLIC_BASE_URL`**, TLS on audio URL. |

**Automated:** none of the above — configure in **Telnyx portal** + **`.env`**.

---

## Cloudflare tunnel

```bash
docker logs veralux-cloudflared 2>&1 | tail -50
```

| Symptom | Fix |
|---------|-----|
| Tunnel not running | Set **`CLOUDFLARE_TUNNEL_TOKEN`**; run **`./up`** again or **`./deploy.sh tunnel cloudflare`**. |
| Error 1033 / wrong route | Tunnel config in Cloudflare dashboard must match your public hostname → origin. |

---

## Database backup / restore

```bash
./deploy.sh backup
./deploy.sh restore ./backups/veralux_<timestamp>.sql.gz
```

Restore **does not** fix Redis/audio volumes — see **`BACKUP_RESTORE.md`**.

---

## Still stuck

1. **`./deploy.sh versions`** — confirm image tags match **`VERSION`**.  
2. **`HEALTH_MODEL.md`** — readiness vs liveness.  
3. **`UNSUPPORTED_PATTERNS.md`** — confirm you are not running two stacks or wrong compose file.
