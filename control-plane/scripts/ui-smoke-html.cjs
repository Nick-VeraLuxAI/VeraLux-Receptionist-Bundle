#!/usr/bin/env node
/**
 * Lightweight UI smoke — fetches static HTML for /portal, /admin, /owner.
 * No browser; no backend changes.
 *
 * Usage:
 *   UI_SMOKE_BASE_URL=http://127.0.0.1:4000 node scripts/ui-smoke-html.cjs
 *   npm run test:ui-smoke-html
 */

const BASE = (process.env.UI_SMOKE_BASE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");

const PORTAL_FORBIDDEN = [
  "Redis",
  "voice runtime",
  "OPENAI_API_KEY",
  "do_sample",
  "top_p",
  "/api/",
  "admin dashboard",
];

/** Terms allowed only inside advanced voice <details> or <script> */
const PORTAL_FORBIDDEN_OUTSIDE_ADVANCED = [
  "Qwen",
  "Coqui",
  "Chatterbox",
  "Kokoro",
];

const rows = [];

function pass(name, ok, detail = "") {
  rows.push({ name, ok: Boolean(ok), detail });
}

async function fetchText(path) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, { redirect: "follow" });
  const text = await res.text();
  return { url, status: res.status, text };
}

function stripScripts(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, "");
}

function stripPortalAdvancedVoice(html) {
  const noScript = stripScripts(html);
  return noScript
    .replace(/<details[^>]*id=["']portal-tts-advanced-block["'][\s\S]*?<\/details>/gi, "")
    .replace(/<details[^>]*class="[^"]*portal-tts-advanced[^"]*"[\s\S]*?<\/details>/gi, "");
}

function loadHtml(path, filePath) {
  if (process.env.UI_SMOKE_READ_LOCAL === "1") {
    const fs = require("node:fs");
    const p = require("node:path").join(__dirname, "..", "public", filePath);
    return { status: 200, text: fs.readFileSync(p, "utf8"), url: `file://${p}` };
  }
  return fetchText(path);
}

function countId(html, id) {
  const re = new RegExp(`\\bid=["']${id}["']`, "g");
  return (html.match(re) || []).length;
}

function findForbidden(text, terms) {
  const hits = [];
  for (const term of terms) {
    if (text.includes(term)) hits.push(term);
  }
  return hits;
}

async function checkPortal() {
  const { status, text } = await loadHtml("/portal", "portal.html");
  pass("GET /portal", status === 200, `status ${status}`);

  const ids = [
    "login-screen",
    "login-email",
    "login-btn",
    "dashboard",
    "logout-btn",
    "save-prompts",
    "portal-bh-save",
    "portal-qr-save",
    "save-portal-tts",
    "portal-tts-status",
    "portal-tts-advanced-block",
    "vlx-portal-tagline",
  ];
  for (const id of ids) {
    const n = countId(text, id);
    pass(`portal id=${id}`, n === 1, n === 0 ? "missing" : n > 1 ? `count ${n}` : "ok");
  }

  pass("portal links to /admin", !text.includes('href="/admin"'), "no client admin link");

  const clientSlice = stripPortalAdvancedVoice(text);
  const bad = findForbidden(clientSlice, [
    ...PORTAL_FORBIDDEN,
    ...PORTAL_FORBIDDEN_OUTSIDE_ADVANCED,
  ]);
  pass(
    "portal default HTML copy guard",
    bad.length === 0,
    bad.length ? `found: ${bad.join(", ")}` : "ok",
  );

  pass(
    "portal has Save voice settings",
    text.includes("Save voice settings"),
    "",
  );
  pass(
    "portal has Last updated for live calls",
    text.includes("Last updated for live calls"),
    "",
  );
}

async function checkAdmin() {
  const { status, text } = await loadHtml("/admin", "admin.html");
  pass("GET /admin", status === 200, `status ${status}`);

  for (const id of ["tenant-select", "vlx-admin-build-stamp", "refresh-all"]) {
    pass(`admin id=${id}`, countId(text, id) >= 1, "");
  }

  pass("admin hash tab calls", text.includes('data-tab="calls"'), "");
  pass("admin hash tab billing", text.includes('data-tab="billing"'), "");
  pass("admin hash tab settings", text.includes('data-tab="settings"'), "");
  pass("admin activateAdminTab", text.includes("activateAdminTab"), "");
  pass("admin Coming soon intervention", text.includes("Coming soon"), "");
  pass(
    "admin disabled Take over",
    /id="[^"]*"/.test(text) && text.includes("Take over") && text.includes("disabled"),
    "",
  );
  pass("admin uses admin-neural.css", text.includes("admin-neural.css"), "");
}

async function checkOwner() {
  const { status, text } = await loadHtml("/owner", "owner.html");
  pass("GET /owner", status === 200, `status ${status}`);

  pass("owner internal banner", text.includes("vlx-internal-banner"), "");
  pass(
    "owner implementers copy",
    /implementers only/i.test(text) || /Internal setup tool/i.test(text),
    "",
  );
  pass("owner points to portal", text.includes('href="/portal"'), "");
  pass(
    "owner no Open full admin dashboard",
    !text.includes("Open full admin dashboard"),
    "",
  );
  pass("owner telnyx panel", countId(text, "telnyx-get-number") >= 1, "");
  pass("owner no DB & Redis down string", !text.includes("DB & Redis down"), "");
  pass("owner uses veralux-shell.css", text.includes("veralux-shell.css"), "");
}

async function main() {
  const mode = process.env.UI_SMOKE_READ_LOCAL === "1" ? "local public/" : BASE;
  console.log(`UI smoke (HTML) — ${mode}\n`);
  try {
    await checkPortal();
    await checkAdmin();
    await checkOwner();
  } catch (e) {
    pass("fetch error", false, e.message || String(e));
  }

  let failed = 0;
  for (const r of rows) {
    const mark = r.ok ? "PASS" : "FAIL";
    if (!r.ok) failed++;
    console.log(`${mark}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${rows.length - failed}/${rows.length} passed`);
  process.exit(failed ? 1 : 0);
}

main();
