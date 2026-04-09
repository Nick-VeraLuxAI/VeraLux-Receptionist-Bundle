# First boot — what to expect

This matches **root `docker-compose.yml`**, **`deploy.sh`**, and **`HEALTH_MODEL.md`**.

---

## 1. Order of readiness (typical)

1. **Postgres** — `pg_isready` healthcheck (often under 1–2 minutes).
2. **Redis** — `PING` (seconds after start).
3. **Control** — waits on Postgres; entrypoint runs **DB migrations** then starts Node; Docker health uses **`GET /ready`** (DB + Redis checks). Can take **~1–2 min** after Postgres is healthy.
4. **Runtime** — depends on Redis + control healthy; Docker health uses **`GET /health/ready`** (Redis + Whisper + TTS HTTP when **`HEALTH_VOICE_DEPENDENCIES=true`**). **This is often the slowest step on first boot** because Whisper/TTS containers load models.
5. **Audio containers** (profile **gpu** or **cpu**) — Compose **`start_period`** is **large** (e.g. **120s–900s** depending on service) so probes do not fail during model load.
6. **Tunnels** (if used) — start after runtime/control are healthy (`depends_on` in compose).

---

## 2. Model loading (why “unhealthy” or “starting” is normal)

| Service | First-boot behavior |
|---------|---------------------|
| **Whisper** (GPU) | Up to **~5+ minutes** before **`/health`** OK is allowed by compose **`start_period`** (300s) + retries. |
| **Whisper** (CPU) | Similar idea; **`start_period`** 120s+ — cold load can exceed that on weak hosts. |
| **XTTS / Kokoro / Chatterbox / Qwen3-TTS** | Large **`start_period`** values in compose; **Chatterbox/Qwen3** may download weights (needs **`HF_TOKEN`** when required). |
| **Runtime** | Stays not-ready until its readiness probe can reach **Redis** and **Whisper + TTS** URLs derived from **`.env`**. |

**Not a bug:** `docker compose ps` showing **starting** for audio or runtime for many minutes after a fresh pull.

**Action:** `./deploy.sh logs` on the slow service; wait; confirm **`./scripts/healthcheck.sh`** when probes eventually pass.

---

## 3. What “healthy” means here

| Check | Meaning |
|-------|---------|
| Docker **`healthy`** on **control** | **`GET /ready`** passed: DB (+ Redis per control config). |
| Docker **`healthy`** on **runtime** | **`GET /health/ready`** passed: voice deps + Redis (unless **`HEALTH_VOICE_DEPENDENCIES=false`**). |
| **`./scripts/healthcheck.sh`** (default) | Same readiness URLs on **host** ports + optional brain + Docker **unhealthy** scan. |

**Does not prove:** Telnyx can reach your URLs, DNS is correct, or a specific DID is routed — only that containers passed their HTTP/Redis checks.

---

## 4. What is automated vs manual

| Automated by `./up` / `./deploy.sh up` | Manual (operator) |
|----------------------------------------|-------------------|
| Preflight (`preflight.sh`) | Telnyx connection, webhook URL, DID purchase/routing |
| Pull images (best-effort ignore failures on **`up`**; stricter on **`update`**) | Public DNS A/AAAA, TLS if not using tunnel |
| Start **postgres**, **redis**, **control**, **runtime**, audio profile services | **`ADMIN_ALLOWED_ORIGINS`**, **`BASE_URL`** correctness for your real hostname |
| Run DB migrations (control entrypoint) | First tenant / business setup in admin UI |
| Optional **cloudflared** if token set | Stripe, SMTP, custom **`docker-compose.override.yml`** |

---

## 5. Copy/paste status

```bash
./deploy.sh status
./deploy.sh versions
docker inspect --format '{{.Name}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-health{{end}}' \
  veralux-postgres veralux-redis veralux-control veralux-runtime veralux-whisper 2>/dev/null
```

Replace **`veralux-whisper`** if your STT container name differs (same name for gpu/cpu profiles).

---

## 6. After everything is “healthy”

- First **real call** may still be slower (GPU warmup, caches).
- Use **`TROUBLESHOOTING_DEPLOY.md`** if readiness never succeeds after **30+ minutes** with no progress in logs.
