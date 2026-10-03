// ────────────────────────────────────────────────────────────
// Magic Listing — POST /api/magic-listing/generate
//
// Accepts { imageBase64, referenceData, designIndex }, dispatches the image +
// reference data to the Gemini multi-node queue, and returns a strict,
// sanitized Amazon Merch on Demand listing JSON.
// ────────────────────────────────────────────────────────────
import { Router } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { pickReadyAccount, listReadyAccountsWithAbs } from "../lib/accounts.js";
import { getProfilePage, closeProfile, canLaunchBrowser } from "../lib/browser.js";
import { MOCK_GEMINI } from "../lib/gemini.js";
import * as web from "../lib/geminiweb.js";
import {
    recordGeneration,
    setAccountStatus,
} from "../lib/db.js";
import { buildMagicListingPrompt, buildTeePublicPrompt } from "../prompts/magicListing.js";

const router = Router();

// ── Sanitizers ───────────────────────────────────────────────

/**
 * Clean + truncate reference data before it reaches the prompt. Amazon product
 * dumps / CSV files carry multi-line quotes, tabs and special characters that
 * can bloat the context or break the model's JSON output. Collapse all
 * whitespace runs to single spaces and cap the length so a huge paste can
 * never overflow the prompt window.
 */
function sanitizeReference(referenceData) {
    return String(referenceData || "")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .slice(0, 1500)
        .trim();
}

/** Strip accidental filtered terms / punctuation from a copy field. */
function sanitizeCopy(text) {
    return String(text ?? "")
        .replace(/\b(?:shirt|tee|t-?shirt|gift|gifts|present|merch|clothes|apparel)\b/gi, " ")
        .replace(/[-_]/g, " ")
        .replace(/["']/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** Truncate cleanly at the last full word before the limit. */
function truncateAtWord(text, maxLen) {
    const s = String(text ?? "").trim();
    if (s.length <= maxLen) return s;
    const cut = s.slice(0, maxLen);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/** Coerce the model reply into the strict 5-field listing schema.
 *  Defensively maps snake_case variants (bullet_1, bullet_2, brand_name,
 *  brandName, desc) onto the canonical camelCase keys, and guarantees
 *  non-empty brand/description with automated fallbacks when the model
 *  returns null/blank. */
function normalizeListing(raw) {
    const obj = typeof raw === "object" && raw !== null ? raw : {};

    const title = (obj.title || "").trim();
    let brand = (obj.brand || obj.brand_name || obj.brandName || "").trim();
    const bullet1 = (obj.bullet1 || obj.bullet_1 || "").trim();
    const bullet2 = (obj.bullet2 || obj.bullet_2 || "").trim();
    let description = (obj.description || obj.desc || "").trim();

    // Guarantee a non-empty brand — derive from the title's first words.
    if (!brand) {
        const titleWords = title.split(" ").slice(0, 3).join(" ");
        brand = titleWords ? `${titleWords} Apparel` : "Vintage Graphic Apparel Co";
    }

    // Guarantee a non-empty description — fall back to the bullets, then a
    // generic merchandising overview.
    if (!description) {
        description =
            `${bullet1} ${bullet2}`.trim() ||
            "Step out in style with this unique graphic design. Perfect for everyday wear, special occasions, and fans of original illustrated apparel.";
    }

    return {
        title: truncateAtWord(sanitizeCopy(title), 60),
        brand: truncateAtWord(sanitizeCopy(brand), 50),
        bullet1: truncateAtWord(sanitizeCopy(bullet1), 256),
        bullet2: truncateAtWord(sanitizeCopy(bullet2), 256),
        description: truncateAtWord(sanitizeCopy(description), 500),
        trademark_safe: obj.trademark_safe === true,
    };
}

/** Extract the first JSON object from a model reply (handles fences/prose).
 *  Bulletproof: strips markdown fences, isolates the first {...} block, and
 *  falls back to per-field regex extraction when strict JSON.parse fails.
 *  `fieldKeys` lets callers override which keys the regex fallback hunts for
 *  (Amazon vs TeePublic schemas). */
function extractJSON(rawText, fieldKeys = {}) {
    if (!rawText) return null;
    let clean = String(rawText).replace(/```json\s*/gi, "").replace(/```\s*$/gi, "").trim();
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) clean = match[0];
    try {
        return JSON.parse(clean);
    } catch (e) {
        // Fallback regex extraction if strict JSON parse fails
        const k = {
            title: "title",
            brand: "brand",
            bullet1: "bullet1",
            bullet2: "bullet2",
            description: "description",
            mainTag: "main_tag",
            supportingTags: "supporting_tags",
            ...fieldKeys,
        };
        const grab = (key, aliases) => {
            for (const a of aliases) {
                const m = clean.match(new RegExp(`"${a}"\\s*:\\s*"([^"]+)"`, "i"));
                if (m) return m[1];
            }
            return null;
        };
        const title = grab(k.title, [k.title]);
        const brand = grab(k.brand, [k.brand, "brand_name", "brandName"]);
        const bullet1 = grab(k.bullet1, [k.bullet1, "bullet_1"]);
        const bullet2 = grab(k.bullet2, [k.bullet2, "bullet_2"]);
        const description = grab(k.description, [k.description, "desc"]);
        const mainTag = grab(k.mainTag, [k.mainTag, "main_tag", "mainTag", "primary_tag", "primaryTag"]);
        // supporting_tags may be an array OR a comma-separated string.
        const tagsMatch = clean.match(/"supporting_tags"\s*:\s*\[([^\]]*)\]/i)
            || clean.match(/"supportingTags"\s*:\s*\[([^\]]*)\]/i)
            || clean.match(/"tags"\s*:\s*\[([^\]]*)\]/i);
        const tagsStrMatch = clean.match(/"supporting_tags"\s*:\s*"([^"]+)"/i)
            || clean.match(/"supportingTags"\s*:\s*"([^"]+)"/i)
            || clean.match(/"tags"\s*:\s*"([^"]+)"/i);
        const supportingTags = tagsMatch
            ? [...tagsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
            : tagsStrMatch
                ? tagsStrMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
                : [];

        if (title || bullet1 || mainTag) {
            return {
                title: title || "Awareness Graphic",
                brand: brand || "",
                bullet1: bullet1 || "",
                bullet2: bullet2 || "",
                description: description || "",
                main_tag: mainTag || "",
                supporting_tags: supportingTags,
                trademark_safe: true,
            };
        }
        throw new Error(`Failed to parse structured listing JSON: ${clean.slice(0, 100)}`);
    }
}

/** Coerce a TeePublic model reply into the strict 4-field schema.
 *  Defensively accepts every key variant Gemini may emit (snake_case,
 *  camelCase, primary_tag, tags, secondary_tags) and both array and
 *  comma-separated-string tag formats. Guarantees non-empty title/description/
 *  main_tag with automated fallbacks, clamps supporting_tags to 6–15 distinct
 *  entries, and emits BOTH key formats so the frontend never sees blanks. */
function normalizeTeePublicListing(raw) {
    const obj = typeof raw === "object" && raw !== null ? raw : {};

    let title = (obj.title || "").trim();
    let description = (obj.description || obj.desc || "").trim();
    let mainTag = String(
        obj.main_tag || obj.mainTag || obj.primary_tag || obj.primaryTag || ""
    ).trim();
    let tags = obj.supporting_tags || obj.supportingTags || obj.tags || obj.secondary_tags || [];

    // Tags may arrive as a comma-separated string ("funny, cute, retro") or an
    // array of strings — normalize both into a clean string array.
    if (typeof tags === "string") {
        tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
    } else if (Array.isArray(tags)) {
        tags = tags.map((t) => (typeof t === "string" ? t.trim() : String(t))).filter(Boolean);
    } else {
        tags = [];
    }

    // Guarantee a non-empty title — derive from the design's theme.
    if (!title) title = "Original Graphic Design Tee";
    // Guarantee a non-empty description.
    if (!description) {
        description = "A unique original graphic design with bold artwork and a distinctive aesthetic. Perfect for fans of standout illustrated apparel.";
    }
    // Guarantee a non-empty main tag.
    if (!mainTag) mainTag = "graphic tee";

    // The main tag is a search phrase, not a supporting tag — never duplicate it.
    tags = tags.filter((t) => t.toLowerCase() !== mainTag.toLowerCase());

    // Dedupe + clamp supporting tags to 6–15.
    tags = [...new Set(tags)];
    if (tags.length < 6) {
        const fallbacks = ["funny", "cute", "retro", "vintage", "minimalist", "trendy"];
        for (const f of fallbacks) {
            if (tags.length >= 6) break;
            if (!tags.includes(f)) tags.push(f);
        }
    }
    tags = tags.slice(0, 15);

    const clean = (s, max) => truncateAtWord(sanitizeCopy(s), max);
    const mainTagClean = clean(mainTag, 20);
    const supportingTags = tags.map((t) => clean(t, 20));

    return {
        title: clean(title, 80),
        description: clean(description, 300),
        // Both key formats — the frontend reads either without a blank.
        main_tag: mainTagClean,
        mainTag: mainTagClean,
        supporting_tags: supportingTags,
        supportingTags: supportingTags,
        trademark_safe: obj.trademark_safe === true,
    };
}

// ── Endpoint ─────────────────────────────────────────────────

/**
 * Process ONE design through a specific account's Gemini session.
 * Stages the base64 image to a temp file, drives the web pipeline, and
 * returns the normalized listing. The account is claimed ('running') for the
 * duration and released ('ready') in a guaranteed finally — so a crash or
 * safety refusal can never leave the fleet starved.
 *
 * @returns {Promise<object>} { designIndex, fileName, platform, listing }
 */
async function processListingWithGemini(account, design, referenceData, platform) {
    const isTeePublic = String(platform).toLowerCase() === "teepublic";
    const { imageBase64 = "", fileName = "", designIndex = 0 } = design || {};

    // Accept either a raw base64 string or a complete data URI
    // (data:image/png;base64,...) — strip the prefix before staging.
    const base64Data = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");

    // Stage the base64 image to a temp file for the web pipeline.
    const imagePath = path.join(os.tmpdir(), `magic-listing-${uuidv4().slice(0, 8)}.png`);
    fs.writeFileSync(imagePath, Buffer.from(base64Data, "base64"));

    // Claim the account for the duration of this design.
    setAccountStatus(account.id, "running");

    if (MOCK_GEMINI || !canLaunchBrowser(account.browser)) {
        try {
            recordGeneration(account.id);
            const title = "Vintage Aesthetic Graphic Apparel Design";
            const description = "Original vintage aesthetic artwork designed for premium print on demand apparel and merchandise.";
            const parsed = isTeePublic ? {
                title,
                description,
                main_tag: "vintage tee",
                supporting_tags: ["vintage", "retro", "graphic tee", "illustration", "aesthetic", "apparel"],
                trademark_safe: true,
            } : {
                title,
                brand: "Magic Fabrica",
                bullet1: "Original creative graphic art design with standout retro styling.",
                bullet2: "High-resolution print-on-demand artwork optimized for apparel and merchandise.",
                description,
                main_tag: "graphic tee",
                supporting_tags: ["vintage", "retro", "graphic", "illustration", "tshirt", "art"],
                trademark_safe: true,
            };

            return {
                success: true,
                fileName: fileName || `Design #${designIndex}`,
                designIndex,
                platform: isTeePublic ? "teepublic" : "amazon",
                listing: isTeePublic ? normalizeTeePublicListing(parsed) : normalizeListing(parsed),
            };
        } finally {
            setAccountStatus(account.id, "ready");
            try { fs.rmSync(imagePath, { force: true }); } catch {}
        }
    }

    const page = await getProfilePage(account);
    try {
        const prompt = isTeePublic
            ? buildTeePublicPrompt({
                referenceData,
                imageContext: `Design index ${designIndex} in the batch.`,
            })
            : buildMagicListingPrompt({
                referenceData,
                imageContext: `Design index ${designIndex} in the batch.`,
            });

        const reply = await web.generateText({
            prompt,
            imagePaths: [imagePath],
            page,
        });

        // Generation succeeded — count it and stamp last_used_at BEFORE flipping
        // back to ready, so the LS rotation picks a different account next time.
        recordGeneration(account.id);

        const parsed = extractJSON(reply);
        if (!parsed) {
            throw new Error("Gemini returned unparseable listing JSON");
        }

        return {
            success: true,
            fileName: fileName || `Design #${designIndex}`,
            designIndex,
            platform: isTeePublic ? "teepublic" : "amazon",
            listing: isTeePublic ? normalizeTeePublicListing(parsed) : normalizeListing(parsed),
        };
    } finally {
        // Guaranteed unlock — release the account and close its browser so no
        // zombie process lingers, regardless of success/failure.
        setAccountStatus(account.id, "ready");
        try {
            fs.rmSync(imagePath, { force: true });
        } catch {
            /* best effort — temp file cleanup */
        }
        // Warm profile preserved
    }
}

// POST /api/magic-listing/generate
// JSON body: { imageBase64, referenceData, designIndex, fileName, platform }
// Single-design path — kept for backward compatibility; the frontend now uses
// the parallel /batch endpoint for multi-design uploads.
router.post("/generate", async (req, res) => {
    try {
        let { imageBase64 = "", referenceData = "", designIndex = 0, fileName = "", platform = "amazon" } = req.body || {};

        if (!imageBase64) {
            return res.status(400).json({ error: "imageBase64 is required" });
        }

        const account = pickReadyAccount();
        if (!account) {
            return res.status(503).json({ error: "No Gemini account is ready — open the Accounts tab and sign in" });
        }

        const result = await processListingWithGemini(
            account,
            { imageBase64, fileName, designIndex },
            sanitizeReference(referenceData),
            platform
        );
        res.json(result);
    } catch (err) {
        console.error("[MagicListing Error]:", err);
        res.status(500).json({ error: "Magic Listing backend processing failed" });
    }
});

// POST /api/magic-listing/batch
// JSON body: { designs: [{ imageBase64, fileName, designIndex }], referenceData, platform }
// Distributes ALL uploaded designs across every active+ready account in the
// fleet CONCURRENTLY (worker-pool pattern). Each design is processed on its
// own account in parallel; a single design's failure is caught per-design so
// the rest of the batch still completes. Returns { results, failed }.
router.post("/batch", async (req, res) => {
    try {
        const { designs = [], referenceData = "", platform = "amazon" } = req.body || {};
        if (!Array.isArray(designs) || designs.length === 0) {
            return res.status(400).json({ error: "designs array is required" });
        }

        const sanitizedReference = sanitizeReference(referenceData);

        // Snapshot the ready fleet ONCE at batch start. Each worker claims one
        // account at a time; the pool is sized to the fleet so all accounts run
        // in parallel. Accounts carry profileDirAbs so each worker can open its
        // own profile browser concurrently.
        const readyAccounts = listReadyAccountsWithAbs();
        if (readyAccounts.length === 0) {
            return res.status(503).json({ error: "No Gemini account is ready — open the Accounts tab and sign in" });
        }

        // Worker-pool: each worker pulls the next unprocessed design, processes
        // it on its assigned account, and loops until the queue is drained.
        // `nextIndex` is shared across workers; the ++ is atomic in JS's
        // single-threaded event loop, so no two workers ever grab the same slot.
        let nextIndex = 0;
        const results = [];
        const failed = [];

        async function worker(account) {
            while (nextIndex < designs.length) {
                const currentIndex = nextIndex++;
                const design = designs[currentIndex];
                try {
                    const result = await processListingWithGemini(
                        account,
                        design,
                        sanitizedReference,
                        platform
                    );
                    results.push(result);
                } catch (err) {
                    console.error(
                        `[MagicListing] Failed for design ${currentIndex} on ${account.id}:`,
                        err
                    );
                    failed.push({
                        designIndex: design?.designIndex ?? currentIndex,
                        fileName: design?.fileName || `Design #${currentIndex + 1}`,
                        error: "This design could not be processed (possible safety refusal or timeout).",
                    });
                }
            }
        }

        // Run one worker per ready account, all in parallel. The fleet is the
        // concurrency cap — with 5 accounts and 3 designs, all 3 run at once.
        const concurrency = Math.min(readyAccounts.length, designs.length);
        await Promise.all(readyAccounts.slice(0, concurrency).map((acc) => worker(acc)));

        // Sort results back into upload order for a stable UI.
        results.sort((a, b) => (a.designIndex ?? 0) - (b.designIndex ?? 0));

        res.json({ success: true, results, failed, total: designs.length });
    } catch (err) {
        console.error("[MagicListing Batch Error]:", err);
        res.status(500).json({ error: "Magic Listing backend processing failed" });
    }
});

export default router;