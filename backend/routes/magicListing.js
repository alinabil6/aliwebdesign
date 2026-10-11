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
  claimNextReadyAccount,
  recordGeneration,
  setAccountStatus,
} from "../lib/db.js";
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

function preserveDescription(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
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
  let description = preserveDescription(obj.description || obj.desc || "");

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
    description: preserveDescription(description),
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
  let description = preserveDescription(obj.description || obj.desc || "");
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
    description: preserveDescription(description),
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
  let description = preserveDescription(obj.description || obj.desc || "");
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
    description: preserveDescription(description),
    trademark_safe: obj.trademark_safe === true || obj.trademark_safe === undefined,
  };
}

async function acquireListingAccount(timeoutMs = 60000, excludeIds = []) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const claimed = claimNextReadyAccount(excludeIds);
    if (claimed) {
      return withAbs(claimed);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("All Gemini accounts are busy — try again in a moment");
}

async function processListingOnAccount(account, design, referenceData, platform, signal = null) {
  const plat = String(platform || "amazon").toLowerCase();
  const isTeePublic = plat === "teepublic";
  const isEtsy = plat === "etsy";
  const { imageBase64 = "", fileName = "", designIndex = 0 } = design || {};

  console.log(`[magicListing] Leased account: ${account.id} (${account.email || "no-email"})`);
  console.log(`[magicListing] Processing design ${designIndex} (${fileName}) for platform: [${plat}]`);

  const base64Data = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");
  const imagePath = path.join(os.tmpdir(), `magic-listing-${uuidv4().slice(0, 8)}.png`);
  fs.writeFileSync(imagePath, Buffer.from(base64Data, "base64"));

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

      console.log(`[magicListing] [Mock/Fallback] Generated listing for [${plat}], releasing account.`);
      return {
        success: true,
        fileName: fileName || `Design #${designIndex}`,
        designIndex,
        platform: plat,
        listing: normalized,
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

    const TIMEOUT_MS = 75000;
    const reply = await Promise.race([
      web.generateText({
        prompt,
        imagePaths: [imagePath],
        page,
        signal,
        timeoutMs: 65000,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("MAGIC_LISTING_TIMEOUT")), TIMEOUT_MS)
      ),
    ]);

    console.log(`[magicListing] Received response from model (Length: ${reply?.length || 0})`);
    recordGeneration(account.id);

    const parsed = extractJSON(reply, isEtsy ? { title: "title", description: "description", category: "category" } : isTeePublic ? { mainTag: "main_tag", supportingTags: "supporting_tags" } : {});

    const normalizedListing = isEtsy
      ? normalizeEtsyListing(parsed || buildFallbackEtsyListing(fileName, referenceData))
      : isTeePublic
        ? normalizeTeePublicListing(parsed || buildFallbackTeePublicListing(fileName, referenceData))
        : normalizeListing(parsed || buildFallbackAmazonListing(fileName, referenceData));

    console.log(`[magicListing] Successfully parsed JSON for [${plat}], releasing account.`);
    return {
      success: true,
      fileName: fileName || `Design #${designIndex}`,
      designIndex,
      platform: plat,
      listing: normalizedListing,
    };
  } finally {
    setAccountStatus(account.id, "ready");
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
    account = await acquireListingAccount(45000);

    const result = await processListingOnAccount(
      account,
      { imageBase64, fileName, designIndex },
      sanitizeReference(referenceData),
      platform
    );
    res.json(result);
  } catch (err) {
    console.error("[MagicListing Error]:", err);
    if (err.message === "MAGIC_LISTING_TIMEOUT") {
      return res.status(504).json({ error: "Listing generation timed out. Browser released." });
    }
    res.status(500).json({ error: err.message || "Magic Listing backend processing failed" });
  } finally {
    if (account) {
      setAccountStatus(account.id, "ready");
    }
  }
});

// POST /api/magic-listing/batch
router.post("/batch", async (req, res) => {
  try {
    const { designs = [], referenceData = "", platform = "amazon" } = req.body || {};
    if (!Array.isArray(designs) || designs.length === 0) {
      return res.status(400).json({ error: "designs array is required" });
    }

    console.log(`[magicListing] Incoming batch request: Platform = [${platform}], Files = [${designs.length}]`);
    const sanitizedReference = sanitizeReference(referenceData);

    let nextIndex = 0;
    const results = [];
    const failed = [];
    const MAX_CONCURRENT = 4;
    const workerCount = Math.min(designs.length, MAX_CONCURRENT);

    async function worker() {
      while (nextIndex < designs.length) {
        const currentIndex = nextIndex++;
        const design = designs[currentIndex];
        let account = null;
        try {
          account = await acquireListingAccount(60000);
          const result = await processListingOnAccount(
            account,
            design,
            sanitizedReference,
            platform
          );
          results.push(result);
        } catch (err) {
          console.error(`[MagicListing] Failed for design ${currentIndex} (${design?.fileName}):`, err.message);
          failed.push({
            designIndex: design?.designIndex ?? currentIndex,
            fileName: design?.fileName || `Design #${currentIndex + 1}`,
            error: err.message === "MAGIC_LISTING_TIMEOUT"
              ? "Listing generation timed out. Browser released."
              : (err.message || "This design could not be processed."),
          });
        } finally {
          if (account) {
            setAccountStatus(account.id, "ready");
          }
        }
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    results.sort((a, b) => (a.designIndex ?? 0) - (b.designIndex ?? 0));
    res.json({ success: true, results, failed, total: designs.length });
  } catch (err) {
    console.error("[MagicListing Batch Error]:", err);
    res.status(500).json({ error: err.message || "Magic Listing batch processing failed" });
  }
});

export default router;
