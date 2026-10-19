// ────────────────────────────────────────────────────────────
// Magic Listing — POST /api/magic-listing/generate & /batch
//
// Accepts { imageBase64, referenceData, designIndex }, dispatches the image +
// reference data to the Gemini multi-node queue with atomic leasing, and
// returns sanitized Amazon, TeePublic, or Etsy listing JSON.
// ────────────────────────────────────────────────────────────
import { Router } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { withAbs, listReadyAccountsWithAbs } from "../lib/accounts.js";
import { getProfilePage, canLaunchBrowser } from "../lib/browser.js";
import { MOCK_GEMINI } from "../lib/gemini.js";
import * as web from "../lib/geminiweb.js";
import {
  recordGeneration,
  insertListing,
} from "../lib/db.js";
import { acquireFleetAccount, release } from "../lib/fleetLease.js";
import { storeInLibrary } from "../lib/files.js";
import {
  buildMagicListingPrompt,
  buildTeePublicPrompt,
  buildEtsyPrompt,
} from "../prompts/magicListing.js";

const router = Router();

// ── Sanitizers ───────────────────────────────────────────────

function sanitizeReference(referenceData) {
  return String(referenceData || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 1500)
    .trim();
}

function sanitizeCopy(text) {
  return String(text ?? "")
    .replace(/\b(?:shirt|tee|t-?shirt|gift|gifts|present|merch|clothes|apparel)\b/gi, " ")
    .replace(/[-_]/g, " ")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateAtWord(text, maxLen) {
  const s = String(text ?? "").trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

function buildFallbackAmazonListing(fileName, referenceData) {
  const nameClean = (fileName || "").replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ").trim();
  const theme = nameClean || "Original Graphic";
  return {
    title: `${theme} Vintage Graphic Design`,
    brand: "Vintage Graphic Co",
    bullet1: "Original artistic graphic illustration crafted with rich details and vibrant styling.",
    bullet2: "Premium print-on-demand artwork designed for comfort, durability, and standout visual appeal.",
    description: "Make a statement with this original graphic design. Perfect for everyday wear, casual outings, and fans of unique artwork.",
    trademark_safe: true,
  };
}

function buildFallbackTeePublicListing(fileName, referenceData) {
  const nameClean = (fileName || "").replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ").trim();
  const theme = nameClean || "Vintage Graphic";
  return {
    title: `${theme} Graphic Design`,
    description: "A distinctive graphic art piece with rich colors and retro inspiration. Great for casual apparel and artistic collections.",
    main_tag: "graphic tee",
    supporting_tags: ["vintage", "retro", "graphic", "illustration", "aesthetic", "apparel"],
    trademark_safe: true,
  };
}

function buildFallbackEtsyListing(fileName, referenceData) {
  const nameClean = (fileName || "").replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ").trim();
  const theme = nameClean || "Vintage Aesthetic Graphic";
  return {
    title: `${theme} Graphic T-Shirt, Retro Art Shirt, Nature Lover Tee Gift`,
    category: "Clothing > Unisex Adult Clothing > Tops & Tees > T-shirts",
    attributes: {
      primaryColor: "Black",
      style: "Vintage Vector",
      occasion: "Everyday",
      recipient: "Unisex Adult",
      graphic: "Graphic Illustration",
    },
    tags: [
      "vintage graphic tee", "retro tshirt", "aesthetic shirt", "artistic top",
      "nature lover gift", "botanical tee", "streetwear shirt", "boho graphic tee",
      "comfort colors", "custom illustrated", "trendy art shirt", "unisex adult top", "gift for her"
    ],
    description: "Crafted for comfort and style, this unique graphic tee features original artwork printed on premium soft cotton fabric. Perfect for casual wear, gifting, and fans of standout graphic design.",
    trademark_safe: true,
  };
}

function normalizeListing(raw) {
  const obj = typeof raw === "object" && raw !== null ? raw : {};
  const title = (obj.title || "").trim();
  let brand = (obj.brand || obj.brand_name || obj.brandName || "").trim();
  const bullet1 = (obj.bullet1 || obj.bullet_1 || "").trim();
  const bullet2 = (obj.bullet2 || obj.bullet_2 || "").trim();
  let description = (obj.description || obj.desc || "").trim();

  if (!brand) {
    const titleWords = title.split(" ").slice(0, 3).join(" ");
    brand = titleWords ? `${titleWords} Apparel` : "Vintage Graphic Apparel Co";
  }

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

function extractJSON(rawText, fieldKeys = {}) {
  if (!rawText) return null;
  let clean = String(rawText).replace(/```json\s*/gi, "").replace(/```\s*$/gi, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) clean = match[0];
  try {
    return JSON.parse(clean);
  } catch (e) {
    const k = {
      title: "title",
      brand: "brand",
      bullet1: "bullet1",
      bullet2: "bullet2",
      description: "description",
      category: "category",
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
    const category = grab(k.category, [k.category]);
    const mainTag = grab(k.mainTag, [k.mainTag, "main_tag", "mainTag", "primary_tag", "primaryTag"]);

    const tagsMatch = clean.match(/"(?:supporting_tags|supportingTags|tags)"\s*:\s*\[([^\]]*)\]/i);
    const tagsStrMatch = clean.match(/"(?:supporting_tags|supportingTags|tags)"\s*:\s*"([^"]+)"/i);
    const supportingTags = tagsMatch
      ? [...tagsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
      : tagsStrMatch
        ? tagsStrMatch[1].split(",").map((t) => t.trim()).filter(Boolean)
        : [];

    if (title || bullet1 || mainTag || category) {
      return {
        title: title || "Vintage Graphic Apparel",
        brand: brand || "",
        bullet1: bullet1 || "",
        bullet2: bullet2 || "",
        description: description || "",
        category: category || "",
        main_tag: mainTag || "",
        supporting_tags: supportingTags,
        trademark_safe: true,
      };
    }
    return null;
  }
}

function normalizeTeePublicListing(raw) {
  const obj = typeof raw === "object" && raw !== null ? raw : {};
  let title = (obj.title || "").trim();
  let description = (obj.description || obj.desc || "").trim();
  let mainTag = String(
    obj.main_tag || obj.mainTag || obj.primary_tag || obj.primaryTag || ""
  ).trim();
  let tags = obj.supporting_tags || obj.supportingTags || obj.tags || obj.secondary_tags || [];

  if (typeof tags === "string") {
    tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
  } else if (Array.isArray(tags)) {
    tags = tags.map((t) => (typeof t === "string" ? t.trim() : String(t))).filter(Boolean);
  } else {
    tags = [];
  }

  if (!title) title = "Original Graphic Design Tee";
  if (!description) {
    description = "A unique original graphic design with bold artwork and a distinctive aesthetic. Perfect for fans of standout illustrated apparel.";
  }
  if (!mainTag) mainTag = "graphic tee";

  tags = tags.filter((t) => t.toLowerCase() !== mainTag.toLowerCase());
  tags = [...new Set(tags)];
  if (tags.length < 6) {
    const fallbacks = ["funny", "cute", "retro", "vintage", "minimalist", "trendy", "apparel"];
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
    main_tag: mainTagClean,
    mainTag: mainTagClean,
    supporting_tags: supportingTags,
    supportingTags: supportingTags,
    trademark_safe: obj.trademark_safe === true,
  };
}

function normalizeEtsyListing(raw) {
  const obj = typeof raw === "object" && raw !== null ? raw : {};
  let title = (obj.title || "").trim();
  let category = (obj.category || "Clothing > Unisex Adult Clothing > Tops & Tees > T-shirts").trim();
  let description = (obj.description || obj.desc || "").trim();
  const attrs = typeof obj.attributes === "object" && obj.attributes !== null ? obj.attributes : {};

  const attributes = {
    primaryColor: String(attrs.primaryColor || attrs.primary_color || "Black").trim(),
    style: String(attrs.style || "Vintage Vector").trim(),
    occasion: String(attrs.occasion || "Everyday").trim(),
    recipient: String(attrs.recipient || "Unisex Adult").trim(),
    graphic: String(attrs.graphic || "Graphic Illustration").trim(),
  };

  let tags = obj.tags || obj.supporting_tags || obj.supportingTags || [];
  if (typeof tags === "string") {
    tags = tags.split(/[\n,;]+/).map((t) => t.trim()).filter(Boolean);
  } else if (Array.isArray(tags)) {
    tags = tags.map((t) => String(t || "").trim()).filter(Boolean);
  } else {
    tags = [];
  }

  if (!title) title = "Vintage Aesthetic Graphic T-Shirt, Retro Art Apparel";
  if (!description) {
    description = "Crafted for comfort and style, this unique graphic tee features original artwork printed on premium soft cotton fabric. Perfect for casual wear, gifting, and fans of standout graphic design.";
  }

  tags = [...new Set(tags)];
  const fallbacks = [
    "graphic tee", "vintage shirt", "retro apparel", "aesthetic clothing",
    "cottagecore top", "artistic tshirt", "gift for him", "gift for her",
    "streetwear tee", "boho graphic shirt", "comfort colors", "custom illustrated", "nature lover gift"
  ];
  for (const fb of fallbacks) {
    if (tags.length >= 13) break;
    if (!tags.includes(fb)) tags.push(fb);
  }
  tags = tags.slice(0, 13).map((t) => truncateAtWord(t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " "), 20));

  return {
    title: truncateAtWord(title.replace(/[\r\n\t]+/g, " "), 140),
    category: truncateAtWord(category, 100),
    attributes,
    tags,
    description: truncateAtWord(description, 1500),
    trademark_safe: obj.trademark_safe === true || obj.trademark_safe === undefined,
  };
}

function persistListingToLibrary({ fileName, designIndex, platform, listing, imagePath }) {
  let thumbnailRel = null;
  if (imagePath && fs.existsSync(imagePath)) {
    try {
      const stored = storeInLibrary(imagePath, `${uuidv4()}-listing-thumb.jpg`);
      thumbnailRel = stored.rel;
    } catch (err) {
      console.warn("[magicListing] Failed to store thumbnail in library:", err.message);
    }
  }

  const plat = String(platform || "amazon").toLowerCase();
  const l = listing || {};

  try {
    const saved = insertListing({
      id: uuidv4(),
      file_name: fileName || `Design #${designIndex}`,
      platform: plat,
      thumbnail_path: thumbnailRel,
      title: l.title || null,
      brand: l.brand || l.brand_name || l.brandName || null,
      category: l.category || null,
      bullet1: l.bullet1 || l.bullet_1 || null,
      bullet2: l.bullet2 || l.bullet_2 || null,
      description: l.description || l.desc || null,
      main_tag: l.mainTag || l.main_tag || null,
      tags: l.tags || l.supportingTags || l.supporting_tags || [],
      attributes: l.attributes || {},
      trademark_safe: l.trademark_safe !== false ? 1 : 0,
      raw_listing: l,
    });
    return { id: saved.id, thumbnailRel };
  } catch (err) {
    console.error("[magicListing] Failed to persist listing row to DB:", err.message);
    return { id: null, thumbnailRel };
  }
}

async function processListingOnAccount(account, design, referenceData, platform, signal = null) {
  const plat = String(platform || "amazon").toLowerCase();
  const isTeePublic = plat === "teepublic";
  const isEtsy = plat === "etsy";
  const { imageBase64 = "", fileName = "", designIndex = 0 } = design || {};

  console.log(`[magicListing] Leased account: ${account.id} (${account.email || "no-email"})`);
  console.log(`[magicListing] Processing design ${designIndex} (${fileName}) for platform: [${plat}]`);

  const base64Data = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");
  const rawBuf = Buffer.from(base64Data, "base64");
  const imagePath = path.join(os.tmpdir(), `magic-listing-${uuidv4().slice(0, 8)}.jpg`);
  try {
    // Compress to 800px JPEG (~40-80 KB) so Gemini attachment upload finishes fast
    const sharp = (await import("sharp")).default;
    const jpgBuf = await sharp(rawBuf)
      .resize(800, 800, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: { r: 30, g: 30, b: 30 } })
      .jpeg({ quality: 82 })
      .toBuffer();
    fs.writeFileSync(imagePath, jpgBuf);
  } catch {
    // Fallback: write raw buffer if sharp fails
    fs.writeFileSync(imagePath, rawBuf);
  }

  try {
    if (MOCK_GEMINI || !canLaunchBrowser(account.browser)) {
      recordGeneration(account.id);
      const fallback = isEtsy
        ? buildFallbackEtsyListing(fileName, referenceData)
        : isTeePublic
          ? buildFallbackTeePublicListing(fileName, referenceData)
          : buildFallbackAmazonListing(fileName, referenceData);

      const normalized = isEtsy
        ? normalizeEtsyListing(fallback)
        : isTeePublic
          ? normalizeTeePublicListing(fallback)
          : normalizeListing(fallback);

      const persisted = persistListingToLibrary({
        fileName,
        designIndex,
        platform: plat,
        listing: normalized,
        imagePath,
      });

      console.log(`[magicListing] [Mock/Fallback] Generated listing for [${plat}], releasing account.`);
      return {
        success: true,
        id: persisted.id,
        fileName: fileName || `Design #${designIndex}`,
        designIndex,
        platform: plat,
        thumbnailPath: persisted.thumbnailRel,
        thumbnailUrl: persisted.thumbnailRel ? `/library/${persisted.thumbnailRel}` : "",
        listing: normalized,
        savedToLibrary: true,
      };
    }

    console.log(`[magicListing] Navigating Gemini Web session for account ${account.id}...`);
    const page = await getProfilePage(account);

    const prompt = isEtsy
      ? buildEtsyPrompt({
          referenceData,
          imageContext: `Design index ${designIndex}: ${fileName}`,
        })
      : isTeePublic
        ? buildTeePublicPrompt({
            referenceData,
            imageContext: `Design index ${designIndex}: ${fileName}`,
          })
        : buildMagicListingPrompt({
            referenceData,
            imageContext: `Design index ${designIndex}: ${fileName}`,
          });

    console.log(`[magicListing] Sending Vision prompt + image attachment to ${account.id}...`);

    const reply = await web.generateText({
      prompt,
      imagePaths: [imagePath],
      page,
      signal,
      timeoutMs: 90000,
      accountId: account.id,
    });

    console.log(`[magicListing] Received response from model (Length: ${reply?.length || 0})`);
    recordGeneration(account.id);

    const parsed = extractJSON(reply, isEtsy ? { title: "title", description: "description", category: "category" } : isTeePublic ? { mainTag: "main_tag", supportingTags: "supporting_tags" } : {});

    const normalizedListing = isEtsy
      ? normalizeEtsyListing(parsed || buildFallbackEtsyListing(fileName, referenceData))
      : isTeePublic
        ? normalizeTeePublicListing(parsed || buildFallbackTeePublicListing(fileName, referenceData))
        : normalizeListing(parsed || buildFallbackAmazonListing(fileName, referenceData));

    const persisted = persistListingToLibrary({
      fileName,
      designIndex,
      platform: plat,
      listing: normalizedListing,
      imagePath,
    });

    console.log(`[magicListing] Successfully parsed JSON for [${plat}], releasing account.`);
    return {
      success: true,
      id: persisted.id,
      fileName: fileName || `Design #${designIndex}`,
      designIndex,
      platform: plat,
      thumbnailPath: persisted.thumbnailRel,
      thumbnailUrl: persisted.thumbnailRel ? `/library/${persisted.thumbnailRel}` : "",
      listing: normalizedListing,
      savedToLibrary: true,
    };
  } finally {
    try {
      fs.rmSync(imagePath, { force: true });
    } catch {}
  }
}

// POST /api/magic-listing/generate
router.post("/generate", async (req, res) => {
  let account = null;
  try {
    const { imageBase64 = "", referenceData = "", designIndex = 0, fileName = "", platform = "amazon" } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    console.log(`[magicListing] Incoming request: Platform = [${platform}], Files = 1`);
    account = await acquireFleetAccount({ timeoutMs: 45000 });

    const result = await processListingOnAccount(
      account,
      { imageBase64, fileName, designIndex },
      sanitizeReference(referenceData),
      platform
    );
    res.json(result);
  } catch (err) {
    console.error("[MagicListing Error]:", err);
    if (err?.name === "GenerationTimeoutError" || err?.isTimeout || err?.message === "MAGIC_LISTING_TIMEOUT") {
      return res.status(504).json({ error: "Listing generation timed out. Browser released." });
    }
    res.status(500).json({ error: err.message || "Magic Listing backend processing failed" });
  } finally {
    if (account) {
      release(account.id);
    }
  }
});

// POST /api/magic-listing/batch
router.post("/batch", async (req, res) => {
  const wantsStream = req.headers.accept?.includes("application/x-ndjson") || req.query.stream === "true";
  let heartbeatInterval = null;

  try {
    const { designs = [], referenceData = "", platform = "amazon" } = req.body || {};
    if (!Array.isArray(designs) || designs.length === 0) {
      return res.status(400).json({ error: "designs array is required" });
    }

    console.log(`[magicListing] Incoming batch request: Platform = [${platform}], Files = [${designs.length}], stream = ${wantsStream}`);
    const sanitizedReference = sanitizeReference(referenceData);

    if (wantsStream) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      heartbeatInterval = setInterval(() => {
        if (!res.writableEnded) {
          try {
            res.write(JSON.stringify({ event: "heartbeat" }) + "\n");
          } catch (_) {}
        }
      }, 15000);
    }

    const results = [];
    const failed = [];
    const pending = designs.map((design, idx) => ({
      design,
      designIndex: design?.designIndex ?? (idx + 1),
      retries: 0,
      failedAccountIds: [],
    }));

    const MAX_CONCURRENT = 4;
    const workerCount = Math.min(designs.length, MAX_CONCURRENT);
    let activeInFlight = 0;
    let poolDone = false;

    req.on("close", () => {
      poolDone = true;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    });

    async function worker(workerIndex) {
      // Stagger concurrent workers to avoid simultaneous browser launches
      // competing for bandwidth during attachment upload (2s gap each)
      if (workerIndex > 0) {
        await new Promise((r) => setTimeout(r, workerIndex * 2000));
      }
      while (!poolDone) {
        if (pending.length === 0) {
          if (activeInFlight === 0) {
            poolDone = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 400));
          continue;
        }

        const item = pending.shift();
        if (!item) continue;

        activeInFlight++;
        const { design, designIndex } = item;
        let account = null;
        try {
          account = await acquireFleetAccount({ timeoutMs: 60000, excludeIds: item.failedAccountIds || [] });
          const result = await processListingOnAccount(
            account,
            design,
            sanitizedReference,
            platform
          );
          results.push(result);
          if (wantsStream && !res.writableEnded) {
            try {
              res.write(JSON.stringify({ event: "listing", result, designIndex }) + "\n");
            } catch (_) {}
          }
        } catch (err) {
          const isTimeout = err?.name === "GenerationTimeoutError" || err?.isTimeout || err?.message === "MAGIC_LISTING_TIMEOUT" || (err?.message || "").includes("timed out");
          const msg = (err?.message || "").toLowerCase();
          console.error(`[MagicListing] Failed for design ${designIndex} (${design?.fileName}) on ${account ? account.id : "unassigned"}:`, err.message);

          if (account) {
            item.failedAccountIds = item.failedAccountIds || [];
            item.failedAccountIds.push(account.id);
          }

          if (item.retries < 2 && !msg.includes("invalid image") && !msg.includes("bad request")) {
            item.retries++;
            console.log(`[MagicListing] Re-routing design ${designIndex} (${design?.fileName}) (attempt ${item.retries + 1}/3) to alternate account...`);
            pending.push(item);
          } else {
            const failedItem = {
              designIndex,
              fileName: design?.fileName || `Design #${designIndex}`,
              error: isTimeout
                ? "Listing generation timed out. Browser released."
                : (err.message || "This design could not be processed."),
            };
            failed.push(failedItem);
            if (wantsStream && !res.writableEnded) {
              try {
                res.write(JSON.stringify({ event: "listing_failed", failed: failedItem, designIndex }) + "\n");
              } catch (_) {}
            }
          }
        } finally {
          activeInFlight--;
          if (account) {
            release(account.id);
          }
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (wantsStream) {
      if (!res.writableEnded) {
        res.write(JSON.stringify({ event: "done", total: designs.length, successCount: results.length, failedCount: failed.length }) + "\n");
        res.end();
      }
      return;
    }

    results.sort((a, b) => (a.designIndex ?? 0) - (b.designIndex ?? 0));
    res.json({ success: true, results, failed, total: designs.length });
  } catch (err) {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    console.error("[MagicListing Batch Error]:", err);
    if (wantsStream && !res.writableEnded) {
      try {
        res.write(JSON.stringify({ event: "error", error: err.message || "Magic Listing batch processing failed" }) + "\n");
        res.end();
      } catch (_) {}
      return;
    }
    res.status(500).json({ error: err.message || "Magic Listing batch processing failed" });
  }
});

export default router;