# Hybrid deployment profile (`hybrid`)

**Intent:** **Control plane** (and often **Postgres**) run in the **cloud**, while **voice runtime** and/or **GPU-backed STT/TTS/LLM** run on a **dedicated GPU machine** (on-prem, colo, or GPU VPS). **Telnyx** continues to hit **public URLs** that terminate on the component that owns call state — typically the **runtime** for webhooks and media.

---

## Reference patterns

### Pattern A — Runtime on GPU host (common for latency)

- **GPU host:** Docker Compose or systemd runs **runtime + Redis (optional local) + Whisper + TTS** (+ optional brain/vLLM).
- **Cloud:** **Control plane + Postgres**; runtime uses **`CONTROL_PLANE_URL`** / **`CONTROL_URL`** to sync tenant config, analytics, workflows (see existing `CONTROL_PLANE_*` env in `veralux-voice-runtime/src/env.ts`).
- **Requirement:** Runtime must reach **cloud Postgres** only if you colocate DB-dependent features there — today **runtime** primarily needs **Redis** + **HTTP control**; **Postgres** is control-plane’s domain.

### Pattern B — Runtime in cloud, STT/TTS on GPU over private network

- **Cloud:** `control`, `runtime`, `redis`, `postgres`.
- **GPU box:** Only **Whisper + TTS** HTTP services, **no** inbound from public internet except via **VPN / WireGuard / Tailscale** or **mTLS**-terminated reverse proxy.
- **Env:** `WHISPER_URL=https://gpu-private.example/transcribe`, `KOKORO_URL` / etc. point through **private DNS**.

**Risk:** Cloud runtime → GPU **egress** must be **low latency** (< ~50–100 ms RTT) for acceptable PSTN turn-taking; **cross-region** is painful.

---

## Webhook and media routing (Telnyx)

- **Call control webhooks** target **`PUBLIC_BASE_URL`** on the **runtime** (or unified ingress that forwards to runtime — see your current Telnyx app config).
- **Media WebSocket** uses **`MEDIA_STREAM_TOKEN`** and paths under **`/v1/telnyx/media/...`** on the same runtime host users dial into.
- **Hybrid gotcha:** If you split **HTTP** and **WebSocket** across different hosts without a compatible **sticky / unified** ingress, Telnyx app config must match **exact** URLs.

**Cloudflare:** Production docs recommend **systemd `cloudflared`** with static config (`PRODUCTION_TOPOLOGY.md`). Hybrid is easier when **one tunnel or LB** fronts **`PUBLIC_BASE_URL`** and WS.

---

## Secure API routing (control ↔ runtime)

- **Runtime → control:** `CONTROL_PLANE_URL`, `CONTROL_PLANE_API_KEY` (or `VOICE_CONTROL_API_KEY` on runtime for protected voice routes).
- **Control → runtime:** `VOICE_RUNTIME_URL` (control-plane `.env.example`) for features that call runtime; ensure **TLS** and **IP allow lists** if exposed.

**No built-in “GPU worker registration” queue** — scaling is **horizontal runtime instances** + shared **Redis**, not automatic GPU job scheduling.

---

## Redis placement

- **Tenantcfg / tenantmap / capacity** live in Redis consumed by **runtime**.
- If runtime is **only** on GPU host, **Redis should be reachable** from that host (same compose network, VPC, or managed Redis with ACL).

---

## Health checks in hybrid

- Runtime **`/health/voice`** will HTTP GET **GPU-side** `/health` for Whisper/TTS — ensure **network path** from runtime container to GPU URLs is allowed by firewall.
- If GPU `/health` is **not** exposed to cloud, set **`HEALTH_VOICE_DEPENDENCIES=false`** on cloud runtime **only** with acceptance of weaker readiness semantics.

---

## Checklist (operations)

1. **Single source of truth** for `PUBLIC_BASE_URL` / `AUDIO_PUBLIC_BASE_URL` aligned with Telnyx connection URLs.  
2. **TLS certificates** valid for WebSocket upgrade.  
3. **Clock skew** within Telnyx signature tolerance (`TELNYX_SIGNATURE_MAX_SKEW_SECONDS` in runtime `env.ts`).  
4. **Secrets:** API keys for OpenAI, Telnyx, and **internal** control↔runtime keys — never logged in portal JSON.  
5. **Portal:** avoid returning **internal GPU URLs** to browser clients (see main architecture doc).

---

## Commands (Sprint 2A skeleton)

```bash
./scripts/preflight-profile.sh --profile hybrid
./scripts/deploy-profile.sh --profile hybrid
./scripts/validate-profile.sh --profile hybrid
docker compose -f docker-compose.yml -f docker-compose.hybrid.yml -p veralux config
```

`docker-compose.hybrid.yml` is a **skeleton overlay** only — networking and split stacks are operator-defined (see sections above).
