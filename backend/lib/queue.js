import pLimit from "p-limit";
import { generateImage, generateImageOnAccount } from "./gemini.js";
import { listReadyAccountsWithAbs, listAccountsWithAbs, withAbs } from "./accounts.js";
import { setAccountStatus, getAccountById, claimNextReadyAccount } from "./db.js";
import { getProfilePage, closeProfile, canLaunchBrowser, isInteractiveAuthActive, purgeFleetBrowsers as purgeFleetBrowsersBrowser } from "./browser.js";

async function checkTabHeartbeat(account, timeoutMs = 8000) {
  if (!canLaunchBrowser()) return true; // mock / headless environment
  if (isInteractiveAuthActive) return true; // Never kill tabs during interactive sign-ins
  const reg = activeAccountPages.get(account?.id);
  const page = reg?.page;
  if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
    return false;
  }
  try {
    const ping = Promise.race([
      page.evaluate(() => document.readyState),
      new Promise((_, reject) => setTimeout(() => reject(new Error("HEARTBEAT_TIMEOUT")), timeoutMs)),
    ]);
    await ping;
    return true;
  } catch (err) {
    if (isInteractiveAuthActive) return true;
    console.warn(`[heartbeat] Tab for ${account?.id} unresponsive (${err.message}). Recycling tab...`);
    try {
      await closeProfile(account.id);
    } catch (_) {}
    return false;
  }
}

export const MAX_CONCURRENT = parseInt(process.env.MAX_FLEET_CONCURRENT || "4", 10);
const limit = pLimit(MAX_CONCURRENT);
const leasedAccountIds = new Set();
const quarantinedAccountIds = new Map();
const accountSessionGenerations = new Map();
const recyclingAccountIds = new Set();

const activeBatchSignals = new Set();
const activeAccountPages = new Map();

const LAUNCH_DELAY_MS = 2500;
let lastGlobalLaunchTime = 0;
async function acquireGlobalLaunchSlot() {
  const now = Date.now();
  const waitMs = Math.max(0, lastGlobalLaunchTime + LAUNCH_DELAY_MS - now);
  lastGlobalLaunchTime = now + waitMs;
  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

export function registerBatchSignal(signal) { if (signal) activeBatchSignals.add(signal); }
export function unregisterBatchSignal(signal) { if (signal) activeBatchSignals.delete(signal); }
export function registerAccountPage(accountId, page, cancelCallback = null) {
  if (accountId && page) activeAccountPages.set(accountId, { page, cancelCallback });
}
export function unregisterAccountPage(accountId) {
  if (accountId) activeAccountPages.delete(accountId);
}

export function isAccountLeased(id) { return leasedAccountIds.has(id); }
export function leaseAccount(account) {
  leasedAccountIds.add(account.id);
  setAccountStatus(account.id, "running");
}
export function unleaseAccount(accountId) {
  leasedAccountIds.delete(accountId);
  const acc = getAccountById(accountId);
  if (acc && !["signed_out", "error", "disabled", "needs_reauth"].includes(acc.status)) {
    setAccountStatus(accountId, "ready", true);
  }
}

export function getAvailableFleetAccounts(excludeIds = []) {
  const ready = listReadyAccountsWithAbs();
  const now = Date.now();
  return ready.filter((acc) => {
    if (leasedAccountIds.has(acc.id)) return false;
    if (recyclingAccountIds.has(acc.id)) return false;
    if (excludeIds.includes(acc.id)) return false;
    const qUntil = quarantinedAccountIds.get(acc.id);
    if (qUntil && qUntil > now) return false;
    return true;
  });
}

async function acquireAccount(timeoutMs = 60000, excludeIds = []) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const activeExcludes = Array.isArray(excludeIds) ? [...excludeIds] : [];
    const now = Date.now();
    for (const [qId, qUntil] of quarantinedAccountIds.entries()) {
      if (qUntil > now && !activeExcludes.includes(qId)) {
        activeExcludes.push(qId);
      }
    }
    for (const leasedId of leasedAccountIds) {
      if (!activeExcludes.includes(leasedId)) {
        activeExcludes.push(leasedId);
      }
    }
    for (const recId of recyclingAccountIds) {
      if (!activeExcludes.includes(recId)) {
        activeExcludes.push(recId);
      }
    }

    const claimed = claimNextReadyAccount(activeExcludes);
    if (claimed) {
      leasedAccountIds.add(claimed.id);
      return withAbs(claimed);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("All Gemini accounts are busy — try again in a moment");
}

export async function runBatch(tasks) {
  const results = await Promise.all(
    tasks.map((task) =>
      limit(async () => {
        try {
          const buffer = await generateImage(task);
          return { buffer };
        } catch (err) {
          console.error(`[batch] Item failed: ${err.message}`);
          return null;
        }
      })
    )
  );
  return results.map((res, idx) => ({ taskIndex: idx, success: !!res?.buffer, buffer: res?.buffer || null }));
}

export async function runFleetBatch(tasks, onCheckpoint = null, options = {}) {
  const { signal } = options;
  if (signal?.aborted) return [];

  const allUsable = listAccountsWithAbs().filter((a) => a.active === 1 && a.status !== "disabled" && a.status !== "error" && a.status !== "signed_out");
  if (allUsable.length === 0) {
    throw new Error("No Gemini account is ready");
  }

  const results = [];
  const pending = tasks.map((task, idx) => ({ task, taskIndex: idx, retries: 0, failedAccountIds: [] }));

  const workerCount = Math.max(1, Math.min(tasks.length, allUsable.length, MAX_CONCURRENT));
  if (signal) activeBatchSignals.add(signal);

  async function fleetWorker() {
    while (pending.length > 0) {
      if (signal?.aborted) { break; }
      const item = pending.shift();
      if (!item) break;
      const { task, taskIndex } = item;

      let account = null;
      let pendingTeardown = null;
      try {
        if (signal?.aborted) { break; }
        account = await acquireAccount(60000, item.failedAccountIds || []);
        if (signal?.aborted) {
          unleaseAccount(account.id);
          break;
        }

        // 8-second tab heartbeat check before dispatching tasks (only if warm page exists)
        if (activeAccountPages.has(account.id)) {
          const isAlive = await checkTabHeartbeat(account, 8000);
          if (!isAlive) {
            unleaseAccount(account.id);
            quarantinedAccountIds.set(account.id, Date.now() + 5000);
            pending.unshift(item); // Re-queue item immediately without penalty
            continue;
          }
        }

        await acquireGlobalLaunchSlot();

        const buffer = await raceWithSignal(
          generateImageOnAccount(account, task, { signal }),
          signal,
          () => {
            const reg = activeAccountPages.get(account.id);
            if (reg?.page) {
              reg.page.evaluate(() => window.stop()).catch(() => {});
              reg.page.goto("about:blank", { timeout: 1000 }).catch(() => {});
            }
          }
        );

        let checkpoint = null;
        if (typeof onCheckpoint === "function" && !signal?.aborted) {
          checkpoint = await onCheckpoint({ buffer, taskIndex, task, account }).catch(() => null);
        }
        results.push({ buffer, taskIndex, checkpoint });

        // Periodic context recycling (Anti-Memory Creep) after 15 designs per account
        if (account) {
          const genCount = (accountSessionGenerations.get(account.id) || 0) + 1;
          accountSessionGenerations.set(account.id, genCount);
          if (genCount >= 15) {
            if (isInteractiveAuthActive) {
              console.log(`[fleet] Interactive auth active, deferring browser context recycling for ${account.id}...`);
            } else {
              console.log(`[fleet] Account ${account.id} completed ${genCount} designs in current session. Recycling browser context to flush Chromium RAM bloat...`);
              recyclingAccountIds.add(account.id);
              pendingTeardown = (async () => {
                try {
                  await closeProfile(account.id);
                } catch (_) {} finally {
                  recyclingAccountIds.delete(account.id);
                  accountSessionGenerations.set(account.id, 0);
                }
              })();
            }
          }
        }
      } catch (err) {
        if (account) {
          accountSessionGenerations.set(account.id, 0);
        }
        if (err?.name === "AbortError" || signal?.aborted) {
          console.log(`[fleet] Item ${taskIndex} cancelled by user (abort).`);
          if (account) {
            pendingTeardown = closeProfile(account.id).catch(() => {});
          }
          break;
        }

        console.error(`[fleet] Item ${taskIndex} failed on ${account ? account.id : "unassigned"}: ${err.message}`);
        const msg = (err?.message || "").toLowerCase();
        const isAuthDrop = msg.includes("session_expired") || msg.includes("login");
        const isHardQuota = msg.includes("daily limit") || msg.includes("reached your limit") || msg.includes("quota exceeded");
        const isHardPolicy = msg.includes("third-party content providers") || msg.includes("interests of third-party");
        const isTimeout = msg.includes("timed out");

        if (account && (isTimeout || isAuthDrop)) {
          console.log(`[fleet] Closing profile context for ${account.id} due to ${isTimeout ? "timeout" : "auth drop"}...`);
          pendingTeardown = closeProfile(account.id).catch(() => {});
        }

        if (account) {
          item.failedAccountIds = item.failedAccountIds || [];
          item.failedAccountIds.push(account.id);

          if (isHardQuota) {
            quarantinedAccountIds.set(account.id, Date.now() + 15 * 60 * 1000);
            console.warn(`[fleet] Account ${account.id} hit daily limit. Benched for 15 minutes.`);
          } else if (!isHardPolicy && !isAuthDrop) {
            quarantinedAccountIds.set(account.id, Date.now() + 10 * 1000);
            console.warn(`[fleet] Account ${account.id} soft-cooldown (10s).`);
          }
        }

        if (!isHardPolicy && item.retries < 2 && !signal?.aborted) {
          item.retries++;
          console.log(`[fleet] Re-routing item ${taskIndex} (attempt ${item.retries + 1}/3) to alternate account...`);
          pending.push(item);
        } else {
          console.error(`[fleet] Item ${taskIndex} permanently failed: ${err.message}`);
          if (typeof options?.onItemError === "function") {
            await options.onItemError({ taskIndex, task, error: err, account }).catch(() => {});
          }
        }
      } finally {
        if (pendingTeardown) {
          try {
            await pendingTeardown;
          } catch (_) {}
        }
        if (account) {
          unleaseAccount(account.id);
          unregisterAccountPage(account.id);
        }
      }
    }
  }

  let heartbeatInterval = null;
  if (typeof options?.onHeartbeat === "function") {
    heartbeatInterval = setInterval(() => {
      try { options.onHeartbeat(); } catch (_) {}
    }, 15000);
  }

  try {
    await Promise.all(Array.from({ length: workerCount }, () => fleetWorker()));
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
  }
  if (signal) activeBatchSignals.delete(signal);
  results.sort((a, b) => a.taskIndex - b.taskIndex);
  return results;
}

function raceWithSignal(promise, signal, onAbort) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbortHandler = () => {
      try { onAbort?.(); } catch (_) {}
      reject(Object.assign(new Error("Generation cancelled by user"), { name: "AbortError" }));
    };
    if (signal.aborted) { onAbortHandler(); return; }
    signal.addEventListener("abort", onAbortHandler, { once: true });
    promise.then(
      (val) => { signal.removeEventListener("abort", onAbortHandler); resolve(val); },
      (err) => { signal.removeEventListener("abort", onAbortHandler); reject(err); }
    );
  });
}

export function cancelAllRunningFleetTasks() {
  quarantinedAccountIds.clear();
  accountSessionGenerations.clear();
  recyclingAccountIds.clear();
  for (const sig of activeBatchSignals) {
    try { sig.abort(); } catch (_) {}
  }
  activeBatchSignals.clear();

  const released = leasedAccountIds.size;
  for (const accountId of Array.from(leasedAccountIds)) {
    try {
      unleaseAccount(accountId);
      unregisterAccountPage(accountId);
    } catch (_) {}
  }
  return { success: true, released };
}

export async function purgeFleetBrowsers() {
  if (isInteractiveAuthActive) {
    console.log("[queue] Interactive sign-in active, skipping fleet purge");
    return;
  }
  return purgeFleetBrowsersBrowser();
}
