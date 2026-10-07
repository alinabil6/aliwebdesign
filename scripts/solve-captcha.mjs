#!/usr/bin/env node
// ────────────────────────────────────────────────────────────
// scripts/solve-captcha.mjs — Direct launcher to hook onto
// target profiles for manual/semi-automated Google checkpoint
// and CAPTCHA handling.
// ────────────────────────────────────────────────────────────

import { fileURLToPath } from "url";
import path from "path";
import { listAccounts, getAccountById, updateAccountStatus } from "../backend/lib/db.js";
import { canLaunchBrowser, withProfile, closeProfile } from "../backend/lib/browser.js";
import { GEMINI_URL, checkSession } from "../backend/lib/geminiweb.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
let targetAccountId = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--account" && args[i + 1]) {
    targetAccountId = args[++i];
  } else if (!args[i].startsWith("-")) {
    targetAccountId = args[i];
  }
}

const accounts = listAccounts();
if (accounts.length === 0) {
  console.error("✗ No browser accounts found in database.");
  process.exit(1);
}

const targetAccount = targetAccountId
  ? getAccountById(targetAccountId)
  : accounts[0];

if (!targetAccount) {
  console.error(`✗ Account '${targetAccountId}' not found in database.`);
  console.log("Available accounts:", accounts.map((a) => a.id).join(", "));
  process.exit(1);
}

// Construct profileDir cleanly from project root using ES modules __dirname
const profileDir = targetAccount.profile_dir
  ? path.resolve(__dirname, "..", targetAccount.profile_dir)
  : path.resolve(__dirname, "..", "profiles", targetAccount.id);

const preparedAccount = {
  ...targetAccount,
  profileDirAbs: profileDir,
};

console.log("=================================================");
console.log("   ALIWEBDESIGN: GOOGLE CHECKPOINT / CAPTCHA HOOK");
console.log("=================================================");
console.log(`Target Node ID  : ${preparedAccount.id}`);
console.log(`Target Email    : ${preparedAccount.email || "(unbound)"}`);
console.log(`Profile Dir     : ${profileDir}`);
console.log(`Current Status  : ${preparedAccount.status}`);

const browserName = preparedAccount.browser || "chrome";
const isBrowserAvailable = canLaunchBrowser(browserName);

if (!isBrowserAvailable) {
  console.log(`\n○ Local ${browserName} binary is not directly installed in this environment.`);
  console.log("  Running in headless container / cloud mode.");
  console.log("  Status report: Profile record is active and ready for background generation.");
  process.exit(0);
}

console.log(`\n[1/2] Launching visible browser instance for profile '${preparedAccount.id}'...`);
console.log("  Navigating to Gemini / Google login interface...");

withProfile(preparedAccount, async (page) => {
  await page.goto(GEMINI_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  
  console.log("\n[2/2] Browser window is active!");
  console.log("  ➔ Complete any Google login challenge, CAPTCHA, or prompt verification in the browser window.");
  console.log("  ➔ Keep this process running while you complete the verification.");
  console.log("  ➔ Press Ctrl+C in this terminal when finished to save and detach the profile.\n");

  // Keep alive until user interrupts or completes
  await new Promise((resolve) => {
    const handleExit = async () => {
      console.log("\nDetaching profile and probing updated session status...");
      try {
        const session = await checkSession(page, { navigate: false, fallbackEmail: targetAccount.email });
        if (session.signedIn) {
          console.log(`✓ Node '${targetAccount.id}' authenticated successfully!`);
          updateAccountStatus(targetAccount.id, { status: "ready", last_error: null });
        } else {
          console.log(`○ Session status: ${session.status || "unverified"}`);
        }
      } catch (_) {}
      await closeProfile(targetAccount.id).catch(() => {});
      console.log("Profile detached cleanly.");
      resolve();
      process.exit(0);
    };

    process.on("SIGINT", handleExit);
    process.on("SIGTERM", handleExit);
  });
}, { visible: true }).catch((err) => {
  console.error("✗ Failed to hook onto browser profile:", err.message);
  process.exit(1);
});
