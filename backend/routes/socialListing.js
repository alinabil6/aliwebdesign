// ────────────────────────────────────────────────────────────
// Social Listing — POST /api/social-listing/generate, /batch, /export-social
//
// Isolated Social Media listing pipeline powered by the proven v1.0.26
// geminiweb.js Vision engine. Kept completely separate from magicListing.js
// so Amazon Merch, TeePublic, and Etsy cannot be affected.
// ────────────────────────────────────────────────────────────
import { Router } from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import * as XLSX from "xlsx";
import { listAccountsWithAbs } from "../lib/accounts.js";
import {
  getProfilePage,
  closeProfile,
  canLaunchBrowser,
  touchAccountSession,
  parkAccountPageWhileLeased,
  scheduleIdleClose,
  incrementActiveBatches,
  decrementActiveBatches,
} from "../lib/browser.js";
import { MOCK_GEMINI } from "../lib/gemini.js";
import * as web from "../lib/geminiweb.js";
import { recordGeneration, insertListing } from "../lib/db.js";
import { acquireFleetAccount, release, quarantine } from "../lib/fleetLease.js";
import { storeInLibrary } from "../lib/files.js";
import { buildSocialListingPrompt } from "../prompts/listingSocial.js";

const router = Router();

function formatDuration(ms) {
  const totalSec = Math.max(1, Math.round((ms || 0) / 1000));
  const mins = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const secs = String(totalSec % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function truncateAtWord(text, maxLen) {
  const s = String(text ?? "").trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

function cleanText(val) {
  return String(val ?? "")
    .replace(/```(?:json)?/gi, "")
    .replace(/\r\n/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toSnakeCaseMp4(str) {
  const clean = String(str || "")
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  return `${clean || "graphic_tee"}.mp4`;
}

function isNonDescriptiveFilename(str) {
  if (!str) return true;
  const s = String(str).toLowerCase().trim();
  if (s.length < 3) return true;
  if (/^library-[a-f0-9-]+/i.test(s)) return true;
  if (/^[a-f0-9]{8,}$/i.test(s.replace(/[-_]/g, ""))) return true;
  if (/\.(png|jpg|jpeg|webp|gif|mp4|svg)$/i.test(s)) return true;
  if (/^(?:img|dsc|pxl|photo|image|mockup|screenshot|unisex[-_ ]t[-_ ]shirt)[\s_-]*\d*/i.test(s)) {
    return true;
  }
  return false;
}

function splitDelimitedRow(line, delimiter = ",") {
  const cols = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      cols.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

/**
 * Parse uploaded reference notes / CSV into either:
 * - exactMatch: when the image filename / ID matches a row in the CSV
 * - catalogText: compact list of CSV titles & tags so Vision pairs the right row to each mockup
 * - rawNotes: free-form keywords / notes when input is not a CSV table
 */
function parseSocialReference(referenceData, fileName = "") {
  const raw = String(referenceData || "").trim();
  if (!raw) return { matchedRef: null, catalogText: "", rawNotes: "" };

  // Strip UI banner comments while keeping multi-line structure intact
  const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const lines = cleaned.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (lines.length >= 2) {
    const delimiter = lines[0].includes("\t") && !lines[0].includes(",") ? "\t" : ",";
    const firstCols = splitDelimitedRow(lines[0], delimiter);
    const normHeaders = firstCols.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const hasCsvHeaders =
      firstCols.length >= 2 &&
      normHeaders.some((h) => h.includes("title") || h.includes("designid") || h.includes("filename") || h.includes("tag"));

    if (hasCsvHeaders) {
      const idxId = normHeaders.findIndex((h) => h === "designid" || h === "id");
      const idxFile = normHeaders.findIndex((h) => h.includes("filename") || h === "file");
      const idxTitle = normHeaders.findIndex((h) => h === "title" || h === "podtitle" || h.includes("title"));
      const idxTags = normHeaders.findIndex((h) => h.includes("tag") || h.includes("keyword"));
      const idxDesc = normHeaders.findIndex((h) => h.includes("desc"));

      const parsedRows = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = splitDelimitedRow(lines[i], delimiter);
        if (cols.length < 2) continue;
        const rowTitle = (idxTitle >= 0 ? cols[idxTitle] : "") || "";
        const rowFile = (idxFile >= 0 ? cols[idxFile] : "") || "";
        const rowId = (idxId >= 0 ? cols[idxId] : "") || "";
        const rowTags = (idxTags >= 0 ? cols[idxTags] : "") || "";
        const rowDesc = (idxDesc >= 0 ? cols[idxDesc] : "") || "";
        if (!rowTitle && !rowTags && !rowDesc) continue;
        parsedRows.push({
          id: rowId.toLowerCase(),
          file: rowFile.toLowerCase(),
          stem: rowFile.replace(/\.[^/.]+$/, "").toLowerCase(),
          title: cleanText(rowTitle),
          tags: cleanText(rowTags),
          description: cleanText(rowDesc).slice(0, 220),
        });
      }

      if (parsedRows.length > 0) {
        const cleanUploaded = String(fileName || "").toLowerCase().trim();
        const uploadedStem = cleanUploaded.replace(/\.[^/.]+$/, "");
        const shortIdCandidate = uploadedStem.replace(/^library-/, "").slice(0, 8);

        const exactMatch = parsedRows.find((r) => {
          if (!uploadedStem) return false;
          if (r.file && (r.file === cleanUploaded || r.stem === uploadedStem)) return true;
          if (r.stem && uploadedStem.includes(r.stem) && r.stem.length >= 6) return true;
          if (r.id && r.id.length >= 6 && (uploadedStem.includes(r.id) || (shortIdCandidate && r.id === shortIdCandidate))) {
            return true;
          }
          return false;
        });

        if (exactMatch) {
          return { matchedRef: exactMatch, catalogText: "", rawNotes: "" };
        }

        const catalogLines = parsedRows.slice(0, 25).map((r, idx) => {
          const parts = [`${idx + 1}. "${r.title || r.stem}"`];
          if (r.tags) parts.push(`Keywords: ${r.tags.slice(0, 140)}`);
          if (r.description) parts.push(`Desc: ${r.description.slice(0, 140)}`);
          return parts.join(" | ");
        });

        return {
          matchedRef: null,
          catalogText: catalogLines.join("\n").slice(0, 3500),
          rawNotes: "",
        };
      }
    }
  }

  return {
    matchedRef: null,
    catalogText: "",
    rawNotes: cleanText(cleaned).slice(0, 1500),
  };
}

function normalizeHashtags(rawTags, maxCount = 10, fallbackTags = []) {
  let list = [];
  if (Array.isArray(rawTags)) {
    list = rawTags.map((t) => cleanText(t)).filter(Boolean);
  } else if (typeof rawTags === "string") {
    const splitRe = rawTags.includes(",") && !rawTags.includes("#") ? /[,;]+/ : /[\s,;]+/;
    list = rawTags.split(splitRe).map((t) => cleanText(t)).filter(Boolean);
  }

  const seen = new Set();
  const formatted = [];
  for (const tag of list) {
    const body = tag.replace(/^#+/, "").replace(/[^a-zA-Z0-9_]/g, "");
    if (body.length < 2) continue;
    const key = body.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      formatted.push(`#${body.toLowerCase()}`);
    }
    if (formatted.length >= maxCount) break;
  }

  if (formatted.length === 0 && fallbackTags.length > 0) {
    return fallbackTags.slice(0, maxCount);
  }
  return formatted;
}

function normalizeCommaKeywords(rawTags, maxCount = 10, fallbackArr = []) {
  let list = [];
  if (Array.isArray(rawTags)) {
    list = rawTags.map((t) => cleanText(t).replace(/^#/, "")).filter(Boolean);
  } else if (typeof rawTags === "string") {
    list = rawTags
      .split(",")
      .map((t) => cleanText(t).replace(/^#/, ""))
      .filter(Boolean);
  }
  const seen = new Set();
  const out = [];
  for (const kw of list) {
    const key = kw.toLowerCase();
    if (kw.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
    if (out.length >= maxCount) break;
  }
  return out.length > 0 ? out : fallbackArr.slice(0, maxCount);
}

function deriveKeywordsFromTitle(title) {
  const words = cleanText(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !["the", "and", "for", "with", "that", "this", "are", "you"].includes(w));
  const hashBase = words.slice(0, 4).map((w) => `#${w}`);
  return [...new Set([...hashBase, "#graphictee", "#funnytshirt", "#printondemand", "#apparel", "#statementtee"])].slice(0, 8);
}

function extractSocialJSON(rawReply) {
  if (!rawReply || typeof rawReply !== "string") return null;
  let clean = rawReply.replace(/```json\s*/gi, "").replace(/```/g, "").trim();

  // Attempt balanced JSON extraction from outer braces
  const firstBrace = clean.indexOf("{");
  const lastBrace = clean.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = clean.slice(firstBrace, lastBrace + 1);
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object") return obj;
    } catch (_) {}
  }

  return null;
}

function normalizeSocialListing(rawObj, {
  fileName = "",
  matchedRef = null,
  selectedPlatforms = ["instagram", "facebook", "pinterest", "tiktok"],
  customStoreUrl = "",
  customBrandHandle = "",
  isOfflineMock = false,
} = {}) {
  const platforms = Array.isArray(selectedPlatforms) && selectedPlatforms.length > 0
    ? selectedPlatforms.map((p) => String(p || "").toLowerCase().trim()).filter(Boolean)
    : ["instagram", "facebook", "pinterest", "tiktok"];

  const obj = typeof rawObj === "object" && rawObj !== null ? rawObj : {};
  const cleanHandle = cleanText(customBrandHandle);
  const formattedHandle = cleanHandle ? (cleanHandle.startsWith("@") ? cleanHandle : `@${cleanHandle}`) : "";
  const defaultCta = formattedHandle
    ? `Shop the collection — Link in Bio! (${formattedHandle})`
    : "Shop the collection — Link in Bio!";
  const storeUrl = cleanText(customStoreUrl) || "https://yourstore.com";

  // Priority: Model's Vision-read title (unless unusable), then matched CSV title, then clean filename
  const cleanFileStem = cleanText(fileName).replace(/\.[^/.]+$/, "");
  let podTitle = cleanText(obj.title || obj.pod_title || obj.POD_Title || "");
  if (!podTitle || isNonDescriptiveFilename(podTitle)) {
    if (matchedRef?.title && !isNonDescriptiveFilename(matchedRef.title)) {
      podTitle = matchedRef.title;
    } else if (cleanFileStem && !isNonDescriptiveFilename(cleanFileStem)) {
      podTitle = cleanText(cleanFileStem.replace(/[-_]+/g, " "));
    } else if (isOfflineMock) {
      podTitle = "Statement Graphic Tee";
    } else {
      throw new Error("Model did not return a valid quote/title for this design");
    }
  }
  podTitle = truncateAtWord(podTitle, 45);

  const rawFileName = cleanText(obj.file_name || obj.File_Name || "");
  const fileNameMp4 = rawFileName && rawFileName.endsWith(".mp4") && !isNonDescriptiveFilename(rawFileName.replace(/\.mp4$/i, ""))
    ? rawFileName.toLowerCase().replace(/[^a-z0-9_.]+/g, "_")
    : toSnakeCaseMp4(podTitle);

  const fallbackHashtags = deriveKeywordsFromTitle(podTitle);
  const igSrc = obj.instagram && typeof obj.instagram === "object" ? obj.instagram : {};
  const fbSrc = obj.facebook && typeof obj.facebook === "object" ? obj.facebook : {};
  const pinSrc = obj.pinterest && typeof obj.pinterest === "object" ? obj.pinterest : {};
  const tikSrc = obj.tiktok && typeof obj.tiktok === "object" ? obj.tiktok : {};

  const igCaption = cleanText(igSrc.caption || obj.ig_caption || obj.IG_Caption || (isOfflineMock ? `${podTitle} — bold graphic tee style made for everyday wear.` : ""));
  const fbCaption = cleanText(fbSrc.caption || obj.fb_caption || obj.FB_Caption || (isOfflineMock ? `Who comes to mind first when you see "${podTitle}"? Tag them below!` : ""));

  const mergedHashtagsArr = normalizeHashtags(
    igSrc.hashtags || obj.hashtags || obj.Hashtags || matchedRef?.tags,
    10,
    fallbackHashtags
  );
  const mergedHashtagsStr = mergedHashtagsArr.join(" ");

  const merged = {
    title: podTitle,
    pod_title: podTitle,
    file_name: fileNameMp4,
    ig_caption: igCaption,
    fb_caption: fbCaption,
    hashtags: mergedHashtagsStr,
    call_to_action: cleanText(igSrc.call_to_action || obj.call_to_action || defaultCta),
    status: "READY",
    summary: cleanText(obj.summary) || `${podTitle} — custom apparel design`,
    target_audience: cleanText(obj.target_audience) || "Graphic tee & apparel shoppers",
    trademark_safe: obj.trademark_safe !== false,
    _selectedPlatforms: platforms,
  };

  if (platforms.includes("instagram")) {
    const igTags = normalizeHashtags(igSrc.hashtags || mergedHashtagsArr, 10, fallbackHashtags);
    merged.instagram = {
      title: podTitle,
      file_name: fileNameMp4,
      caption: igCaption || `${podTitle} — graphic apparel built to stand out.`,
      hashtags: igTags,
      call_to_action: cleanText(igSrc.call_to_action) || defaultCta,
      status: "READY",
    };
    if (!merged.ig_caption) merged.ig_caption = merged.instagram.caption;
  }

  if (platforms.includes("facebook")) {
    const fbTags = normalizeHashtags(fbSrc.hashtags || mergedHashtagsArr, 8, fallbackHashtags);
    merged.facebook = {
      title: podTitle,
      file_name: fileNameMp4,
      caption: fbCaption || `Who needs this "${podTitle}" shirt right now? Tag them below!`,
      hashtags: fbTags,
      call_to_action: cleanText(fbSrc.call_to_action) || defaultCta,
      status: "READY",
    };
    if (!merged.fb_caption) merged.fb_caption = merged.facebook.caption;
  }

  if (platforms.includes("pinterest")) {
    const pinTitle = truncateAtWord(
      cleanText(pinSrc.pin_title || pinSrc.Pin_Title || pinSrc.title || `${podTitle} | Graphic T-Shirt`),
      100
    );
    const pinDesc = truncateAtWord(
      cleanText(pinSrc.pin_description || pinSrc.Pin_Description || pinSrc.description) ||
        `${podTitle}. Expressive graphic t-shirt design crafted for everyday style and gifting. Tap to shop the collection!`,
      450
    );
    const boardName = cleanText(pinSrc.board_name || pinSrc.Board_Name || pinSrc.board) || "Graphic Tees & Apparel";
    const destLink = cleanText(customStoreUrl) || cleanText(pinSrc.destination_link || pinSrc.Destination_Link) || storeUrl;
    const pinTagsArr = normalizeCommaKeywords(
      pinSrc.tags || pinSrc.Tags || matchedRef?.tags,
      10,
      [podTitle.toLowerCase(), "graphic tee", "funny t-shirt", "trendy shirt", "casual apparel", "statement tee", "gift idea"]
    );

    merged.pinterest = {
      title: pinTitle,
      file_name: fileNameMp4,
      pin_title: pinTitle,
      pin_description: pinDesc,
      board_name: boardName,
      board: boardName,
      destination_link: destLink,
      tags: pinTagsArr.join(", "),
      hashtags: pinTagsArr.map((t) => `#${t.replace(/\s+/g, "")}`),
      status: "READY",
      call_to_action: "Tap to shop the collection!",
    };
  }

  if (platforms.includes("tiktok")) {
    const videoTitle = truncateAtWord(cleanText(tikSrc.video_title || tikSrc.title || podTitle), 48);
    const tikCap = truncateAtWord(
      cleanText(tikSrc.caption || tikSrc.TikTok_Caption) || `${podTitle} — Tap link in bio to check it out!`,
      220
    );
    const onScreenHook = cleanText(tikSrc.on_screen_hook || tikSrc.hook) || `POV: ${truncateAtWord(podTitle, 28)}`;
    const soundVibe = cleanText(tikSrc.sound_vibe) || "Trending Upbeat Apparel Audio";
    const tikTags = normalizeHashtags(
      tikSrc.hashtags,
      8,
      ["#fyp", "#tiktokfashion", ...fallbackHashtags.slice(0, 5)]
    );
    const tikCta = cleanText(tikSrc.call_to_action) || (formattedHandle ? `Tap link in bio! (${formattedHandle})` : "Tap link in bio to shop!");

    merged.tiktok = {
      title: videoTitle,
      video_title: videoTitle,
      file_name: fileNameMp4,
      caption: tikCap,
      on_screen_hook: onScreenHook,
      sound_vibe: soundVibe,
      hashtags: tikTags,
      call_to_action: tikCta,
      status: "READY",
    };
  }

  // Ensure live Gemini returned real channel content for at least one requested platform
  if (!isOfflineMock) {
    const hasRealCaption =
      (platforms.includes("instagram") && cleanText(igSrc.caption || obj.ig_caption).length >= 15) ||
      (platforms.includes("facebook") && cleanText(fbSrc.caption || obj.fb_caption).length >= 15) ||
      (platforms.includes("pinterest") && cleanText(pinSrc.pin_description || pinSrc.pin_title).length >= 15) ||
      (platforms.includes("tiktok") && cleanText(tikSrc.caption || tikSrc.video_title).length >= 10);

    if (!hasRealCaption) {
      throw new Error("Incomplete Social Media copy returned by model");
    }
  }

  return merged;
}

function persistSocialListingToLibrary({ fileName, designIndex, listing, imagePath, customBrandHandle = "" }) {
  let thumbnailRel = null;
  if (imagePath && fs.existsSync(imagePath)) {
    try {
      const stored = storeInLibrary(imagePath, `${uuidv4()}-listing-thumb.jpg`);
      thumbnailRel = stored.rel;
    } catch (err) {
      console.warn("[socialListing] Failed to store thumbnail:", err.message);
    }
  }

  const l = listing || {};
  const cleanHandle = cleanText(customBrandHandle);
  try {
    const saved = insertListing({
      id: uuidv4(),
      file_name: fileName || `Design #${designIndex}`,
      platform: "social",
      thumbnail_path: thumbnailRel,
      title: l.pod_title || l.title || `${fileName || "Design"} Social Listing`,
      brand: cleanHandle || l.target_audience || "Social Media",
      category: "Social Media > Multi-Platform",
      bullet1: l.file_name || null,
      bullet2: l.call_to_action || null,
      description: l.ig_caption || l.fb_caption || l.pinterest?.pin_description || l.tiktok?.caption || null,
      main_tag: l.pinterest?.board_name || l._selectedPlatforms?.[0] || "social",
      tags: [
        ...(Array.isArray(l.instagram?.hashtags) ? l.instagram.hashtags : []),
        ...(l.pinterest?.tags ? String(l.pinterest.tags).split(",").map((s) => s.trim()) : []),
        ...(Array.isArray(l.tiktok?.hashtags) ? l.tiktok.hashtags : []),
      ].slice(0, 25),
      attributes: {
        platforms: l._selectedPlatforms || ["instagram", "facebook", "pinterest", "tiktok"],
        target_audience: l.target_audience || "",
      },
      trademark_safe: l.trademark_safe !== false ? 1 : 0,
      raw_listing: l,
    });
    return { id: saved.id, thumbnailRel };
  } catch (err) {
    console.error("[socialListing] Failed to persist listing row:", err.message);
    return { id: null, thumbnailRel };
  }
}

async function processSocialListingOnAccount(
  account,
  design,
  referenceData,
  signal = null,
  selectedPlatforms = null,
  customStoreUrl = "",
  customBrandHandle = ""
) {
  const startTime = Date.now();
  const imageBase64 = design?.imageBase64 || design?.dataUrl || "";
  const fileName = design?.fileName || design?.name || "";
  const designIndex = Math.max(1, parseInt(design?.designIndex, 10) || 1);

  console.log(`[socialListing] Leased account: ${account.id} (${account.email || "no-email"})`);
  console.log(`[socialListing] Processing design ${designIndex} (${fileName}) for channels: ${JSON.stringify(selectedPlatforms || "all")}`);

  const base64Data = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");
  const rawBuf = Buffer.from(base64Data, "base64");
  const imagePath = path.join(os.tmpdir(), `social-listing-${uuidv4().slice(0, 8)}.jpg`);
  try {
    const sharp = (await import("sharp")).default;
    const jpgBuf = await sharp(rawBuf)
      .resize(800, 800, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: { r: 30, g: 30, b: 30 } })
      .jpeg({ quality: 82 })
      .toBuffer();
    fs.writeFileSync(imagePath, jpgBuf);
  } catch {
    fs.writeFileSync(imagePath, rawBuf);
  }

  try {
    const { matchedRef, catalogText, rawNotes } = parseSocialReference(referenceData, fileName);

    if (MOCK_GEMINI || !canLaunchBrowser(account.browser)) {
      recordGeneration(account.id);
      const normalized = normalizeSocialListing({}, {
        fileName,
        matchedRef,
        selectedPlatforms,
        customStoreUrl,
        customBrandHandle,
        isOfflineMock: true,
      });
      const persisted = persistSocialListingToLibrary({
        fileName,
        designIndex,
        listing: normalized,
        imagePath,
        customBrandHandle,
      });
      return {
        success: true,
        id: persisted.id,
        fileName: fileName || `Design #${designIndex}`,
        designIndex,
        platform: "social",
        thumbnailPath: persisted.thumbnailRel,
        thumbnailUrl: persisted.thumbnailRel ? `/library/${persisted.thumbnailRel}` : "",
        listing: normalized,
        generation_time: formatDuration(Date.now() - startTime),
        savedToLibrary: true,
      };
    }

    const page = await getProfilePage(account);
    const prompt = buildSocialListingPrompt({
      matchedRef,
      catalogText,
      rawNotes,
      imageContext: fileName,
      selectedPlatforms,
      customStoreUrl,
      customBrandHandle,
    });

    console.log(`[socialListing] Sending Vision prompt + image attachment to ${account.id} (via v1.0.26 geminiweb.js)...`);
    const reply = await web.generateText({
      prompt,
      imagePaths: [imagePath],
      page,
      signal,
      timeoutMs: 70000,
      accountId: account.id,
    });

    console.log(`[socialListing] Received model response (${reply?.length || 0} chars)`);
    recordGeneration(account.id);

    const parsed = extractSocialJSON(reply);
    if (!parsed) {
      throw new Error("Model reply was not valid Social Media JSON");
    }

    const normalizedListing = normalizeSocialListing(parsed, {
      fileName,
      matchedRef,
      selectedPlatforms,
      customStoreUrl,
      customBrandHandle,
      isOfflineMock: false,
    });

    const persisted = persistSocialListingToLibrary({
      fileName,
      designIndex,
      listing: normalizedListing,
      imagePath,
      customBrandHandle,
    });

    const durationMs = Date.now() - startTime;
    console.log(`[socialListing] Completed design ${designIndex} in ${durationMs}ms`);
    return {
      success: true,
      id: persisted.id,
      fileName: fileName || `Design #${designIndex}`,
      designIndex,
      platform: "social",
      thumbnailPath: persisted.thumbnailRel,
      thumbnailUrl: persisted.thumbnailRel ? `/library/${persisted.thumbnailRel}` : "",
      listing: normalizedListing,
      generation_time: formatDuration(durationMs),
      generation_time_ms: durationMs,
      savedToLibrary: true,
    };
  } finally {
    try {
      fs.rmSync(imagePath, { force: true });
    } catch {}
  }
}

// POST /api/social-listing/generate
router.post("/generate", async (req, res) => {
  let account = null;
  const routeAbort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) routeAbort.abort();
  });

  try {
    const {
      imageBase64 = "",
      referenceData = "",
      designIndex = 1,
      fileName = "",
      selectedPlatforms = null,
      customStoreUrl = "",
      customBrandHandle = "",
    } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    account = await acquireFleetAccount({ timeoutMs: 30000 });
    const result = await processSocialListingOnAccount(
      account,
      { imageBase64, fileName, designIndex },
      referenceData,
      routeAbort.signal,
      selectedPlatforms,
      customStoreUrl,
      customBrandHandle
    );
    res.json(result);
  } catch (err) {
    console.error("[SocialListing Error]:", err);
    if (err?.name === "GenerationTimeoutError" || err?.isTimeout) {
      return res.status(504).json({ error: "Social listing generation timed out. Browser released." });
    }
    res.status(500).json({ error: err.message || "Social listing backend failed" });
  } finally {
    if (account) {
      await closeProfile(account.id).catch(() => {});
      release(account.id);
    }
  }
});

// POST /api/social-listing/batch
router.post("/batch", async (req, res) => {
  const wantsStream = req.headers.accept?.includes("application/x-ndjson") || req.query.stream === "true";
  let heartbeatInterval = null;
  const batchAccountIds = new Set();

  try {
    const {
      designs = [],
      referenceData = "",
      selectedPlatforms = null,
      customStoreUrl = "",
      customBrandHandle = "",
    } = req.body || {};

    if (!Array.isArray(designs) || designs.length === 0) {
      return res.status(400).json({ error: "designs array is required" });
    }

    incrementActiveBatches();
    console.log(`[socialListing] Batch start: Files=${designs.length}, Channels=${JSON.stringify(selectedPlatforms || "all")}, stream=${wantsStream}`);

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
    const pending = designs.map((d, i) => ({
      design: { ...d, designIndex: d.designIndex || i + 1 },
      designIndex: d.designIndex || i + 1,
      retries: 0,
      failedAccountIds: [],
    }));

    const allUsable = listAccountsWithAbs().filter(
      (a) => a.active === 1 && a.status !== "disabled" && a.status !== "error" && a.status !== "signed_out"
    );
    const totalMemGb = os.totalmem() / (1024 * 1024 * 1024);
    const maxFleetCap = parseInt(process.env.MAX_FLEET_CONCURRENT || "8", 10);
    const safeSystemCap = totalMemGb >= 11.5 ? maxFleetCap : (totalMemGb >= 7.5 ? Math.min(maxFleetCap, 6) : 3);
    const workerCount = Math.max(1, Math.min(designs.length, allUsable.length || 1, safeSystemCap));
    let activeInFlight = 0;
    let poolDone = false;
    const routeAbort = new AbortController();

    res.on("close", () => {
      if (!res.writableEnded) {
        poolDone = true;
        routeAbort.abort();
        if (heartbeatInterval) clearInterval(heartbeatInterval);
      }
    });

    async function worker() {
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
          const excludeList = allUsable.length > 1 ? (item.failedAccountIds || []) : [];
          account = await acquireFleetAccount({ timeoutMs: 120000, excludeIds: excludeList });
          if (account?.id) {
            batchAccountIds.add(account.id);
            touchAccountSession(account.id);
          }

          const result = await processSocialListingOnAccount(
            account,
            design,
            referenceData,
            routeAbort.signal,
            selectedPlatforms,
            customStoreUrl,
            customBrandHandle
          );
          results.push(result);
          if (wantsStream && !res.writableEnded) {
            try {
              res.write(JSON.stringify({ event: "listing", result, designIndex }) + "\n");
            } catch (_) {}
          }
        } catch (err) {
          const isTimeout =
            err?.name === "GenerationTimeoutError" ||
            err?.isTimeout ||
            (err?.message || "").toLowerCase().includes("timed out");
          const msg = (err?.message || "").toLowerCase();
          console.error(`[socialListing] Failed design ${designIndex} (${design?.fileName}) on ${account ? account.id : "unassigned"}:`, err.message);

          if (account) {
            item.failedAccountIds = item.failedAccountIds || [];
            item.failedAccountIds.push(account.id);

            if (isTimeout || msg.includes("error") || msg.includes("stalled") || msg.includes("session") || msg.includes("incomplete") || msg.includes("valid")) {
              closeProfile(account.id).catch(() => {});
            }
            quarantine(account.id, allUsable.length > 1 ? 5000 : 2000);
          }

          if (item.retries < 2 && !msg.includes("invalid image") && !msg.includes("bad request") && !routeAbort.signal.aborted) {
            item.retries++;
            console.log(`[socialListing] Re-routing design ${designIndex} (attempt ${item.retries + 1}/3) to healthy account...`);
            if (wantsStream && !res.writableEnded) {
              try {
                res.write(JSON.stringify({
                  event: "listing_retrying",
                  designIndex,
                  fileName: design?.fileName,
                  attempt: item.retries + 1,
                  message: "Re-routing to healthy account…",
                }) + "\n");
              } catch (_) {}
            }
            pending.push(item);
          } else {
            const failedItem = {
              designIndex,
              fileName: design?.fileName || `Design #${designIndex}`,
              error: isTimeout
                ? "Generation timed out. Account released."
                : (err.message || "Could not generate social listing."),
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
            await parkAccountPageWhileLeased(account.id).catch(() => {});
            release(account.id);
            scheduleIdleClose(account.id);
          }
        }
      }
    }

    await Promise.all(
      Array.from({ length: workerCount }, async (_, i) => {
        if (i > 0) await new Promise((r) => setTimeout(r, i * 1200));
        return worker();
      })
    );

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
    console.error("[SocialListing Batch Error]:", err);
    if (wantsStream && !res.writableEnded) {
      try {
        res.write(JSON.stringify({ event: "error", error: err.message || "Social listing batch failed" }) + "\n");
        res.end();
      } catch (_) {}
      return;
    }
    res.status(500).json({ error: err.message || "Social listing batch failed" });
  } finally {
    decrementActiveBatches();
  }
});

// POST /api/social-listing/export-social
// Exports brand-neutral multi-sheet .xlsx workbook (Instagram, Facebook, Pinterest, TikTok tabs) or 12-col CSV.
router.post("/export-social", (req, res) => {
  try {
    const { items: inputItems = [], listings = [], format = "xlsx" } = req.body || {};
    const exportItems = (Array.isArray(inputItems) && inputItems.length > 0)
      ? inputItems
      : (Array.isArray(listings) ? listings : []);

    if (exportItems.length === 0) {
      return res.status(400).json({ error: "items or listings array is required" });
    }

    const dateStr = new Date().toISOString().slice(0, 10);

    if (format === "csv") {
      const escapeCSV = (val) => {
        if (val === null || val === undefined) return '""';
        const str = String(val).replace(/\r\n/g, " ").replace(/[\r\n]/g, " ");
        return `"${str.replace(/"/g, '""')}"`;
      };

      const headers = [
        "File_Name",
        "POD_Title",
        "IG_Caption",
        "FB_Caption",
        "Hashtags",
        "Call_To_Action",
        "Status",
        "Video_ID",
        "Cloudinary_URL",
        "IG_Media_ID",
        "FB_Post_ID",
        "Published_At",
      ];

      const rows = exportItems.map((it) => {
        const l = it.listing || {};
        const podTitle = l.pod_title || l.title || "Graphic Tee";
        const fileName = l.file_name || toSnakeCaseMp4(podTitle || it.fileName);
        const igCap = l.ig_caption || l.instagram?.caption || "";
        const fbCap = l.fb_caption || l.facebook?.caption || "";
        const tags = typeof l.hashtags === "string"
          ? l.hashtags
          : (Array.isArray(l.hashtags) ? l.hashtags.join(" ") : "");
        const cta = l.call_to_action || "Shop the collection — Link in Bio!";

        return [
          escapeCSV(fileName),
          escapeCSV(podTitle),
          escapeCSV(igCap),
          escapeCSV(fbCap),
          escapeCSV(tags),
          escapeCSV(cta),
          escapeCSV(l.status || "READY"),
          '""', '""', '""', '""', '""',
        ].join(",");
      });

      const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");
      res.setHeader("Content-Disposition", `attachment; filename="magic_social_listings_${dateStr}.csv"`);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      return res.send(csvContent);
    }

    const mod = XLSX.default || XLSX;
    const wb = mod.utils.book_new();
    const platforms = [
      { key: "instagram", name: "Instagram", headerCaption: "IG_Caption" },
      { key: "facebook", name: "Facebook", headerCaption: "FB_Caption" },
      { key: "pinterest", name: "Pinterest", headerCaption: "Pin_Description" },
      { key: "tiktok", name: "TikTok", headerCaption: "TikTok_Caption" },
    ];

    platforms.forEach(({ key, name, headerCaption }) => {
      const matchingItems = exportItems.filter((it) => it.listing && it.listing[key]);
      if (matchingItems.length === 0) return;

      const sheetHeaders = key === "pinterest"
        ? ["Design #", "File_Name", "Pin_Title", "Pin_Description", "Board_Name", "Destination_Link", "Tags", "Status"]
        : key === "tiktok"
          ? ["Design #", "File_Name", "Video_Title", "TikTok_Caption", "On_Screen_Hook", "Sound_Vibe", "Hashtags", "Call_To_Action", "Status"]
          : ["Design #", "File_Name", "POD_Title", headerCaption, "Hashtags", "Call_To_Action", "Status"];

      const rows = matchingItems.map((it) => {
        const l = it.listing || {};
        const pData = l[key] || {};
        const podTitle = pData.title || l.pod_title || l.title || "Graphic Tee";
        const fileName = pData.file_name || l.file_name || toSnakeCaseMp4(podTitle || it.fileName);
        const tags = Array.isArray(pData.hashtags)
          ? pData.hashtags.join(" ")
          : (pData.hashtags || l.hashtags || "");
        const cta = pData.call_to_action || l.call_to_action || "Shop the collection — Link in Bio!";

        if (key === "pinterest") {
          const pinTitle = pData.pin_title || `${podTitle} | Graphic T-Shirt`;
          const desc = pData.pin_description || l.ig_caption || "";
          const board = pData.board_name || pData.board || "Graphic Tees & Apparel";
          const destLink = pData.destination_link || "https://yourstore.com";
          const pinTags = pData.tags || (Array.isArray(pData.hashtags) ? pData.hashtags.join(", ") : "");
          return [it.designIndex ?? "", fileName, pinTitle, desc, board, destLink, pinTags, pData.status || "READY"];
        }

        if (key === "tiktok") {
          const videoTitle = pData.video_title || pData.title || podTitle;
          const caption = pData.caption || l.ig_caption || "";
          const onScreenHook = pData.on_screen_hook || pData.hook || "";
          const soundVibe = pData.sound_vibe || "";
          const tikTags = Array.isArray(pData.hashtags) ? pData.hashtags.join(" ") : (pData.hashtags || "");
          const tikCta = pData.call_to_action || "Tap link in bio to shop!";
          return [it.designIndex ?? "", fileName, videoTitle, caption, onScreenHook, soundVibe, tikTags, tikCta, pData.status || "READY"];
        }

        const caption = pData.caption || (key === "instagram" ? l.ig_caption : l.fb_caption) || "";
        return [it.designIndex ?? "", fileName, podTitle, caption, tags, cta, pData.status || "READY"];
      });

      const ws = mod.utils.aoa_to_sheet([sheetHeaders, ...rows]);
      mod.utils.book_append_sheet(wb, ws, name);
    });

    if (wb.SheetNames.length === 0) {
      const wsDef = mod.utils.aoa_to_sheet([["File_Name", "POD_Title", "IG_Caption", "FB_Caption", "Hashtags", "Call_To_Action", "Status"]]);
      mod.utils.book_append_sheet(wb, wsDef, "Social Media");
    }

    const buffer = mod.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Disposition", `attachment; filename="magic_fabrica_social_listings_${dateStr}.xlsx"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return res.send(buffer);
  } catch (err) {
    console.error("[Export Social Error]:", err);
    res.status(500).json({ error: err.message || "Failed to export social media listings" });
  }
});

export { parseSocialReference, extractSocialJSON, normalizeSocialListing };
export default router;
