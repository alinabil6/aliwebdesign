import { pickReadyAccount } from "./accounts.js";
import { updateAccountStatus, getAccountById } from "./db.js";
import { getProfilePage, closeProfile, canLaunchBrowser } from "./browser.js";
import { MOCK_GEMINI } from "./gemini.js";

const READY = "ready";
const NEEDS_AUTH = "needs_reauth";

export async function acquire(retries = 3) {
  if (retries <= 0) {
    throw new Error("No authenticated Gemini accounts ready — verify in Accounts tab");
  }

  const account = pickReadyAccount();
  if (!account) {
    throw new Error("No Gemini account is ready — open the Accounts tab and sign in");
  }

  if (MOCK_GEMINI || !canLaunchBrowser(account?.browser)) {
    return {
      account,
      page: {
        url: () => "https://gemini.google.com/app",
        locator: () => ({ first: () => ({ isVisible: async () => false }) }),
        evaluate: async () => {},
        goto: async () => {},
        close: async () => {},
        isClosed: () => false,
      },
    };
  }

  updateAccountStatus(account.id, { status: "running" });

  try {
    const page = await getProfilePage(account);
    const isLoggedOut = await (async () => {
      try {
        const url = page.url() || "";
        if (url.includes("accounts.google.com")) return true;
        const signInVisible = await page
          .locator('a[href*="accounts.google.com"], button:has-text("Sign in"), [aria-label*="Sign in" i]')
          .first()
          .isVisible()
          .catch(() => false);
        const composerVisible = await page
          .locator('div[contenteditable="true"], textarea')
          .first()
          .isVisible()
          .catch(() => false);
        return signInVisible && !composerVisible;
      } catch {
        return false;
      }
    })();

    if (isLoggedOut) {
      console.warn(`[AccountPool] Account ${account.email || account.id} is logged out. Skipping.`);
      updateAccountStatus(account.id, { status: NEEDS_AUTH });
      return await acquire(retries - 1);
    }

    return { account, page };
  } catch (err) {
    updateAccountStatus(account.id, { status: "error" });
    console.error(`[AccountPool] Profile init failed for ${account.id}:`, err.message);
    return await acquire(retries - 1);
  }
}

export async function release(slot, { fatalCrash = false } = {}) {
  if (!slot?.account?.id) return;
  if (fatalCrash) {
    await closeProfile(slot.account.id).catch(() => {});
  }
  const current = getAccountById(slot.account.id);
  if (current && current.status === "running") {
    updateAccountStatus(slot.account.id, { status: READY });
  }
}

export async function withSlot(fn) {
  const slot = await acquire();
  try {
    return await fn(slot);
  } finally {
    await release(slot);
  }
}
