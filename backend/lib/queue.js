import pLimit from "p-limit";
import { generateImage, generateImageOnAccount } from "./gemini.js";
import { listReadyAccountsWithAbs, listAccountsWithAbs } from "./accounts.js";
import { setAccountStatus, getAccountById } from "./db.js";

const limit = pLimit(5);
const leasedAccountIds = new Set();
const quarantinedAccountIds = new Map();

const activeBatchSignals = new Set();
const activeAccountPages = new Map();

let lastGlobalLaunchTime = 0;
async function acquireGlobalLaunchSlot() {
  const minInterval = 2500;
  const now = Date.now();
  const waitMs = Math.max(0, lastGlobalLaunchTime + minInterval - now);
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
    setAccountStatus(accountId, "ready");
  }
}

export function getAvailableFleetAccounts(excludeIds = []) {
  const ready = listReadyAccountsWithAbs();
  const now = Date.now();
  return ready.filter((acc) => {
    if (leasedAccountIds.has(acc.id)) return false;
    if (excludeIds.includes(acc.id)) return false;
    const qUntil = quarantinedAccountIds.get(acc.id);
    if (qUntil && qUntil > now) return false;
    return true;
  });
}

async function acquireAccount(timeoutMs = 60000, excludeIds = []) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const available = getAvailableFleetAccounts(excludeIds);
    if (available.length > 0) {
      const picked = available[0];
      leaseAccount(picked);
      return picked;
    }
    await new Promise((r) => setTimeout(r, 400));
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

  const workerCount = Math.max(1, Math.min(tasks.length, allUsable.length));
  if (signal) activeBatchSignals.add(signal);

  async function fleetWorker() {
    while (pending.length > 0) {
      if (signal?.aborted) { pending.length = 0; break; }
      const item = pending.shift();
      if (!item) break;
      const { task, taskIndex } = item;

      let account = null;
      try {
        account = await acquireAccount(60000, item.failedAccountIds || []);
        if (signal?.aborted) {
          unleaseAccount(account.id);
          pending.length = 0;
          break;
        }

        await acquireGlobalLaunchSlot();

        const buffer = await raceWithSignal(
          generateImageOnAccount(account, task),
          signal,
          () => {
            const reg = activeAccountPages.get(account.id);
            if (reg?.page) reg.page.evaluate(() => window.stop()).catch(() => {});
          }
        );

        let checkpoint = null;
        if (typeof onCheckpoint === "function" && !signal?.aborted) {
          checkpoint = await onCheckpoint({ buffer, taskIndex, task, account }).catch(() => null);
        }
        results.push({ buffer, taskIndex, checkpoint });
      } catch (err) {
        if (err?.name === "AbortError") {
          console.log(`[fleet] Item ${taskIndex} cancelled by user (abort).`);
          pending.length = 0;
          break;
        }

        console.error(`[fleet] Item ${taskIndex} failed on ${account ? account.id : "unassigned"}: ${err.message}`);
        const msg = (err?.message || "").toLowerCase();
        const isAuthDrop = msg.includes("session_expired") || msg.includes("login");
        const isHardQuota = msg.includes("daily limit") || msg.includes("reached your limit") || msg.includes("quota exceeded");
        const isHardPolicy = msg.includes("third-party content providers") || msg.includes("interests of third-party");

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

        if (!isHardPolicy && item.retries < 2) {
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
        if (account) {
          unleaseAccount(account.id);
          unregisterAccountPage(account.id);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => fleetWorker()));
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
