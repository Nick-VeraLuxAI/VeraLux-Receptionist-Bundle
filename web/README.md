# VeraLux web console

React admin (`/admin`) and owner portal (`/portal`) served by the control plane.

- **Production:** same-origin. Leave `REACT_APP_CONTROL_PLANE_URL` empty. The control plane serves `public/app`.
- **Dev:** `npm start` in this folder; CRA proxies `/api` to `http://127.0.0.1:4000`.
- **Legacy HTML:** `/admin-legacy`, `/portal-legacy`, `/owner`.

```bash
# from repo root
npm run dev:web          # CRA on :3000, proxy to control plane
npm run build:web        # write control-plane/public/app
npm run test:web         # adapter contract tests
```

This package is **not** an npm workspace member (CRA). Install with `npm install` inside `web/`.

## Known gap — deep TTS sliders

React Voice editor covers engine, preset, rate, language, clone upload, and Hear voice preview.

Qwen3 / Miso / Coqui generation sliders stay on **`/admin-legacy`** for this cutover. Saving `ttsMode: chatterbox_http` and publishing via **Publish to runtime** (`POST /api/admin/runtime/tenants/:id/publish-from-tenant`) is the live-call path. The SPA never talks to Chatterbox on port 7005.
