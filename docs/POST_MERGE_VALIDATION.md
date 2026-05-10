# Post-merge validation (VeraTitan / `/opt`)

Run these steps **after** merging to `main` (or your release branch) **and** syncing the same revision to **`/opt/veralux/veralux-voice-runtime`** (rsync, pull, or your standard image deploy). This confirms the **deployed** tree matches what was validated in CI.

**Do not** paste secrets, tokens, or full env files into tickets or chat.

---

## 1. Production bring-up

```bash
cd /opt/veralux/veralux-voice-runtime

sudo -E VERALUX_VOICE_ENV_FILE=/etc/veralux/voice-runtime.env \
  ./scripts/start-production.sh
```

**Expected:** Script completes without fatal errors; topology validation phase succeeds; core + audio containers reach **healthy** where applicable.

---

## 2. Runtime HTTP checks (non-secret)

Truncated JSON is enough for logs; avoid pasting full payloads if they ever include operator-only fields.

```bash
curl -sS http://localhost:4001/health | head -c 2000 && echo
curl -sS http://localhost:4001/health/voice | head -c 2000 && echo
```

**Expected:**

- **`/health`:** overall healthy status; Redis / voice-related checks **ok** for local-gpu.
- **`/health/voice`:** **`status` ok** with Redis, Whisper, and TTS checks **ok** when using local GPU + bundled services.

---

## 3. Container presence

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -Ei "veralux-runtime|veralux-control|veralux-postgres|veralux-redis|veralux-whisper|veralux-chatterbox"
```

**Expected:** `veralux-runtime`, `veralux-control`, `veralux-postgres`, `veralux-redis`, `veralux-whisper`, `veralux-chatterbox` show **Up** (and **healthy** if healthcheck is configured).

---

## 4. Optional profile scripts (from repo root on a dev clone, or same tree if synced)

```bash
cd /path/to/VeraLux-Receptionist-Bundle   # or /opt if monorepo layout matches

./scripts/preflight-profile.sh --profile local-gpu --env-file /etc/veralux/voice-runtime.env
./scripts/validate-profile.sh --profile local-gpu --env-file /etc/veralux/voice-runtime.env
```

**Expected:** Preflight **PASS** (bundled Compose **`redis`** accepted when `REDIS_URL` is absent from the voice file alone); validate **PASS** when services are up.

---

## 5. If something fails

Capture **only**: command, exit code, and a **redacted** error line (no API keys, no `DATABASE_URL`, no webhook secrets). Open a ticket referencing the **git SHA** deployed on `/opt`.
