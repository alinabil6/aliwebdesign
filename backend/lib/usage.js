// ────────────────────────────────────────────────
// Usage tracking — turns the generation log into the daily/weekly percentage
// meters shown on the Gemini Accounts view, and ranks accounts so generation
// is routed to the one with the most quota headroom.
//
// HONESTY NOTE (mirrors ALIWEBDESIGN_BUILD_SPEC.md §5): Google exposes no
// "how much quota is left" endpoint for consumer Gemini, so every percentage
// here is SELF-TRACKED — counted from generation_log rows against caps this
// app owns. It is an estimate you maintain, not a live pull of Google's
// dashboard. The caps are environment-overridable so they can follow whatever
// figure you decide to budget per account.
// ────────────────────────────────────────────────
import {
  generationCountsSince,
  countAllGenerationsSince,
  totalGenerationsFor,
} from "./db.js";

/** Per-account daily generation cap the meters track against. */
export const DAILY_CAP = normalizeCap(process.env.GEMINI_DAILY_CAP, 100);
/** Per-account weekly generation cap the meters track against. */
export const WEEKLY_CAP = normalizeCap(process.env.GEMINI_WEEKLY_CAP, 500);
/** Weekly window anchor: Monday 00:00 local time (the reset moment). */
const WEEK_START_DOW_OFFSET = 1; // JS getDay(): Sun=0 … Sat=6 → Monday = 1

function normalizeCap(raw, fallback) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ────────────────────────────────────────────────
// Window math — LOCAL time, because "resets at midnight" means the user's
// midnight, not UTC's. All results are epoch ms so they compare cleanly
// against generation_log.ts. Date arithmetic goes through setDate() rather
// than +86400000 so DST shifts don't drift the reset across an hour.
// ────────────────────────────────────────────────

/**
 * Resolves user/frontend timezone parameter to standard IANA timezone.
 * Morocco GMT+0 maps to UTC to prevent V8's outdated GMT+1 tzdata from adding 1 hour.
 */
export function resolveTimezone(tz) {
  if (!tz || tz === "auto") return null;
  if (tz === "Africa/Casablanca-gmt0") return "UTC";
  if (tz === "Africa/Casablanca-gmt1") return "Etc/GMT-1";
  return tz;
}

export function getZonedParts(epochMs, timeZone) {
  const d = new Date(epochMs);
  const tz = resolveTimezone(timeZone);
  if (!tz) {
    return {
      year: d.getFullYear(),
      month: d.getMonth(),
      date: d.getDate(),
      day: d.getDay(),
      hours: d.getHours(),
      minutes: d.getMinutes(),
      seconds: d.getSeconds(),
    };
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(d).map((p) => [p.type, p.value]));
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10) - 1,
    date: parseInt(parts.day, 10),
    day: days[parts.weekday] ?? 0,
    hours: parseInt(parts.hour === "24" ? "0" : parts.hour, 10),
    minutes: parseInt(parts.minute, 10),
    seconds: parseInt(parts.second, 10),
  };
}

export function startOfLocalDay(now = new Date(), tz = null) {
  const epoch = typeof now === "number" ? now : new Date(now).getTime();
  const parts = getZonedParts(epoch, tz);
  const elapsedMs = (parts.hours * 3600 + parts.minutes * 60 + parts.seconds) * 1000 + (epoch % 1000);
  return epoch - elapsedMs;
}

export function nextLocalMidnight(now = new Date(), tz = null) {
  return startOfLocalDay(now, tz) + 86400000;
}

export function startOfLocalWeek(now = new Date(), tz = null) {
  const epoch = typeof now === "number" ? now : new Date(now).getTime();
  const dayStart = startOfLocalDay(epoch, tz);
  const parts = getZonedParts(epoch, tz);
  const daysSinceMon = (parts.day + 6) % 7;
  return dayStart - daysSinceMon * 86400000;
}

export function nextLocalWeekStart(now = new Date(), tz = null) {
  return startOfLocalWeek(now, tz) + 7 * 86400000;
}

/** Count → 0–100 percentage against a cap, clamped (over-cap shows 100). */
export function usagePct(count, cap) {
  if (!cap || cap <= 0) return 0;
  return Math.max(0, Math.min(100, (count / cap) * 100));
}

/**
 * Parse a SQLite UTC datetime ("YYYY-MM-DD HH:MM:SS") into epoch ms. JS reads
 * that space-separated shape as LOCAL time, so re-tag it as UTC explicitly.
 * Accepts real ISO strings too. Returns null for null/unparseable.
 */
export function sqliteTs(value) {
  if (value == null) return null;
  const s = String(value);
  const iso = s.includes("T") ? s : `${s.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Per-account usage view used by both the API payload and account routing.
 * `accountRows` are browser_accounts rows (any shape — only id/status/
 * last_used_at are read). Returns a Map keyed by account id:
 *   { daily: {count, cap, pct, resetsAt}, weekly: {…}, totalGenerations,
 *     lastUsedAt, lastUsedTs }
 * resetsAt values are ISO UTC of the next local-midnight / next-Monday reset.
 */
export function buildUsageById(accountRows, now = Date.now(), tz = null) {
  const dayStart = startOfLocalDay(now, tz);
  const weekStart = startOfLocalWeek(now, tz);
  const dailyCounts = generationCountsSince(dayStart);
  const weeklyCounts = generationCountsSince(weekStart);
  const dailyResetIso = new Date(nextLocalMidnight(now, tz)).toISOString();
  const weeklyResetIso = new Date(nextLocalWeekStart(now, tz)).toISOString();

  const byId = new Map();
  for (const row of accountRows) {
    const dailyCount = dailyCounts[row.id] ?? 0;
    const weeklyCount = weeklyCounts[row.id] ?? 0;
    const lastUsedTs = sqliteTs(row.last_used_at);
    byId.set(row.id, {
      daily: { count: dailyCount, cap: DAILY_CAP, pct: usagePct(dailyCount, DAILY_CAP), resetsAt: dailyResetIso },
      weekly: { count: weeklyCount, cap: WEEKLY_CAP, pct: usagePct(weeklyCount, WEEKLY_CAP), resetsAt: weeklyResetIso },
      totalGenerations: totalGenerationsFor(row.id),
      lastUsedAt: lastUsedTs == null ? null : new Date(lastUsedTs).toISOString(),
      lastUsedTs,
    });
  }
  return byId;
}

/**
 * Rank ready accounts for the next generation — "the best result" from
 * linking daily + weekly + last-used data:
 *   1. accounts with quota headroom beat capped-out ones;
 *   2. bigger headroom (the BINDING constraint, i.e. the lower of the daily
 *      and weekly remaining fractions) wins;
 *   3. ties rotate least-recently-used, never-used (NULL last_used_at) first —
 *      the exact ordering the old pure-LRU rotation used.
 * Returns the ranked array [{ id, row, usage, remainingDaily, remainingWeekly,
 * headroom, exhausted, lruTs }] — [0] is the pick.
 */
export function rankReadyByHeadroom(accountRows, now = Date.now(), tz = null) {
  const usageById = buildUsageById(accountRows, now, tz);
  return accountRows
    .filter((r) => r.status === "ready")
    .map((row) => {
      const usage = usageById.get(row.id);
      const remainingDaily = Math.max(0, 1 - usage.daily.count / DAILY_CAP);
      const remainingWeekly = Math.max(0, 1 - usage.weekly.count / WEEKLY_CAP);
      const exhausted = usage.daily.count >= DAILY_CAP || usage.weekly.count >= WEEKLY_CAP;
      return {
        id: row.id,
        row,
        usage,
        remainingDaily,
        remainingWeekly,
        headroom: Math.min(remainingDaily, remainingWeekly),
        exhausted,
        // NULL (never used) sorts first — same NULLS-FIRST as the old rotation.
        lruTs: usage.lastUsedTs ?? -Infinity,
      };
    })
    .sort(
      (a, b) =>
        (a.exhausted ? 1 : 0) - (b.exhausted ? 1 : 0) ||
        b.headroom - a.headroom ||
        a.lruTs - b.lruTs
    );
}

/**
 * Full payload for GET /api/accounts (and /api/accounts/usage): per-account
 * usage, fleet totals, and the "best to use next" recommendation with a
 * human-readable reason. `accountRows` = listAccounts() rows.
 */
export function buildUsagePayload(accountRows, now = Date.now(), tz = null) {
  const usageById = buildUsageById(accountRows, now, tz);
  const fleetDaily = countAllGenerationsSince(startOfLocalDay(now, tz));
  const fleetWeekly = countAllGenerationsSince(startOfLocalWeek(now, tz));
  const readyRows = accountRows.filter((r) => r.status === "ready");
  const ranked = rankReadyByHeadroom(accountRows, now, tz);
  const pick = ranked[0] ?? null;

  const best = pick
    ? {
        id: pick.id,
        email: pick.row.email,
        reason: pick.exhausted
          ? "all ready accounts at cap — most weekly headroom left"
          : `most headroom — ${Math.round(pick.remainingDaily * 100)}% daily / ${Math.round(
              pick.remainingWeekly * 100
            )}% weekly left`,
      }
    : null;

  return {
    caps: { daily: DAILY_CAP, weekly: WEEKLY_CAP, weeklyAnchor: "monday-local" },
    usage: Object.fromEntries(usageById),
    fleet: {
      accounts: accountRows.length,
      ready: readyRows.length,
      generationsToday: fleetDaily,
      generationsWeek: fleetWeekly,
      dailyPct: usagePct(fleetDaily, Math.max(1, DAILY_CAP * accountRows.length)),
      weeklyPct: usagePct(fleetWeekly, Math.max(1, WEEKLY_CAP * accountRows.length)),
      resetDailyAt: new Date(nextLocalMidnight(now, tz)).toISOString(),
      resetWeeklyAt: new Date(nextLocalWeekStart(now, tz)).toISOString(),
    },
    best,
  };
}
