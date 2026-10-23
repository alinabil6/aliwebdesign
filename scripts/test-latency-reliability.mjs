#!/usr/bin/env node
// ────────────────────────────────────────────────────────────
// scripts/test-latency-reliability.mjs
// End-to-end audit & validation test for generation latency,
// bounded timeouts, fleet quarantine, and recovery mechanics.
// ────────────────────────────────────────────────────────────

import assert from "node:assert";
import {
  HARD_GENERATION_CEILING_MS,
  SELECTORS,
} from "../backend/lib/geminiweb.js";
import {
  isLeased,
  tryLease,
  release,
  quarantine,
  isQuarantined,
  clearQuarantine,
  getActiveExcludes,
} from "../backend/lib/fleetLease.js";
import { listReadyAccounts } from "../backend/lib/db.js";

console.log("=================================================");
console.log("   GENERATION LATENCY & RELIABILITY TEST SUITE   ");
console.log("=================================================");

let passedTests = 0;
let totalTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ [FAIL] ${name}: ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ [PASS] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ [FAIL] ${name}: ${err.message}`);
  }
}

// ── 1. Timeout Bounds & Safety Ceilings ────────────────────────
console.log("\n[1/4] Verifying Timeout Bounds & Execution Ceilings...");

test("Generation ceiling is safely bounded (<= 75s)", () => {
  assert.ok(
    HARD_GENERATION_CEILING_MS <= 75000,
    `Ceiling should be <= 75s, got ${HARD_GENERATION_CEILING_MS}ms`
  );
  assert.ok(
    HARD_GENERATION_CEILING_MS >= 45000,
    `Ceiling should be >= 45s for legitimate generations, got ${HARD_GENERATION_CEILING_MS}ms`
  );
});

test("DOM selectors have valid fallback arrays", () => {
  assert.ok(Array.isArray(SELECTORS.promptInput) && SELECTORS.promptInput.length >= 3);
  assert.ok(Array.isArray(SELECTORS.sendButton) && SELECTORS.sendButton.length >= 2);
  assert.ok(Array.isArray(SELECTORS.attachButton) && SELECTORS.attachButton.length >= 3);
});

// ── 2. Fleet Quarantine & Atomic Lease Mechanics ───────────────
console.log("\n[2/4] Verifying Fleet Quarantine & Lease Lifecycle...");

test("Account quarantine marks account quarantined and adds to exclusions", () => {
  const testAccId = "test_acc_bench_99";
  clearQuarantine(testAccId);
  assert.strictEqual(isQuarantined(testAccId), false);

  // Quarantine for 10 seconds
  quarantine(testAccId, 10000);
  assert.strictEqual(isQuarantined(testAccId), true);

  const excludes = getActiveExcludes();
  assert.ok(excludes.includes(testAccId), "Quarantined account must be in getActiveExcludes()");

  clearQuarantine(testAccId);
  assert.strictEqual(isQuarantined(testAccId), false);
});

test("Quarantine expires automatically after duration passes", async () => {
  const testAccId = "test_acc_bench_fast";
  quarantine(testAccId, 20); // 20ms
  assert.strictEqual(isQuarantined(testAccId), true);

  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(isQuarantined(testAccId), false);
});

test("Lease tracking enforces mutual exclusion", () => {
  const testAccId = "test_acc_lease_1";
  release(testAccId);

  const leasedFirst = tryLease(testAccId);
  assert.strictEqual(leasedFirst, true);
  assert.strictEqual(isLeased(testAccId), true);

  // Second lease attempt must be rejected
  const leasedSecond = tryLease(testAccId);
  assert.strictEqual(leasedSecond, false);

  release(testAccId);
  assert.strictEqual(isLeased(testAccId), false);
});

// ── 3. Database Fleet Readiness Check ──────────────────────────
console.log("\n[3/4] Checking SQLite DB Fleet Readiness...");

test("Fleet accounts are configured and ready in database", () => {
  const ready = listReadyAccounts();
  console.log(`     (Found ${ready.length} ready account(s) in DB)`);
  assert.ok(ready.length >= 1, "At least 1 ready account must exist for production operations");
});

// ── 4. Codebase Anti-Stall Invariants ──────────────────────────
console.log("\n[4/4] Verifying Anti-Stall Invariants in Source Files...");

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("magicListing.js has bounded retries (< 1 retry)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "backend", "routes", "magicListing.js"), "utf8");
  assert.ok(src.includes("item.retries < 1"), "magicListing must bound retries to max 1");
  assert.ok(src.includes("listing_retrying"), "magicListing must emit listing_retrying event");
  assert.ok(src.includes("closeProfile"), "magicListing must closeProfile on timeout/error");
  assert.ok(src.includes("quarantine("), "magicListing must quarantine failing accounts");
});

test("queue.js has bounded retries (< 1 retry) and timeout quarantine", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "backend", "lib", "queue.js"), "utf8");
  assert.ok(src.includes("item.retries < 1"), "queue.js must bound retries to max 1");
  assert.ok(src.includes("onItemRetry"), "queue.js must invoke onItemRetry callback");
  assert.ok(src.includes("quarantine(account.id, 30 * 1000)"), "queue.js must quarantine timed out accounts for 30s");
});

test("all image routes wire onItemRetry to stream slot_retrying", () => {
  const routes = ["textToImage.js", "variations.js", "designToDesign.js", "pixelToPixel.js", "artStyleNiche.js"];
  for (const r of routes) {
    const src = fs.readFileSync(path.join(__dirname, "..", "backend", "routes", r), "utf8");
    assert.ok(src.includes("slot_retrying"), `${r} must emit slot_retrying on item retry`);
  }
});

test("frontend app.js implements updatePlaceholderStatus and slot/listing retry handlers", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "frontend", "app.js"), "utf8");
  assert.ok(src.includes("function updatePlaceholderStatus"), "app.js must define updatePlaceholderStatus");
  assert.ok(src.includes("listing_retrying"), "app.js must handle listing_retrying");
  assert.ok(src.includes("slot_retrying"), "app.js must handle slot_retrying");
});

// ── Summary ────────────────────────────────────────────────────
console.log("\n=================================================");
console.log(`RESULTS: ${passedTests}/${totalTests} tests passed.`);
console.log("=================================================");

if (passedTests === totalTests) {
  console.log("✓ All latency & reliability invariants VERIFIED.");
  process.exit(0);
} else {
  console.error("✗ Some tests failed!");
  process.exit(1);
}
