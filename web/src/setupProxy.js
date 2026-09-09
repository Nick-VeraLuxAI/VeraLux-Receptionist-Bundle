/**
 * Dev-only: CRA talks to the real control plane on :4000 (same paths as production).
 * Production builds use an empty base URL so fetch("/api/...") is same-origin.
 */
const { createProxyMiddleware } = require("http-proxy-middleware");

const target = process.env.CONTROL_PLANE_PROXY || "http://127.0.0.1:4000";

module.exports = function setupProxy(app) {
  app.use(
    ["/api", "/health", "/ready", "/oauth", "/admin-legacy", "/portal-legacy", "/owner", "/v1"],
    createProxyMiddleware({
      target,
      changeOrigin: true,
    }),
  );
};
