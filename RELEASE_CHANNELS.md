# Release channels and tagging policy

This document defines how **VeraLux Receptionist** images should be tagged and consumed for **predictable managed upgrades** across many customer instances.

---

## 1. Goals

- Same **`.env`** pin (`REGISTRY` + `VERSION`) on every host in a cohort produces the **same intended images** after `docker compose pull`.
- No silent **tag drift** (`latest` resolving to different digests over time or per host).
- Operators can **audit** what ran (`./deploy.sh versions`, `backups/veralux-images_*.txt` from `./deploy.sh update`).

---

## 2. Recommended channels

| Channel | Tag shape (examples) | Audience |
|---------|----------------------|----------|
| **Production** | Immutable semver **`x.y.z`** (e.g. `0.1.0`) or **digest** (`repo/image@sha256:…`) | Managed customer deployments |
| **Staging / canary** | Pre-release **`x.y.z-rc.N`** or dated build id **`0.1.0-20260406`** | Validation before fleet-wide pin |
| **Dev / local** | **`git` short SHA** as tag, or local **`./deploy.sh build`** without registry | Engineers only |

**Avoid** `VERSION=latest` in production: the tag moves; two hosts “on latest” can run different digests; rollbacks are ambiguous.

---

## 3. Policy (contract summary)

1. **Pin `REGISTRY` and `VERSION`** in **`.env`** (or **`.env.internal`** for overrides). Empty `VERSION` relies on Compose file defaults — **not recommended** for fleets (`deploy.sh` warns).
2. **Bump `VERSION` deliberately** when releasing; distribute updated `.env` snippets or config management vars to all instances.
3. **Third-party infra images** (e.g. `cloudflared`, `ngrok`, optional `vllm`) use separate pins in **`.env`** where supported (`CLOUDFLARED_TAG`, `NGROK_TAG`, `VLLM_IMAGE`) — treat them the same way: **pin**, don’t float.
4. **CI/CD** should push application images under the same tag you ask customers to set (e.g. promote `0.1.1` only after smoke tests).

---

## 4. Digest pinning (strongest reproducibility)

For maximum certainty, after first pull record the digest:

```bash
docker image inspect "${REGISTRY}/veralux-control-plane:${VERSION}" --format '{{index .RepoDigests 0}}'
```

Advanced deployments can set Compose `image:` to **`name@sha256:…`** in **`docker-compose.override.yml`** (operator-maintained). The stock **`docker-compose.yml`** uses **`${REGISTRY}/…:${VERSION}`** for simplicity.

---

## 5. Relationship to scripts

| Mechanism | Role |
|-----------|------|
| **`./deploy.sh update`** | Pulls pinned tags (strict by default), rolling restarts, optional image snapshot files under **`backups/`**. |
| **`./deploy.sh versions`** | Prints running containers’ **`Config.Image`** and image IDs vs env pin. |
| **`VERALUX_SKIP_VERSION_WARN=1`** | Suppresses **`latest`/empty REGISTRY** warnings (automation only). |

---

## 6. See also

- **`UPGRADE_RUNBOOK.md`** — operator checklist.
- **`ROLLBACK_RUNBOOK.md`** — revert procedure.
- **`DEPLOYMENT_CONTRACT.md`** §5 — supported upgrade command.
