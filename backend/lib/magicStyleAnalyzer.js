
async function runConcurrentPool(items, limit, iteratorFn) {
  const results = new Array(items.length);
  let currentIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      results[idx] = await iteratorFn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}
// ────────────────────────────────────────────────────────────
// Per-Design Magic Style Analyzer — evaluates EACH uploaded
// design against the +60 style taxonomy and returns structured
// JSON (primary style, alternatives, visual keypoints, niche
// angle). Runs analyses in parallel across the pooled account
// engine (one account per design, round-robin) so a full batch
// stays fast.
// ────────────────────────────────────────────────────────────

import fs from "fs";
import os from "os";
import path from "path";
import { acquire, release } from "./accountPool.js";
import * as web from "./geminiweb.js";
import {
    DEFAULT_STYLE_ID,
    getStyleById,
    getStyleOrDefault,
    styleIdList,
    styleSummaries,
} from "./stylesRegistry.js";

// Hard cap per design slot — keeps the whole batch round-trip under 30s.
const SLOT_TIMEOUT_MS = 25_000;

/** Race a promise against a timeout; the loser resolves to null. */
function withTimeout(promise, ms) {
    let timer = null;
    const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const ANALYSIS_INSTRUCTIONS = `Return raw JSON only. Do not write introductory words or markdown blocks. Analyze the uploaded graphic's subject, vibe, and illustration technique. Select the BEST matching artistic style from the catalog below. You MUST NOT select structural or layout tags. Focus strictly on visual art medium, era, illustration technique, and textures (e.g., Vintage Handdrawn, Western Etching, 90s Heavy Metal Acid Wash, Collegiate Font Evolution, Vintage Folk Art Lino Cut).

Available artistic style IDs: ${styleIdList()}

Artistic style details:
${styleSummaries()}

Exact JSON shape:
{
  "primaryStyle": { "id": "<best matching style id>", "name": "<its display name>", "description": "<one sentence on how this style fits the design>" },
  "alternativeStyles": [ { "id": "<alt style id>", "name": "<alt style display name>" } ],
  "visualKeypoints": [ "<2-3 short bullets on linework, palette, texture>" ],
  "commercialNicheAngle": "<one sentence on the best market/niche angle>"
}

Rules:
- primaryStyle.id MUST be one of the listed artistic style ids.
- alternativeStyles: 1 to 3 entries, ids MUST be listed artistic style ids, and must differ from primaryStyle.id.
- visualKeypoints: exactly 2 to 3 concise bullets.
- Keep every string short and concrete.`;

function buildUserTurn({ index, feature }) {
    const parts = [];
    if (feature) parts.push(`Feature: ${feature}`);
    parts.push(
        `Design #${index + 1} is attached. Analyze its linework, shading, typography lockup, texture, and color palette, then pick the closest style from the taxonomy.`
    );
    parts.push(ANALYSIS_INSTRUCTIONS);
    return parts.join("\n\n");
}

/** Extract the first JSON object from a model reply (handles fences/prose). */
function parseAnalysis(text) {
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
        const obj = JSON.parse(m[0]);
        if (obj && typeof obj.primaryStyle === "object") return obj;
    } catch {
        /* fall through */
    }
    return null;
}

/** Normalize a parsed analysis into a safe, registry-valid record. */
function normalizeAnalysis(parsed, index) {
    const primary = getStyleOrDefault(parsed?.primaryStyle?.id || DEFAULT_STYLE_ID);
    const alts = (parsed?.alternativeStyles || [])
        .map((a) => getStyleById(typeof a === "string" ? a : a?.id))
        .filter((s) => s && s.id !== primary.id)
        .slice(0, 3)
        .map((s) => ({ id: s.id, name: s.name }));

    const keypoints = (parsed?.visualKeypoints || [])
        .filter((k) => typeof k === "string" && k.trim())
        .slice(0, 3)
        .map((k) => k.trim());
    while (keypoints.length < 2) keypoints.push("Balanced composition with strong print contrast.");

    return {
        designIndex: index,
        primaryStyle: {
            id: primary.id,
            name: primary.name,
            description:
                typeof parsed?.primaryStyle?.description === "string" && parsed.primaryStyle.description.trim()
                    ? parsed.primaryStyle.description.trim()
                    : primary.directive.slice(0, 140),
        },
        alternativeStyles: alts,
        visualKeypoints: keypoints,
        commercialNicheAngle:
            typeof parsed?.commercialNicheAngle === "string" && parsed.commercialNicheAngle.trim()
                ? parsed.commercialNicheAngle.trim()
                : "Broad appeal across print-on-demand apparel and accessories.",
    };
}

/**
 * Analyze ONE design image against the style taxonomy.
 * @param {object} opts
 * @param {Buffer} opts.imageBuffer - the design image bytes
 * @param {number} opts.index       - 0-based design index (echoed back)
 * @param {string} [opts.feature]   - originating feature name
 * @returns {Promise<object>} normalized analysis record
 */
export async function analyzeDesignStyle({ imageBuffer, index = 0, feature = "" }) {
    // Acquire an authenticated slot from the pool — never create an ad-hoc
    // or unauthenticated browser instance for style analysis.
    const slot = await acquire();
    try {
        let imagePath = null;
        if (Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0) {
            imagePath = path.join(os.tmpdir(), `magic-style-${Date.now()}-${index}.png`);
            await fs.promises.writeFile(imagePath, imageBuffer);
        }

        try {
            let reply = null;
            try {
                reply = await withTimeout(
                    web.generateText({
                        prompt: buildUserTurn({ index, feature }),
                        imagePaths: imagePath ? [imagePath] : [],
                        page: slot.page,
                    }),
                    SLOT_TIMEOUT_MS
                );
            } catch {
                reply = null;
            }
            if (reply === null) {
                if (slot?.page && !slot.page.isClosed?.()) {
                  try { await slot.page.goto?.("about:blank"); } catch (_) {}
                }
                // Timeout or failure — do NOT fail the request. Fall back to a random
                // high-converting style so the UI stays smooth and unblocked.
                return fallbackAnalysis(index, `timed out after ${SLOT_TIMEOUT_MS / 1000}s`);
            }
            const parsed = parseAnalysis(reply);
            if (!parsed) {
                return fallbackAnalysis(index, "unparseable model reply");
            }
            return normalizeAnalysis(parsed, index);
        } finally {
            if (imagePath) await fs.promises.unlink(imagePath).catch(() => { });
        }
    } finally {
        // Always release the slot back so the fleet's ready status stays accurate.
        await release(slot);
    }
}

/** High-converting styles used when a slot times out or the reply is bad. */
const FALLBACK_STYLE_IDS = [
    "vintage-japanese-woodblock",
    "bootleg-rap-tee-design",
    "vintage-woodcut",
    "retro-national-park-adventure-badge",
    "vintage-field-guide",
];

/** Build a graceful fallback analysis with a random high-converting style. */
function fallbackAnalysis(index, reason) {
    const id = FALLBACK_STYLE_IDS[Math.floor(Math.random() * FALLBACK_STYLE_IDS.length)];
    const style = getStyleOrDefault(id);
    return {
        designIndex: index,
        primaryStyle: {
            id: style.id,
            name: style.name,
            description: style.directive.slice(0, 140),
        },
        alternativeStyles: [],
        visualKeypoints: ["Analysis timed out — high-converting style applied."],
        commercialNicheAngle: "Broad appeal across print-on-demand apparel and accessories.",
        error: reason,
    };
}

/**
 * Analyze MANY designs in parallel across the pooled account engine.
 * Each design is dispatched to its own account (round-robin via
 * pickReadyAccount) so a full batch completes in roughly one round-trip.
 * @param {object} opts
 * @param {Buffer[]} opts.imageBuffers - design image bytes, one per design
 * @param {string}  [opts.feature]     - originating feature name
 * @returns {Promise<object[]>} analyses aligned with input order
 */
export async function analyzeDesignStyles({ imageBuffers = [], feature = "" }) {
  if (!imageBuffers.length) return [];
  return await runConcurrentPool(imageBuffers, 2, async (buf, i) => {
    try {
      return await analyzeDesignStyle({ imageBuffer: buf, index: i, feature });
    } catch (err) {
      return {
        designIndex: i,
        primaryStyle: {
          id: DEFAULT_STYLE_ID,
          name: getStyleOrDefault(DEFAULT_STYLE_ID).name,
          description: "Analysis failed — default style applied.",
        },
        alternativeStyles: [],
        visualKeypoints: ["Analysis unavailable for this design."],
        commercialNicheAngle: "Broad appeal across print-on-demand apparel and accessories.",
        error: err?.message || "analysis failed",
      };
    }
  });
}