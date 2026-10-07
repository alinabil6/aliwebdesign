
const SELECTOR_TIMEOUT_MS = 25_000;
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
// ────────────────────────────────────────────────────────────
// Magic Style Selector — asks the Gemini web session to pick
// the best-matching style from the registry for a user prompt
// (and optionally a reference image), then returns the full
// style record. Falls back to the versatile default when the
// model's answer can't be parsed or doesn't match a known ID.
// ────────────────────────────────────────────────────────────

import fs from "fs";
import os from "os";
import path from "path";
import { acquire, release } from "./accountPool.js";
import * as web from "./geminiweb.js";
import {
    DEFAULT_STYLE_ID,
    getStyleOrDefault,
    styleIdList,
    styleSummaries,
    UNIVERSAL_NEGATIVE_PROMPT,
    STYLE_CATEGORIES,
    findStyleByName,
    findStylesByKeyword,
    getTaxonomies,
} from "./stylesRegistry.js";

export {
    DEFAULT_STYLE_ID,
    UNIVERSAL_NEGATIVE_PROMPT,
    STYLE_CATEGORIES,
    findStyleByName,
    findStylesByKeyword,
    getTaxonomies,
};

const SELECTION_INSTRUCTIONS = `Analyze the uploaded graphic's subject, vibe, and illustration technique. Select the BEST matching artistic style from the catalog below. You MUST NOT select structural or layout tags. Focus strictly on visual art medium, era, illustration technique, and textures (e.g., Vintage Handdrawn, Western Etching, 90s Heavy Metal Acid Wash, Collegiate Font Evolution, Vintage Folk Art Lino Cut).

Unified Negative Constraints: ${UNIVERSAL_NEGATIVE_PROMPT}

Available artistic style IDs: ${styleIdList()}

Artistic style details:
${styleSummaries()}

Respond with ONLY a JSON object, no markdown fences, no extra text:
{ "style_id": "<one of the listed ids>", "confidence": <0-1 number>, "reasoning": "<one short sentence>" }`;

function buildUserTurn({ prompt, imageBuffer, feature }) {
    const parts = [];
    if (feature) parts.push(`Feature: ${feature}`);
    if (prompt) parts.push(`Design idea / prompt: ${prompt}`);
    if (imageBuffer) {
        parts.push(
            "A reference image is attached. Judge its linework, shading, typography lockup and texture, then pick the closest style."
        );
    }
    if (!parts.length) parts.push("No description provided — pick the most versatile style.");
    parts.push(`Enforce negative constraints: ${UNIVERSAL_NEGATIVE_PROMPT}`);
    parts.push(SELECTION_INSTRUCTIONS);
    return parts.join("\n\n");
}

/** Extract the first JSON object from a model reply (handles fences/prose). */
function parseSelection(text) {
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
        const obj = JSON.parse(m[0]);
        if (obj && typeof obj.style_id === "string") return obj;
    } catch {
        /* fall through */
    }
    return null;
}

/**
 * Pick a style from the registry for the given prompt / reference image.
 * @param {object} opts
 * @param {string}  [opts.prompt]      - user description of the design
 * @param {Buffer}  [opts.imageBuffer] - optional reference image bytes
 * @param {string}  [opts.feature]     - originating feature name (e.g. "text-to-image")
 * @returns {Promise<{id,name,category,directive,confidence?,reasoning?}>}
 */
export async function pickMagicStyle({ prompt = "", imageBuffer = null, feature = "" } = {}) {
    // Acquire an authenticated slot from the pool — never create an ad-hoc
    // or unauthenticated browser instance for style analysis.
    const slot = await acquire();
    try {
        // The web pipeline consumes files from disk, so stage the optional image.
        let imagePath = null;
        if (Buffer.isBuffer(imageBuffer) && imageBuffer.length > 0) {
            imagePath = path.join(os.tmpdir(), `magic-style-${Date.now()}.png`);
            await fs.promises.writeFile(imagePath, imageBuffer);
        }

        try {
            let reply = null;
            try {
              reply = await withTimeout(web.generateText({
                  prompt: buildUserTurn({ prompt, imageBuffer, feature }),
                  imagePaths: imagePath ? [imagePath] : [],
                  page: slot.page,
              }), SELECTOR_TIMEOUT_MS);
            } catch {
              reply = null;
            }
            if (reply === null && slot?.page && !slot.page.isClosed?.()) {
              try { await slot.page.goto?.("about:blank"); } catch (_) {}
            }

            const parsed = parseSelection(reply);
            const style = getStyleOrDefault(parsed?.style_id || DEFAULT_STYLE_ID);
            return {
                id: style.id,
                name: style.name,
                category: style.category,
                directive: style.directive,
                confidence: typeof parsed?.confidence === "number" ? parsed.confidence : null,
                reasoning: typeof parsed?.reasoning === "string" ? parsed.reasoning : null,
            };
        } finally {
            if (imagePath) await fs.promises.unlink(imagePath).catch(() => { });
        }
    } finally {
        // Always release the slot back so the fleet's ready status stays accurate.
        await release(slot);
    }
}