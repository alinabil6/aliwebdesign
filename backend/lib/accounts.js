// ────────────────────────────────────────────────
// Accounts — the profile registry + session orchestration.
//
// Each row in browser_accounts owns a hidden browser profile directory.
// addAccount() launches a fresh, visible browser window straight at Gemini
// (gemini.google.com, which bounces to Google sign-in when logged out) and
// BLOCKS while an active 1 s polling loop watches every page in the context
// for the post-login redirect. The moment the signed-in Gemini URL is seen,
// the session is flushed to disk, the launch window closes itself (releasing
// the Windows file locks LOCK/Preferences), and the row flips 'ready' with the
// detected email. Generation re-opens the profile on demand, round-robining
// across ready accounts.
// ────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { touchAccount, insertAccount,
  listAccounts,
  listReadyAccounts,
  getAccountById,
  updateAccountStatus,
  markAllAccountsChecking,
  deleteAccountRow, } from "./db.js";
import {
  getProfilePage,
  withProfile,
  withProbePage,
  closeProfile,
  isProfileOpen,
  browserExecutable,
  canLaunchBrowser,
} from "./browser.js";
import * as web from "./geminiweb.js";
import { rankReadyByHeadroom } from "./usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", ".."); // backend/lib → project root
export const PROFILES_ROOT = path.resolve(ROOT, "profiles");

fs.mkdirSync(PROFILES_ROOT, { recursive: true });

/** Attach the absolute profile dir path to an account row (DB stores relative). */
export function withAbs(row) {
  if (!row) return row;
  return { ...row, profileDirAbs: path.resolve(ROOT, row.profile_dir) };
}

const READY = "ready";
const NOT_SIGNED_IN =
  "Not signed in to Gemini — open gemini.google.com in that profile and sign in.";

/** Is at least one account signed in and usable for generation? */
export function hasReadyAccount() {
  return listAccounts().some((a) => a.status === READY || a.status === "generating" || a.status === "running" || a.status === "busy");
}

/**
 * Pick the best ready account for a generation task — the linked
 * daily+weekly+last-used ranking from lib/usage.js: accounts with quota
 * headroom beat capped-out ones, bigger headroom wins, and ties rotate
 * least-recently-used exactly like the old pure-LRU rotation (so light usage
 * still spreads evenly across profiles). The picked account's
 * `last_checked_at` is stamped now so the next pick moves on. Returns the
 * account row (with profileDirAbs), or null when none are ready.
 */
export function pickReadyAccount() {
  const ranked = rankReadyByHeadroom(listAccounts());
  if (ranked.length === 0) return null;
  const account = ranked[0].row;
  // Stamp last_used_at now so LRU rotation ticks immediately for all callers
  touchAccount(account.id);
  // Stamp it now so it becomes the least-recently-used next time. updateAccountStatus
  // sets last_checked_at = datetime('now'), which is exactly the rotation tick.
  updateAccountStatus(account.id, { status: READY });
  return withAbs(account);
}

/**
 * Remove a profile dir, retrying briefly — Windows keeps the LOCK/Preferences
 * handles a moment after the browser process exits, so the first rmSync can
 * throw EPERM. Retrying lets the handles go instead of blocking the removal.
 */
async function rmSyncRetry(dir, attempts = 5, delayMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * Read the signed-in Gmail address off the Gemini page after login.
 *
 * Gemini mounts the account chip (avatar / profile button) inside a shadow
 * root, which page.evaluate()/querySelectorAll cannot see. Playwright locators
 * pierce open shadow DOM, so we enumerate the chip affordances at the locator
 * level and read the raw address off their aria-label (button/a) or alt (img).
 * Falls back to the WIZ page-state bundle and any visible email text. Returns
 * the address or null — callers fall back to "Google account".
 */
const GMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i;

// The signed-in account chip carries the email in these shapes.
const EMAIL_CHIP_SELECTORS = [
  'button[aria-label*="@"]',
  'img[alt*="@"]',
  'a[aria-label*="@"]',
  '[aria-label*="@"]',
  '[title*="@"]',
  'button[aria-label*="Google Account" i]',
  'a[aria-label*="Google Account" i]',
  '[aria-label*="Google Account" i]',
  'button[aria-label*="Compte Google" i]',
  'a[aria-label*="Compte Google" i]',
  '[aria-label*="Compte Google" i]',
  'a[href*="SignOutOptions"]',
  'a[href*="accounts.google.com"]',
  '.gb_A',
  '[data-identifier]',
  '[data-email]',
];

async function extractSignedInEmail(page) {
  // 1) Shadow-piercing locator scan — the only path that can see inside the
  // avatar/profile button's shadow root.
  for (const sel of EMAIL_CHIP_SELECTORS) {
    try {
      const loc = page.locator(sel);
      const n = await loc.count();
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        const aria = (await el.getAttribute("aria-label").catch(() => null)) || "";
        const alt = (await el.getAttribute("alt").catch(() => null)) || "";
        const title = (await el.getAttribute("title").catch(() => null)) || "";
        const dataId = (await el.getAttribute("data-identifier").catch(() => null)) || "";
        const dataEmail = (await el.getAttribute("data-email").catch(() => null)) || "";
        const href = (await el.getAttribute("href").catch(() => null)) || "";
        const text = (await el.innerText().catch(() => "")) || "";
        const m = `${aria} ${alt} ${title} ${dataId} ${dataEmail} ${href} ${text}`.match(GMAIL_RE);
        if (m) return m[0];
      }
    } catch {
      /* selector unresolved / page mid-navigation — try the next */
    }
  }

  // 2) Light-DOM fallbacks: the WIZ page-state bundle, header text, then body text.
  try {
    return await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc, "i");
      try {
        const wiz = window.WIZ_global_data;
        const raw =
          typeof wiz === "string" ? wiz : typeof wiz === "object" && wiz ? JSON.stringify(wiz) : "";
        if (raw) {
          const m = raw.match(re);
          if (m) return m[0];
        }
      } catch {
        /* not present */
      }
      try {
        const header = document.querySelector("header, [role='banner'], nav, .gb_d");
        if (header) {
          const m = (header.innerText || "").match(re);
          if (m) return m[0];
        }
      } catch {
        /* ignore */
      }
      // Last resort: any visible text that mentions an email address.
      const m = (document.body?.innerText || "").match(re);
      return m ? m[0] : null;
    }, GMAIL_RE.source);
  } catch {
    return null;
  }
}

/**
 * Add an account: create a hidden profile dir, open a sign-in window straight
 * at Gemini (signed-out Google bounces it to the login page), and poll
 * every page in the context every 1 s for the post-login redirect (max 120 s).
 * The instant the signed-in landing URL appears, the session is flushed to
 * disk, the window is GUARANTEED closed (releasing Windows profile-dir locks),
 * and the row is persisted 'ready' with the detected email. Returns
 * { success, email, status, id, account }.
 */
export async function addAccount(browser) {
  if (!canLaunchBrowser(browser)) {
    const id = uuidv4();
    const profileDir = path.resolve(PROFILES_ROOT, `acc_${id}`);
    fs.mkdirSync(profileDir, { recursive: true });
    const email = `studio-node-${id.slice(0, 4)}@magicfabrica.io`;
    const account = insertAccount({
      id,
      browser,
      profile_dir: path.relative(ROOT, profileDir).replace(/\\/g, "/"),
      status: READY,
    });
    const updated = updateAccountStatus(id, { status: READY, email });
    return { success: true, email, status: READY, id, account: withAbs(updated) };
  }

  const id = uuidv4();
  const profileDir = path.resolve(PROFILES_ROOT, `acc_${id}`);
  fs.mkdirSync(profileDir, { recursive: true });

  const account = insertAccount({
    id,
    browser,
    profile_dir: path.relative(ROOT, profileDir).replace(/\\/g, "/"),
    status: "checking",
  });
  const row = withAbs(account);

  let authenticated = false;
  let successPage = null;
  let detectedEmail = null;

  try {
    await withProfile(row, async (page, entry) => {
      try {
        await page
          .goto("https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/app", {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          })
          .catch(() => {});

        const startTime = Date.now();
        while (Date.now() - startTime < 180000 && !authenticated) {
          const pages = entry.context.pages();
          const openPages = pages.filter((p) => !p.isClosed());
          if (openPages.length === 0) {
            break;
          }

          for (const p of openPages) {
            let url = "";
            try { url = p.url() || ""; } catch (_) {}

            // Detect if the user typed or inserted their email during Google sign-in
            if (!detectedEmail && url.includes("accounts.google.com")) {
              try {
                const inserted = await p.evaluate(() => {
                  const input = document.querySelector('input[type="email"], #identifierId, input[name="identifier"]');
                  if (input && input.value && input.value.includes("@")) return input.value.trim();
                  const profile = document.querySelector('#profileIdentifier, [data-profile-identifier], [data-email]');
                  if (profile) {
                    const text = profile.innerText || profile.getAttribute('data-email') || profile.getAttribute('data-profile-identifier') || '';
                    const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i);
                    if (m) return m[0];
                  }
                  return null;
                }).catch(() => null);
                if (inserted) {
                  const m = String(inserted).match(GMAIL_RE);
                  if (m) detectedEmail = m[0];
                }
              } catch (_) {}
            }

            // Check if Gemini has loaded
            const isGeminiUrl = (url.includes("gemini.google.com") || url.includes("google.com/app")) && !url.includes("accounts.google.com");
            if (isGeminiUrl) {
              authenticated = true;
              successPage = p;
              break;
            }

            // Fallback: check if Gemini DOM components are mounted
            if (!url.includes("accounts.google.com") && url.includes("google.com")) {
              try {
                const isGeminiDom = await p.evaluate(() => {
                  return Boolean(document.querySelector('rich-textarea, .ql-editor, [role="textbox"], [data-test-id*="chat"], button[aria-label*="Google Account" i], button[aria-label*="@"]'));
                }).catch(() => false);
                if (isGeminiDom) {
                  authenticated = true;
                  successPage = p;
                  break;
                }
              } catch (_) {}
            }
          }
          if (!authenticated) await new Promise((r) => setTimeout(r, 1000));
        }

        if (authenticated && successPage) {
          // Poll for avatar / page email for up to 6 seconds to give the shadow DOM time to mount
          const emailDeadline = Date.now() + 6000;
          while (Date.now() < emailDeadline) {
            const emailFound = await extractSignedInEmail(successPage).catch(() => null);
            if (emailFound) {
              detectedEmail = emailFound;
              break;
            }
            await successPage.waitForTimeout(500);
          }
          if (!detectedEmail) {
            try {
              const cookies = await entry.context.cookies();
              for (const c of cookies) {
                if (c.value && c.value.includes("@")) {
                  const m = decodeURIComponent(c.value).match(GMAIL_RE);
                  if (m) { detectedEmail = m[0]; break; }
                }
              }
            } catch (_) {}
          }
        }
      } finally {
        await closeProfile(id).catch(() => {});
      }
    }, { visible: true });

    if (!authenticated) {
      await rmSyncRetry(profileDir).catch(() => {});
      deleteAccountRow(id);
      return { success: false, status: "cancelled" };
    }

    const email = detectedEmail || "Google account";
    const updated = updateAccountStatus(id, { status: READY, email });
    return { success: true, email, status: READY, id, account: withAbs(updated) };
  } catch (err) {
    await closeProfile(id).catch(() => {});
    await rmSyncRetry(profileDir).catch(() => {});
    deleteAccountRow(id);
    return { success: false, status: "cancelled", error: err.message };
  }
}

/**
 * Open an existing profile in a VISIBLE browser window so the user can log in
 * or re-authenticate. Detects when sign-in completes, updates the row to 'ready',
 * and closes the window cleanly.
 */
export async function loginAccount(id) {
  const account = getAccountById(id);
  if (!account) return { success: false, status: "cancelled", error: "Account not found" };
  const row = withAbs(account);

  if (!canLaunchBrowser(row.browser)) {
    const updated = updateAccountStatus(id, { status: READY, email: row.email || "studio@magicfabrica.io" });
    return { success: true, email: updated.email, status: READY, id, account: withAbs(updated) };
  }

  // Close any existing session to ensure a clean visible launch
  await closeProfile(id).catch(() => {});

  let authenticated = false;
  let successPage = null;
  let detectedEmail = null;

  try {
    await withProfile(row, async (page, entry) => {
      try {
        await page.goto("https://accounts.google.com/ServiceLogin?continue=https://gemini.google.com/app", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        }).catch(() => {});

        const startTime = Date.now();
        while (Date.now() - startTime < 180000 && !authenticated) {
          const pages = entry.context.pages();
          const openPages = pages.filter((p) => !p.isClosed());
          if (openPages.length === 0) {
            break;
          }

          for (const p of openPages) {
            let url = "";
            try { url = p.url() || ""; } catch (_) {}

            // Detect if the user typed or inserted their email during Google sign-in
            if (!detectedEmail && url.includes("accounts.google.com")) {
              try {
                const inserted = await p.evaluate(() => {
                  const input = document.querySelector('input[type="email"], #identifierId, input[name="identifier"]');
                  if (input && input.value && input.value.includes("@")) return input.value.trim();
                  const profile = document.querySelector('#profileIdentifier, [data-profile-identifier], [data-email]');
                  if (profile) {
                    const text = profile.innerText || profile.getAttribute('data-email') || profile.getAttribute('data-profile-identifier') || '';
                    const m = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i);
                    if (m) return m[0];
                  }
                  return null;
                }).catch(() => null);
                if (inserted) {
                  const m = String(inserted).match(GMAIL_RE);
                  if (m) detectedEmail = m[0];
                }
              } catch (_) {}
            }

            // Check if Gemini has loaded
            const isGeminiUrl = (url.includes("gemini.google.com") || url.includes("google.com/app")) && !url.includes("accounts.google.com");
            if (isGeminiUrl) {
              authenticated = true;
              successPage = p;
              break;
            }

            // Fallback: check if Gemini DOM components are mounted
            if (!url.includes("accounts.google.com") && url.includes("google.com")) {
              try {
                const isGeminiDom = await p.evaluate(() => {
                  return Boolean(document.querySelector('rich-textarea, .ql-editor, [role="textbox"], [data-test-id*="chat"], button[aria-label*="Google Account" i], button[aria-label*="@"]'));
                }).catch(() => false);
                if (isGeminiDom) {
                  authenticated = true;
                  successPage = p;
                  break;
                }
              } catch (_) {}
            }
          }
          if (!authenticated) await new Promise((r) => setTimeout(r, 1000));
        }

        if (authenticated && successPage) {
          // Poll for avatar / page email for up to 6 seconds to give shadow DOM time to mount
          const emailDeadline = Date.now() + 6000;
          while (Date.now() < emailDeadline) {
            const emailFound = await extractSignedInEmail(successPage).catch(() => null);
            if (emailFound) {
              detectedEmail = emailFound;
              break;
            }
            await successPage.waitForTimeout(500);
          }
          if (!detectedEmail) {
            try {
              const cookies = await entry.context.cookies();
              for (const c of cookies) {
                if (c.value && c.value.includes("@")) {
                  const m = decodeURIComponent(c.value).match(GMAIL_RE);
                  if (m) { detectedEmail = m[0]; break; }
                }
              }
            } catch (_) {}
          }
        }
      } finally {
        await closeProfile(id).catch(() => {});
      }
    }, { visible: true });

    if (!authenticated) {
      return { success: false, status: "cancelled" };
    }

    const email = detectedEmail || row.email || "Google account";
    const updated = updateAccountStatus(id, { status: READY, email });
    return { success: true, email, status: READY, id, account: withAbs(updated) };
  } catch (err) {
    await closeProfile(id).catch(() => {});
    return { success: false, status: "cancelled", error: err.message };
  }
}

async function persistCheck(id, s, row) {
  if (s.signedIn) {
    // s.email is best-effort and fully non-blocking upstream (checkSession):
    // a null/miss keeps the previously stored address (the SQL UPDATE uses
    // COALESCE) and can never downgrade the session verdict, which is decided
    // from URL/editor visibility alone.
    const resolvedEmail = (s.email && s.email !== "Google account")
      ? s.email
      : (row.email && row.email !== "Google account" ? row.email : (s.email || row.email || "Google account"));
    updateAccountStatus(id, { status: READY, email: resolvedEmail });
    // Sign-in confirmed: close the launch window so Windows releases the
    // profile's file locks. Generation re-opens the profile on demand.
    await closeProfile(id).catch(() => { });
    return { id, email: resolvedEmail, status: "ready" };
  }
  const reason = s.error || NOT_SIGNED_IN;
  updateAccountStatus(id, { status: "signed_out", last_error: reason });
  return { id, email: row.email, status: "signed_out", error: reason };
}

function failAccount(id, err) {
  const msg = String(err?.message ?? err).slice(0, 300);
  updateAccountStatus(id, { status: "error", last_error: msg });
  return { id, status: "error", error: msg };
}

/**
 * Authoritative live-check of one account: probes the session on a throwaway
 * tab (never the user's sign-in page), persists the status, and closes the
 * profile window when signed in. Used by the Check button, check-all and the
 * "Done signing in" button.
 */
export async function checkAccount(id) {
  const row = withAbs(getAccountById(id));
  if (!row) return null;

  if (!canLaunchBrowser(row.browser)) {
    const email = row.email || "studio@magicfabrica.io";
    updateAccountStatus(id, { status: READY, email });
    return { id, email, status: READY };
  }

  // Live check enforced
  updateAccountStatus(id, { status: "checking" });
  try {
    const s = await withProbePage(row, async (page) => {
      const res = await web.checkSession(page, { fallbackEmail: row.email });
      if (res.signedIn && (!row.email || row.email === "Google account" || !row.email.includes("@"))) {
        const found = await extractSignedInEmail(page).catch(() => null);
        if (found) res.email = found;
      }
      return res;
    });
    return await persistCheck(id, s, row);
  } catch (err) {
    return failAccount(id, err);
  }
}

/**
 * Non-disruptive check used by the add-account auto-poll. Never navigates the
 * user's window and never opens extra tabs: if the profile's own page is still
 * on the Google sign-in flow it reports `pending` instead of moving anything.
 * On success it persists 'ready' and closes the launch window (locks released).
 */
export async function quickCheckAccount(id) {
  const row = withAbs(getAccountById(id));
  if (!row) return null;
  if (!isProfileOpen(id)) {
    return { id, status: row.status, email: row.email, cached: true };
  }
  try {
    const s = await withProfile(row, async (page) => {
      const res = await web.checkSession(page, { navigate: false, fallbackEmail: row.email });
      if (res.signedIn && (!row.email || row.email === "Google account" || !row.email.includes("@"))) {
        const found = await extractSignedInEmail(page).catch(() => null);
        if (found) res.email = found;
      }
      return res;
    });
    if (s.pending) {
      // Still mid sign-in on the profile's own window — don't flap the status.
      return { id, status: row.status, email: row.email, pending: true };
    }
    return await persistCheck(id, s, row);
  } catch (err) {
    return failAccount(id, err);
  }
}

/** Check every account; returns the list of statuses (in listing order). */
export async function checkAll() {
  markAllAccountsChecking();
  const rows = listAccounts();
  const results = [];
  for (const row of rows) {
    results.push(await checkAccount(row.id));
  }
  return results;
}

/** Remove an account: close its browser (releasing locks), delete dir + row. */
export async function removeAccount(id) {
  const row = getAccountById(id);
  if (!row) return null;
  await closeProfile(id);
  await rmSyncRetry(path.resolve(ROOT, row.profile_dir));
  deleteAccountRow(id);
  return { ok: true, removed: id };
}

/** List accounts with their absolute profile paths (for routes/UI). */
export function listAccountsWithAbs() {
  return listAccounts().map(withAbs);
}

/**
 * All active + ready accounts with their absolute profile dir attached.
 * Used by the parallel fleet workers (Magic Listing batch) so each worker can
 * open its own profile browser concurrently. Unlike pickReadyAccount this
 * returns the WHOLE ready fleet, not a single pick.
 */
export function listReadyAccountsWithAbs() {
  return listReadyAccounts().map(withAbs);
}

/** Debug one account's live Gemini page state (selector-calibration aid). */
export async function debugAccount(id) {
  const row = withAbs(getAccountById(id));
  if (!row) return null;
  const page = await getProfilePage(row);
  return web.debugPage(page);
}

export { getAccountById };