import os from "os";
import pLimit from "p-limit";
import { generateImage, generateImageOnAccount } from "./gemini.js";
import { listReadyAccountsWithAbs, listAccountsWithAbs, withAbs } from "./accounts.js";
import { setAccountStatus, getAccountById, claimNextReadyAccount } from "./db.js";
import {
  getProfilePage,
  closeProfile,
  canLaunchBrowser,
  isInteractiveAuthActive,
  purgeFleetBrowsers as purgeFleetBrowsersBrowser,
  incrementActiveBatches,
  decrementActiveBatches,
  touchAccountSession,
  parkAccountPageWhileLeased,
  scheduleIdleClose,
  releaseAndScheduleIdleClose,
  acquireGlobalLaunchSlot,
} from "./browser.js";
import {
  isLeased,
  tryLease,
  release as releaseLease,
  isQuarantined,
  quarantine,
  clearQuarantine,
  clearAllQuarantines,
  isRecycling,
  startRecycling,
  stopRecycling,
  clearAllRecycling,
  getActiveExcludes,
  acquireFleetAccount,
  getLeasedAccountIds,
  releaseAll as releaseAllLeases,
} from "./fleetLease.js";

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

export const MAX_CONCURRENT = parseInt(process.env.MAX_FLEET_CONCURRENT || "8", 10);
const limit = pLimit(MAX_CONCURRENT);
const accountSessionGenerations = new Map();

const activeBatchSignals = new Set();
const activeAccountPages = new Map();



export function registerBatchSignal(signal) { if (signal) activeBatchSignals.add(signal); }
export function unregisterBatchSignal(signal) { if (signal) activeBatchSignals.delete(signal); }
export function registerAccountPage(accountId, page, cancelCallback = null) {
  if (accountId && page) activeAccountPages.set(accountId, { page, cancelCallback });
}
export function unregisterAccountPage(accountId) {
  if (accountId) activeAccountPages.delete(accountId);
}

export function isAccountLeased(id) { return isLeased(id); }
export function leaseAccount(account) { return tryLease(account?.id || account); }
export function unleaseAccount(accountId) { return releaseLease(accountId); }

export function getAvailableFleetAccounts(excludeIds = []) {
  const ready = listReadyAccountsWithAbs();
  const activeExcludes = new Set(getActiveExcludes(excludeIds));
  return ready.filter((acc) => !activeExcludes.has(acc.id));
}

async function acquireAccount(timeoutMs = 60000, excludeIds = []) {
  return acquireFleetAccount({ timeoutMs, excludeIds });
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

  incrementActiveBatches();

  const allUsable = listAccountsWithAbs().filter((a) => a.active === 1 && a.status !== "disabled" && a.status !== "error" && a.status !== "signed_out");
  if (allUsable.length === 0) {
    throw new Error("No Gemini account is ready");
  }

  const results = [];
  const pending = tasks.map((task, idx) => ({ task, taskIndex: idx, retries: 0, failedAccountIds: [], initialStartTime: Date.now() }));

  const totalMemGb = os.totalmem() / (1024 * 1024 * 1024);
  const safeSystemCap = totalMemGb >= 11.5 ? MAX_CONCURRENT : (totalMemGb >= 7.5 ? Math.min(MAX_CONCURRENT, 6) : 3);
  const workerCount = Math.max(1, Math.min(tasks.length, allUsable.length, safeSystemCap));
  if (signal) activeBatchSignals.add(signal);

  let activeInFlight = 0;
  let fleetDone = false;

  async function fleetWorker() {
    while (!fleetDone) {
      if (signal?.aborted) { break; }
      if (pending.length === 0) {
        if (activeInFlight === 0) {
          fleetDone = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      const item = pending.shift();
      if (!item) continue;
      activeInFlight++;
      const { task, taskIndex } = item;

      let account = null;
      let pendingTeardown = null;
      try {
        if (signal?.aborted) { break; }
        const excludeList = allUsable.length > 1 ? (item.failedAccountIds || []) : [];
        account = await acquireAccount(120000, excludeList);
        if (signal?.aborted) {
          unleaseAccount(account.id);
          break;
        }

        touchAccountSession(account.id);

        // 8-second tab heartbeat check before dispatching tasks (only if warm page exists)
        if (activeAccountPages.has(account.id)) {
          const isAlive = await checkTabHeartbeat(account, 8000);
          if (!isAlive) {
            unleaseAccount(account.id);
            quarantine(account.id, 5000);
            pending.unshift(item); // Re-queue item immediately without penalty
            continue;
          }
        }

        await acquireGlobalLaunchSlot();

        const taskStartTime = Date.now();
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
        const durationMs = Date.now() - taskStartTime;
        const totalDurationMs = Date.now() - (item.initialStartTime || taskStartTime);

        let checkpoint = null;
        if (typeof onCheckpoint === "function" && !signal?.aborted) {
          checkpoint = await onCheckpoint({
            buffer,
            taskIndex,
            task,
            account,
            durationMs,
            totalDurationMs,
            retried: item.retries > 0,
          }).catch(() => null);
        }
        results.push({ buffer, taskIndex, checkpoint, durationMs, totalDurationMs });

        // Periodic context recycling (Anti-Memory Creep) after 15 designs per account
        if (account) {
          const genCount = (accountSessionGenerations.get(account.id) || 0) + 1;
          accountSessionGenerations.set(account.id, genCount);
          if (genCount >= 15) {
            if (isInteractiveAuthActive) {
              console.log(`[fleet] Interactive auth active, deferring browser context recycling for ${account.id}...`);
            } else {
              console.log(`[fleet] Account ${account.id} completed ${genCount} designs in current session. Recycling browser context to flush Chromium RAM bloat...`);
              startRecycling(account.id);
              pendingTeardown = (async () => {
                try {
                  await closeProfile(account.id);
                } catch (_) {} finally {
                  stopRecycling(account.id);
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
        const isTimeout = msg.includes("timed out") || Boolean(err?.isTimeout) || err?.name === "GenerationTimeoutError";

        if (account && (isTimeout || isAuthDrop)) {
          console.log(`[fleet] Closing profile context for ${account.id} due to ${isTimeout ? "timeout" : "auth drop"}...`);
          pendingTeardown = closeProfile(account.id).catch(() => {});
        }

        if (account) {
          item.failedAccountIds = item.failedAccountIds || [];
          item.failedAccountIds.push(account.id);

          if (isHardQuota) {
            quarantine(account.id, 15 * 60 * 1000);
            console.warn(`[fleet] Account ${account.id} hit daily limit. Benched for 15 minutes.`);
          } else if (allUsable.length > 1) {
            if (isTimeout) {
              quarantine(account.id, 30 * 1000);
              console.warn(`[fleet] Account ${account.id} timed out. Quarantined for 30s.`);
            } else if (!isHardPolicy && !isAuthDrop) {
              quarantine(account.id, 10 * 1000);
              console.warn(`[fleet] Account ${account.id} soft-cooldown (10s).`);
            }
          } else {
            // Single account fleet: short 2s reset cooldown instead of 30s lockout
            quarantine(account.id, 2000);
            console.log(`[fleet] Single account fleet: 2s soft reset for ${account.id}.`);
          }
        }

        if (!isHardPolicy && item.retries < 1 && !signal?.aborted) {
          item.retries++;
          console.log(`[fleet] Re-routing item ${taskIndex} (attempt ${item.retries + 1}/2) to alternate account...`);
          if (typeof options?.onItemRetry === "function") {
            try {
              options.onItemRetry({ taskIndex, task, attempt: item.retries + 1, account });
            } catch (_) {}
          }
          pending.push(item);
        } else {
          console.error(`[fleet] Item ${taskIndex} permanently failed: ${err.message}`);
          if (typeof options?.onItemError === "function") {
            await options.onItemError({ taskIndex, task, error: err, account }).catch(() => {});
          }
        }
      } finally {
        activeInFlight--;
        if (pendingTeardown) {
          try {
            await pendingTeardown;
          } catch (_) {}
        }
        if (account) {
          // 1. Park tab at about:blank WHILE STILL LEASED so no sibling worker can acquire this account mid-navigation!
          await parkAccountPageWhileLeased(account.id).catch(() => {});
          // 2. Release lease so waiting sibling tasks can claim the clean account
          unleaseAccount(account.id);
          unregisterAccountPage(account.id);
          // 3. Arm the 90s idle process reaper (will only fire if no worker re-leases it)
          scheduleIdleClose(account.id);
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
    if (signal) activeBatchSignals.delete(signal);
    decrementActiveBatches();
  }
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
  accountSessionGenerations.clear();
  for (const sig of activeBatchSignals) {
    try { sig.abort(); } catch (_) {}
  }
  activeBatchSignals.clear();

  for (const accountId of getLeasedAccountIds()) {
    try {
      unregisterAccountPage(accountId);
    } catch (_) {}
  }
  if (!isInteractiveAuthActive) {
    purgeFleetBrowsersBrowser({ force: true }).catch(() => {});
  }
  return releaseAllLeases();
}

export async function purgeFleetBrowsers() {
  if (isInteractiveAuthActive) {
    console.log("[queue] Interactive sign-in active, skipping fleet purge");
    return;
  }
  return purgeFleetBrowsersBrowser();
}
