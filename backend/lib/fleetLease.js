// ────────────────────────────────────────────────────────────
// Fleet Account Lease Registry — backend/lib/fleetLease.js
//
// Single shared in-memory lease and exclusion registry for all
// worker pools (Image Generation fleet, Magic Listing, Edit).
//
// Guarantees:
// 1. Exclusive lease semantics — an account can only be leased once at a time.
// 2. Centralized quarantine & recycling management.
// 3. Durable DB status coordination with in-memory gating.
// ────────────────────────────────────────────────────────────
import { claimNextReadyAccount, getAccountById, setAccountStatus } from "./db.js";
import { withAbs } from "./accounts.js";

// In-memory lease tracking (shared across all worker pools)
const leasedAccountIds = new Set();
const quarantinedAccountIds = new Map(); // accountId -> unquarantineTimestamp (ms)
const recyclingAccountIds = new Set();

/**
 * Check if an account is currently leased by any worker pool.
 */
export function isLeased(accountId) {
  if (!accountId) return false;
  return leasedAccountIds.has(accountId);
}

/**
 * Check if an account is currently quarantined (e.g. rate limit, cooldown).
 * Automatically cleans up expired quarantine records.
 */
export function isQuarantined(accountId) {
  if (!accountId) return false;
  const until = quarantinedAccountIds.get(accountId);
  if (!until) return false;
  if (until > Date.now()) return true;
  quarantinedAccountIds.delete(accountId);
  return false;
}

/**
 * Quarantine an account until Date.now() + durationMs.
 */
export function quarantine(accountId, durationMs) {
  if (!accountId || durationMs <= 0) return;
  quarantinedAccountIds.set(accountId, Date.now() + durationMs);
}

/**
 * Remove an account from quarantine immediately.
 */
export function clearQuarantine(accountId) {
  if (!accountId) return;
  quarantinedAccountIds.delete(accountId);
}

/**
 * Clear all quarantined accounts.
 */
export function clearAllQuarantines() {
  quarantinedAccountIds.clear();
}

/**
 * Check if an account is currently undergoing browser recycling.
 */
export function isRecycling(accountId) {
  if (!accountId) return false;
  return recyclingAccountIds.has(accountId);
}

/**
 * Mark an account as undergoing browser context recycling.
 */
export function startRecycling(accountId) {
  if (!accountId) return;
  recyclingAccountIds.add(accountId);
}

/**
 * Remove an account from the recycling set.
 */
export function stopRecycling(accountId) {
  if (!accountId) return;
  recyclingAccountIds.delete(accountId);
}

/**
 * Clear all recycling account states.
 */
export function clearAllRecycling() {
  recyclingAccountIds.clear();
}

/**
 * Atomically attempt to lease an account in memory.
 * Returns true if the lease was granted, false otherwise.
 */
export function tryLease(accountId) {
  if (!accountId) return false;
  if (leasedAccountIds.has(accountId)) return false;
  if (recyclingAccountIds.has(accountId)) return false;
  if (isQuarantined(accountId)) return false;

  leasedAccountIds.add(accountId);
  setAccountStatus(accountId, "running");
  return true;
}

/**
 * Release an account from the in-memory lease and restore DB status to 'ready'
 * (unless the account transitioned to a terminal error/disabled state).
 */
export function release(accountId) {
  if (!accountId) return;
  leasedAccountIds.delete(accountId);
  const acc = getAccountById(accountId);
  if (acc && !["signed_out", "error", "disabled", "needs_reauth"].includes(acc.status)) {
    setAccountStatus(accountId, "ready", true);
  }
}

/**
 * Get all account IDs that must be excluded from new claims:
 * - Currently leased accounts
 * - Accounts being recycled
 * - Currently active quarantined accounts
 * - Any caller-specified excludeIds
 */
export function getActiveExcludes(extraExcludes = []) {
  const excludes = new Set(Array.isArray(extraExcludes) ? extraExcludes : []);
  const now = Date.now();

  for (const leasedId of leasedAccountIds) {
    excludes.add(leasedId);
  }

  for (const recId of recyclingAccountIds) {
    excludes.add(recId);
  }

  for (const [qId, qUntil] of quarantinedAccountIds.entries()) {
    if (qUntil > now) {
      excludes.add(qId);
    } else {
      quarantinedAccountIds.delete(qId);
    }
  }

  return Array.from(excludes);
}

/**
 * Acquire an account with exclusive lease semantics.
 * Gated by both SQLite atomic claim and the shared in-memory lease.
 */
export async function acquireFleetAccount({ timeoutMs = 60000, excludeIds = [] } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const activeExcludes = getActiveExcludes(excludeIds);
    const claimed = claimNextReadyAccount(activeExcludes);
    if (claimed) {
      if (tryLease(claimed.id)) {
        return withAbs(claimed);
      }
      // If in-memory tryLease failed (e.g. race condition), release DB claim and retry
      release(claimed.id);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("All Gemini accounts are busy — try again in a moment");
}

/**
 * Snapshot of currently leased account IDs.
 */
export function getLeasedAccountIds() {
  return Array.from(leasedAccountIds);
}

/**
 * Release all leased accounts and clear in-memory registries.
 * Used during batch cancellations and emergency halts.
 */
export function releaseAll() {
  quarantinedAccountIds.clear();
  recyclingAccountIds.clear();
  const count = leasedAccountIds.size;
  for (const accountId of Array.from(leasedAccountIds)) {
    try {
      release(accountId);
    } catch (_) {}
  }
  return { success: true, released: count };
}
