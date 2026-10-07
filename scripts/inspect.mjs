#!/usr/bin/env node
// ────────────────────────────────────────────────────────────
// scripts/inspect.mjs — Dedicated DOM/canvas selector validator
// and health-check probe for the aliwebdesign engine.
// ────────────────────────────────────────────────────────────

import { SELECTORS, GEMINI_URL } from "../backend/lib/geminiweb.js";
import { listAccounts, reconcileAccountStates } from "../backend/lib/db.js";
import { canLaunchBrowser } from "../backend/lib/browser.js";
import http from "node:http";

console.log("=================================================");
console.log("   ALIWEBDESIGN ENGINE: DIAGNOSTIC & SELECTOR PROBE");
console.log("=================================================");

// 1. Selector Structure & Grammar Validation
console.log("\n[1/4] Validating DOM & Canvas Selectors...");
const selectorReport = [];
for (const [key, value] of Object.entries(SELECTORS)) {
  const isArray = Array.isArray(value);
  const count = isArray ? value.length : 1;
  const sample = isArray ? value[0] : value;
  const valid = (isArray && value.length > 0) || (typeof value === "string" && value.length > 0);
  selectorReport.push({
    Selector: key,
    Type: isArray ? "Fallback Array" : "String",
    Candidates: count,
    Status: valid ? "✓ VALID" : "✗ INVALID",
    Sample: sample ? (sample.length > 55 ? sample.slice(0, 52) + "..." : sample) : "N/A"
  });
}
console.table(selectorReport);

// 2. Browser Environment Probe
console.log("\n[2/4] Checking Browser & Profile Environment...");
const chromeAvailable = canLaunchBrowser("chrome");
const braveAvailable = canLaunchBrowser("brave");
console.log(`  • Gemini Target URL : ${GEMINI_URL}`);
console.log(`  • Google Chrome     : ${chromeAvailable ? "✓ Detected on host" : "○ Headless / Mock / Cloud Container mode"}`);
console.log(`  • Brave Browser     : ${braveAvailable ? "✓ Detected on host" : "○ Headless / Mock / Cloud Container mode"}`);

// 3. Database & Fleet Node Status
console.log("\n[3/4] Inspecting SQLite & Account Fleet State...");
const reconciled = reconcileAccountStates();
if (reconciled > 0) {
  console.log(`  • Reconciled ${reconciled} orphaned busy account(s) back to ready.`);
}
const accounts = listAccounts();
console.log(`  • Registered Fleet Accounts : ${accounts.length}`);
accounts.forEach((acc, i) => {
  console.log(`    [#${i + 1}] ID: ${acc.id.padEnd(16)} | Email: ${(acc.email || "n/a").padEnd(28)} | Status: ${acc.status.padEnd(8)} | Generations: ${acc.generation_count}`);
});

// 4. Local Health Check Ping (if dev server is up on port 3000)
console.log("\n[4/4] Checking Local Port 3000 Health Endpoint...");
function pingHealth(port = 3000) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 2000 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        resolve({ online: true, statusCode: res.statusCode, body });
      });
    });
    req.on("error", (err) => resolve({ online: false, error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ online: false, error: "timeout" }); });
  });
}

pingHealth(process.env.PORT || 3000).then((res) => {
  if (res.online) {
    console.log(`  • Local API Server  : ✓ ONLINE (HTTP ${res.statusCode}) -> ${res.body.trim()}`);
  } else {
    console.log(`  • Local API Server  : ○ Offline or starting (${res.error || "no response"})`);
  }
  console.log("\n=================================================");
  console.log("✓ Diagnostic inspection completed successfully.");
  console.log("=================================================");
  process.exit(0);
});
