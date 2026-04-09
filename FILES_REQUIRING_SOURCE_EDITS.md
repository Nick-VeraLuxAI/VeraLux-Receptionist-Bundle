# Files that may still require source edits (customer onboarding)

For the **supported** operator surface (env, DB, mounts), see **`CUSTOMER_CONFIG_SURFACE.md`**.

The paths below are **exceptions** where a new customer might still edit **repository files** or **maintain a fork** for deeper customization:

| Path | Typical reason |
|------|----------------|
| **`control-plane/public/admin-neural.css`** | Colors, typography, layout beyond logo/title. |
| **`control-plane/public/admin.html`**, **`portal.html`**, **`owner.html`** | Structural HTML changes (not covered by **`BRAND_*`**). |
| **`control-plane/public/dev-console.html`** | Dev-only UI; not on **`apply-branding.js`** yet. |
| **`docker-compose.override.yml`** (host) | Extra services, digest-pinned images, bind mounts. |
| **`nginx/`** | Custom reverse proxy / TLS when not using bundled tunnel. |
| **`veralux-audio-stack/**`**, **`Dockerfile*`** | Custom audio stacks or base images. |

**Remediation plan:** **`CUSTOMER_CONFIG_SURFACE.md`** §4 (phases D–F for future work).
