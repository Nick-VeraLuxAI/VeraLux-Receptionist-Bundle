#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "web", "build");
const dest = path.join(__dirname, "..", "control-plane", "public", "app");

if (!fs.existsSync(src)) {
  console.error("web/build is missing. Run: npm --prefix web run build");
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`Copied ${src} -> ${dest}`);
