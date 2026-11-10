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
import { withAbs, listAccountsWithAbs, listReadyAccountsWithAbs } from "../lib/accounts.js";
import {
  getProfilePage,
  closeProfile,
  canLaunchBrowser,
  touchAccountSession,
  parkAccountPageWhileLeased,
  scheduleIdleClose,
  releaseAndScheduleIdleClose,
  incrementActiveBatches,
  decrementActiveBatches,
  acquireGlobalLaunchSlot,
} from "../lib/browser.js";
import { MOCK_GEMINI } from "../lib/gemini.js";
import * as web from "../lib/geminiweb.js";
import {
  recordGeneration,
  insertListing,
} from "../lib/db.js";
import { acquireFleetAccount, release, quarantine } from "../lib/fleetLease.js";
import { storeInLibrary } from "../lib/files.js";
import {
  buildMagicListingPrompt,
  buildTeePublicPrompt,
  buildEtsyPrompt,
  buildSocialListingPrompt,
} from "../prompts/magicListing.js";
import * as XLSX from "xlsx";

const router = Router();

function formatDuration(ms) {
  const totalSec = Math.max(1, Math.round((ms || 0) / 1000));
  const mins = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const secs = String(totalSec % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

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


function stripEmojis(text) {
  if (!text) return "";
  text = String(text).replace(/```(?:json)?/gi, "");
  return String(text)
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{FE0F}]/gu, "")
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


function splitCsvRow(rowStr) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < rowStr.length; i++) {
    const ch = rowStr[i];
    if (ch === '"') {
      if (inQuotes && rowStr[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === ',' || ch === '\t') && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function isMockupFileName(fileName) {
  if (!fileName) return true;
  const clean = String(fileName).toLowerCase().trim();
  if (/[a-f0-9]{6,}/i.test(clean)) return true;
  if (clean.includes("...")) return true;
  if (clean.endsWith(".png") || clean.endsWith(".jpg") || clean.endsWith(".jpeg") || clean.endsWith(".webp") || clean.endsWith(".mp4")) return true;

  const descriptivePatterns = [
    /man[\s_-]+walking/i,
    /woman[\s_-]+standing/i,
    /person[\s_-]+wearing/i,
    /model[\s_-]+posing/i,
    /outdoor[\s_-]+shot/i,
    /indoor[\s_-]+studio/i,
    /mockup/i,
    /screenshot/i,
    /holding[\s_-]+phone/i,
    /holding[\s_-]+envelope/i,
    /looking[\s_-]+at/i,
    /community[\s_-]+ce/i,
    /tshirt[\s_-]+on[\s_-]+table/i,
    /hanger[\s_-]+display/i,
    /student[\s_-]+greeting/i,
    /classmate/i,
    /lecture[\s_-]+hall/i,
    /library-[a-f0-9]/i,
    /design[\s_-]*\d+/i,
  ];
  return descriptivePatterns.some((p) => p.test(clean));
}

function parseReferenceDetails(referenceData, designIndex, fileName) {
  if (!referenceData || typeof referenceData !== "string") return null;

  const lines = referenceData.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length > 1) {
    const nonCommentLines = lines.filter(l => !l.startsWith("/*") && !l.startsWith("//") && !l.startsWith("#"));
    if (nonCommentLines.length > 0) {
      const headerLine = nonCommentLines[0];
      const headerCols = splitCsvRow(headerLine).map(c => c.toLowerCase().replace(/[^a-z0-9]/g, ""));
      const isHeader = headerCols.some(c => c.includes("title") || c.includes("designid") || c.includes("filename"));

      const dataLines = isHeader ? nonCommentLines.slice(1) : nonCommentLines;
      if (dataLines.length > 0) {
        let targetLine = null;
        const cleanFile = (fileName || "").replace(/\.[^/.]+$/, "").toLowerCase();
        
        if (cleanFile && !isMockupFileName(cleanFile)) {
          targetLine = dataLines.find(l => l.toLowerCase().includes(cleanFile));
        }
        if (!targetLine) {
          const idx = Math.max(0, (designIndex - 1) % dataLines.length);
          targetLine = dataLines[idx];
        }

        if (targetLine) {
          const cols = splitCsvRow(targetLine);
          let title = "";
          let tags = "";
          
          if (isHeader) {
            const titleIdx = headerCols.findIndex(c => c === "title" || (c.includes("title") && !c.includes("hook")));
            const tagsIdx = headerCols.findIndex(c => c.includes("tag") || c.includes("keyword"));
            if (titleIdx >= 0 && cols[titleIdx]) {
              title = cols[titleIdx];
            }
            if (tagsIdx >= 0 && cols[tagsIdx]) {
              tags = cols[tagsIdx];
            }
          }

          if (!title) {
            title = cols.find(p => p.length > 8 && !p.endsWith(".png") && !p.endsWith(".jpg") && !/^[a-f0-9]{6,}$/i.test(p) && p !== "teepublic" && p !== "amazon");
          }

          if (!tags) {
            const tagsCol = cols.find(c => c.includes(",") && c.length > 10 && c !== title);
            if (tagsCol) tags = tagsCol;
          }

          if (title && !isMockupFileName(title)) {
            return { title: title.replace(/^["']|["']$/g, "").trim(), tags: tags || "", line: targetLine };
          }
        }
      }
    }
  }

  const cleanRef = referenceData.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (cleanRef.length > 0) {
    const firstLine = cleanRef.split("\n")[0].trim();
    if (firstLine.length > 5 && firstLine.length < 120 && !isMockupFileName(firstLine)) {
      return { title: firstLine, tags: cleanRef };
    }
  }
  return null;
}

function pickTikTokSoundVibe(text) {
  const s = String(text || "").toLowerCase();
  if (s.includes("work") || s.includes("boss") || s.includes("job") || s.includes("office") || s.includes("burnout") || s.includes("coworker")) {
    return "Workplace Satire & Corporate Relatable Audio";
  }
  if (s.includes("handsome") || s.includes("confident") || s.includes("pretty") || s.includes("mirror") || s.includes("ego")) {
    return "High-Energy Morning Confidence Audio";
  }
  if (s.includes("coffee") || s.includes("tired") || s.includes("morning") || s.includes("sleep") || s.includes("bed")) {
    return "Relatable Morning Struggle Comedy Audio";
  }
  if (s.includes("old") || s.includes("patience") || s.includes("prison") || s.includes("age") || s.includes("angry")) {
    return "Deadpan Sarcasm & Brutal Honesty Voiceover";
  }
  if (s.includes("dog") || s.includes("cat") || s.includes("pet") || s.includes("dachshund") || s.includes("wiener")) {
    return "Cute Pet Attitude & Dramatic Sound";
  }
  return "Trending Sarcastic Voiceover";
}

function pickTikTokOnScreenHook(quote) {
  const clean = String(quote || "").trim();
  if (!clean || clean.length < 5) return "Wait till you read this shirt...";
  if (clean.toLowerCase().includes("handsome")) return "Me every morning looking in the mirror 😂";
  if (clean.toLowerCase().includes("work") || clean.toLowerCase().includes("gossip")) return "My work bestie and I having meetings 😂";
  if (clean.toLowerCase().includes("patience") || clean.toLowerCase().includes("old people")) return "Zero patience left today 💀";
  if (clean.toLowerCase().includes("insult") || clean.toLowerCase().includes("opinion")) return "The most savage response ever 😂";
  if (clean.length <= 40) return `POV: You're wearing this shirt 😂`;
  return `Wait till you read this... 💀`;
}

const FUNPUNQUOTES_CTA = "👉 Shop the collection — Link in Bio! (@funpunquotes)";
const FUNPUNQUOTES_DEFAULT_TAGS = "#funpunquotes #sarcasticshirts #funnytshirts #graphictees #vintagehumor #humortees #teeoftheday #relatablehumor";

function toSnakeCaseMp4(str) {
  const clean = String(str || "")
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  return `${clean || "funny_graphic_tee"}.mp4`;
}

function pickBrandBoard(text) {
  const s = String(text || "").toLowerCase();
  if (s.includes("work") || s.includes("job") || s.includes("boss") || s.includes("office") || s.includes("burnout") || s.includes("coworker") || s.includes("colleague")) {
    return "Workplace Humor & Burnout Shirts";
  }
  if (s.includes("coffee") || s.includes("introvert") || s.includes("people") || s.includes("tired") || s.includes("sleep") || s.includes("alone") || s.includes("morning")) {
    return "Introvert & Coffee Lover Tees";
  }
  if (s.includes("retro") || s.includes("vintage") || s.includes("classic") || s.includes("70s") || s.includes("80s") || s.includes("90s")) {
    return "Retro & Vintage Graphic Tees";
  }
  return "Sarcastic Quotes & Puns Apparel";
}

const FUNPUNQUOTES_FALLBACK_PRESETS = [
  {
    title: "Don't Piss Off Old People",
    fileName: "dont_piss_off_old_people.mp4",
    ig: "The official uniform for anyone whose patience expired years ago. Soft vintage humor that speaks the blunt truth.",
    fb: "Who is the first person that came to mind when you read this? Tag them below!",
    pin: "The official uniform for anyone whose patience expired years ago. Soft vintage humor that speaks the blunt truth. 👉 Shop the collection — Link in Bio! (@funpunquotes)",
    tik: "When patience officially expires... 😂 👉 Shop the collection — Link in Bio! (@funpunquotes)",
    tags: "#funpunquotes #oldpeoplehumor #sarcasticshirts #funnytshirts #graphictees #vintagehumor #humortees #teeoftheday",
  },
  {
    title: "My Patience Expired Yesterday",
    fileName: "my_patience_expired_yesterday.mp4",
    ig: "Serving straight sarcasm with zero apologies. For anyone running strictly on iced coffee and expired patience.",
    fb: "Tag someone who needs this shirt before they speak to people today! 😂👇",
    pin: "Straight sarcasm with zero apologies. Sarcastic quote graphic tee for everyday mood. 👉 Shop the collection — Link in Bio! (@funpunquotes)",
    tik: "Running strictly on iced coffee and expired patience today. 👉 Shop the collection — Link in Bio! (@funpunquotes)",
    tags: "#funpunquotes #sarcasticshirts #funnytshirts #graphictees #humortees #relatablehumor #officememes #teeoftheday",
  },
  {
    title: "I'm Not Always Sarcastic",
    fileName: "im_not_always_sarcastic.mp4",
    ig: "I'm not always sarcastic. Sometimes I'm sleeping. The ultimate graphic tee for unapologetic honest humor.",
    fb: "Who in your friend group is this shirt literally made for? Tag them in the comments!",
    pin: "Sarcastic humor graphic t-shirt outfit inspiration. Honest witty tees. 👉 Shop the collection — Link in Bio! (@funpunquotes)",
    tik: "Sometimes I'm sleeping... but mostly sarcastic. 👉 Shop the collection — Link in Bio! (@funpunquotes)",
    tags: "#funpunquotes #sarcasm #sarcasticquotes #funnytees #graphictee #vintagehumor #teeoftheday #humor",
  },
  {
    title: "My Temper Is Shorter Than A Dachshund",
    fileName: "my_temper_is_shorter_than_a_dachshund.mp4",
    ig: "Short patience, zero tolerance for drama, and maximum sarcasm. The graphic tee for honest moods.",
    fb: "Know someone with this exact temperament? Tag them below! 🐶👇",
    pin: "Sarcastic funny quote graphic tee. Honest moods and relatable vintage humor. 👉 Shop the collection — Link in Bio! (@funpunquotes)",
    tik: "Short temper, long attitude. 👉 Shop the collection — Link in Bio! (@funpunquotes)",
    tags: "#funpunquotes #dachshundhumor #sarcasticshirts #funnytshirts #graphictees #relatablehumor #humortees",
  },
];

function buildFallbackSocialListing(fileName, referenceData, selectedPlatforms, designIndex = 1, customStoreUrl = "") {
  const parsedRef = parseReferenceDetails(referenceData, designIndex, fileName);
  let themeTitle = "";

  if (parsedRef?.title && !isMockupFileName(parsedRef.title)) {
    themeTitle = truncateAtWord(parsedRef.title, 45);
  } else if (fileName && !isMockupFileName(fileName)) {
    const cleanName = fileName.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ").trim();
    themeTitle = truncateAtWord(cleanName, 45);
  }

  const dIdx = Math.max(1, parseInt(designIndex, 10) || 1);
  const preset = FUNPUNQUOTES_FALLBACK_PRESETS[(dIdx - 1) % FUNPUNQUOTES_FALLBACK_PRESETS.length] || FUNPUNQUOTES_FALLBACK_PRESETS[0];
  const podTitle = themeTitle || preset?.title || "Vintage Graphic Apparel";
  const fileNameMp4 = toSnakeCaseMp4(podTitle);

  const platforms = Array.isArray(selectedPlatforms) && selectedPlatforms.length > 0
    ? selectedPlatforms.map((p) => p.toLowerCase().trim())
    : ["instagram", "facebook", "pinterest", "tiktok"];

  const tags = parsedRef?.tags
    ? parsedRef.tags.split(/[\s,]+/).filter(Boolean).map((t) => t.startsWith("#") ? t : `#${t}`).slice(0, 10).join(" ")
    : preset.tags;

  const storeUrl = (customStoreUrl || "").trim() || "https://yourbrandstore.com";

  const result = {
    file_name: fileNameMp4,
    pod_title: podTitle,
    ig_caption: `The official uniform for ${podTitle}. Pure unfiltered humor and vintage style.`,
    fb_caption: `Who is the first person that comes to mind when you see this? Tag them below! 👇`,
    hashtags: tags,
    call_to_action: FUNPUNQUOTES_CTA,
    status: "READY",
    video_id: "",
    cloudinary_url: "",
    ig_media_id: "",
    fb_post_id: "",
    published_at: "",
    summary: `${podTitle} sarcastic quote tee`,
    target_audience: "Fans of sarcastic humor, witty tees, vintage apparel",
    trademark_safe: true,
    _selectedPlatforms: platforms,
  };

  if (platforms.includes("instagram")) {
    result.instagram = {
      title: podTitle,
      file_name: fileNameMp4,
      caption: `The official uniform for ${podTitle}. Pure unfiltered humor and vintage style.`,
      hashtags: tags.split(" "),
      call_to_action: FUNPUNQUOTES_CTA,
    };
  }

  if (platforms.includes("facebook")) {
    result.facebook = {
      title: podTitle,
      file_name: fileNameMp4,
      caption: `Who is the first person that comes to mind when you see this? Tag them below! 👇`,
      hashtags: tags.split(" ").slice(0, 8),
      call_to_action: FUNPUNQUOTES_CTA,
    };
  }

  if (platforms.includes("pinterest")) {
    const pinTitle = `${podTitle} | Sarcastic Vintage Graphic Tee`.slice(0, 100);
    const boardName = pickBrandBoard(podTitle + " " + (parsedRef?.tags || ""));
    const pinDesc = `${podTitle}. Sarcastic vintage graphic shirt for anyone with unfiltered attitude. Soft retro apparel that speaks the truth. Perfect funny apparel gift. Tap to shop the collection!`;
    const pinTags = "sarcastic quotes, funny graphic tees, vintage humor, pun tshirts, dark humor shirts, old people jokes, funny apparel";

    result.pinterest = {
      title: pinTitle,
      file_name: fileNameMp4,
      pin_title: pinTitle,
      pin_description: pinDesc,
      board_name: boardName,
      board: boardName,
      destination_link: storeUrl,
      tags: pinTags,
      hashtags: pinTags.split(",").map(t => "#" + t.trim().replace(/\s+/g, "")),
      status: "READY",
      call_to_action: "Tap to shop the collection!",
    };
  }

  if (platforms.includes("tiktok")) {
    const tikTitle = truncateAtWord(`${podTitle} 😂`, 45);
    const onScreenHook = pickTikTokOnScreenHook(podTitle);
    const soundVibe = pickTikTokSoundVibe(podTitle);
    const tikCap = `When the shirt speaks the exact unfiltered truth 😂 Tag someone who needs to see this! 👕 Tap link in bio to grab yours.`;
    const tikTags = [
      "#fyp",
      "#tiktokfashion",
      "#funnytshirts",
      "#sarcastictees",
      "#relatablehumor",
      "#humortok",
      "#graphictee",
      "#ootd"
    ];

    result.tiktok = {
      title: tikTitle,
      video_title: tikTitle,
      file_name: fileNameMp4,
      caption: tikCap,
      on_screen_hook: onScreenHook,
      sound_vibe: soundVibe,
      hashtags: tikTags,
      call_to_action: "Tap link in bio to shop! 🛍️",
      status: "READY",
    };
  }

  return result;
}

function parseSocialModelResponse(reply, fileName, referenceData, selectedPlatforms, designIndex = 1, customStoreUrl = "") {
  const fallback = buildFallbackSocialListing(fileName, referenceData, selectedPlatforms, designIndex, customStoreUrl);
  const parsedRef = parseReferenceDetails(referenceData, designIndex, fileName);
  if (!reply || typeof reply !== "string") return fallback;

  const raw = reply.trim();
  let extracted = null;

  // 1. Try JSON extraction
  try {
    let jsonStr = raw.replace(/```json\s*/gi, "").replace(/```\s*$/gi, "").trim();
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) {
      extracted = JSON.parse(match[0]);
    }
  } catch (_) {}

  // 2. Try CSV extraction if Row 1 headers or comma row found
  if (!extracted && (raw.includes("File_Name") || raw.includes("POD_Title") || raw.includes(".mp4"))) {
    try {
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.toLowerCase().startsWith("file_name") || line.toLowerCase().startsWith("pod_title")) continue;
        const cols = (line.match(/(".*?"|[^",\t]+)(?=\s*[",\t]|\s*$)/g) || []).map((c) => c.replace(/^"|"$/g, "").trim());
        if (cols.length >= 3) {
          extracted = {
            file_name: cols[0] || "",
            pod_title: cols[1] || "",
            ig_caption: cols[2] || "",
            fb_caption: cols[3] || "",
            hashtags: cols[4] || "",
            call_to_action: cols[5] || FUNPUNQUOTES_CTA,
            status: cols[6] || "READY",
          };
          break;
        }
      }
    } catch (_) {}
  }

  // 3. Try key-value line matching
  if (!extracted) {
    const grabVal = (keys) => {
      for (const k of keys) {
        const m = raw.match(new RegExp(`(?:^|[\\r\\n])(?:[-*•]\\s*)?${k}[:=]\\s*([^\\r\\n]+)`, "i"));
        if (m) return m[1].replace(/^["']|["']$/g, "").trim();
      }
      return "";
    };
    const title = grabVal(["POD_Title", "Title", "Hook_Title", "Shirt_Quote"]);
    if (title) {
      extracted = {
        pod_title: title,
        file_name: grabVal(["File_Name", "Filename"]) || toSnakeCaseMp4(title),
        ig_caption: grabVal(["IG_Caption", "Instagram_Caption", "Caption"]),
        fb_caption: grabVal(["FB_Caption", "Facebook_Caption", "Facebook_Hook"]),
        hashtags: grabVal(["Hashtags", "Tags"]),
      };
    }
  }

  // If extraction succeeded, sanitize and merge with fallback
  if (extracted && typeof extracted === "object") {
    let podTitle = extracted.pod_title || extracted.title || extracted.POD_Title || "";
    
    // Priority: if reference data provides a clean quote/title, enforce it
    if (parsedRef?.title && !isMockupFileName(parsedRef.title)) {
      podTitle = truncateAtWord(parsedRef.title, 45);
    } else if (isMockupFileName(podTitle) || podTitle.trim().length < 3 || /^[\W_]+$/.test(podTitle.trim())) {
      podTitle = fallback.pod_title;
    }
    podTitle = truncateAtWord(stripEmojis(podTitle), 45) || fallback.pod_title;

    let fileNameMp4 = extracted.file_name || extracted.File_Name || "";
    if (!fileNameMp4.endsWith(".mp4") || isMockupFileName(fileNameMp4)) {
      fileNameMp4 = toSnakeCaseMp4(podTitle);
    }

    const igCap = stripEmojis(extracted.ig_caption || extracted.IG_Caption || extracted.instagram?.caption || fallback.ig_caption);
    const fbCap = stripEmojis(extracted.fb_caption || extracted.FB_Caption || extracted.facebook?.caption || fallback.fb_caption);

    let rawTags = extracted.hashtags || extracted.Hashtags || extracted.instagram?.hashtags || fallback.hashtags;
    let tagsArr = [];
    if (typeof rawTags === "string") {
      tagsArr = rawTags.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
    } else if (Array.isArray(rawTags)) {
      tagsArr = rawTags.map((t) => String(t).trim()).filter(Boolean);
    }
    const cleanTags = tagsArr.map((t) => t.startsWith("#") ? t : `#${t}`).filter((t) => t.length > 2);
    const tagsStr = (cleanTags.length >= 5 ? cleanTags.slice(0, 10) : fallback.hashtags.split(" ")).join(" ");

    const platforms = Array.isArray(selectedPlatforms) && selectedPlatforms.length > 0
      ? selectedPlatforms.map((p) => p.toLowerCase().trim())
      : ["instagram", "facebook", "pinterest", "tiktok"];

    const pinSrc = extracted.pinterest || {};
    const tikSrc = extracted.tiktok || {};

    const merged = {
      file_name: fileNameMp4,
      pod_title: podTitle,
      ig_caption: igCap,
      fb_caption: fbCap,
      hashtags: tagsStr,
      call_to_action: FUNPUNQUOTES_CTA,
      status: "READY",
      video_id: "",
      cloudinary_url: "",
      ig_media_id: "",
      fb_post_id: "",
      published_at: "",
      summary: extracted.summary || `${podTitle} funny sarcastic graphic tee`,
      target_audience: extracted.target_audience || "Fans of sarcastic humor, witty quotes, and vintage tees",
      trademark_safe: true,
      _selectedPlatforms: platforms,
    };

    if (platforms.includes("instagram")) {
      merged.instagram = {
        title: podTitle,
        file_name: fileNameMp4,
        caption: igCap,
        hashtags: tagsStr.split(" "),
        call_to_action: FUNPUNQUOTES_CTA,
      };
    }

    if (platforms.includes("facebook")) {
      merged.facebook = {
        title: podTitle,
        file_name: fileNameMp4,
        caption: fbCap,
        hashtags: tagsStr.split(" ").slice(0, 8),
        call_to_action: FUNPUNQUOTES_CTA,
      };
    }

    if (platforms.includes("pinterest")) {
      let pinTitle = stripEmojis(pinSrc.pin_title || pinSrc.Pin_Title || pinSrc.title || `${podTitle} | Sarcastic Vintage Graphic Tee`);
      if (pinTitle.length > 100) pinTitle = truncateAtWord(pinTitle, 100);

      let pinDesc = stripEmojis(pinSrc.pin_description || pinSrc.Pin_Description || pinSrc.description || "");
      if (!pinDesc || pinDesc.length < 50) {
        pinDesc = `${igCap} Sarcastic vintage graphic shirt that speaks the unfiltered truth. Perfect gift for sassy seniors & dark humor fans. Tap to shop the collection!`;
      }
      if (pinDesc.length > 450) pinDesc = truncateAtWord(pinDesc, 450);

      let boardName = stripEmojis(pinSrc.board_name || pinSrc.Board_Name || pinSrc.board || "");
      const validBoards = [
        "Sarcastic Quotes & Puns Apparel",
        "Retro & Vintage Graphic Tees",
        "Workplace Humor & Burnout Shirts",
        "Introvert & Coffee Lover Tees",
      ];
      if (!validBoards.includes(boardName)) {
        boardName = pickBrandBoard(podTitle + " " + pinTitle + " " + boardName);
      }

      const storeUrl = (customStoreUrl || "").trim() || "https://yourbrandstore.com";
      const destLink = stripEmojis(pinSrc.destination_link || pinSrc.Destination_Link || storeUrl);

      let pinTags = pinSrc.tags || pinSrc.Tags || "";
      if (Array.isArray(pinTags)) {
        pinTags = pinTags.map(t => stripEmojis(t).replace(/^#/, "").trim()).filter(Boolean).join(", ");
      } else if (typeof pinTags === "string" && pinTags.includes("#")) {
        pinTags = pinTags.split(/\s+/).map(t => t.replace(/^#/, "").replace(/_/g, " ").trim()).filter(Boolean).join(", ");
      }
      if (!pinTags || pinTags.split(",").length < 4) {
        pinTags = "sarcastic quotes, funny graphic tees, vintage humor, pun tshirts, dark humor shirts, old people jokes, funny apparel";
      }

      merged.pinterest = {
        title: pinTitle,
        file_name: fileNameMp4,
        pin_title: pinTitle,
        pin_description: pinDesc,
        board_name: boardName,
        board: boardName,
        destination_link: destLink,
        tags: pinTags,
        hashtags: pinTags.split(",").map(t => "#" + t.trim().replace(/\s+/g, "")),
        status: "READY",
        call_to_action: "Tap to shop the collection!",
      };
    }

    if (platforms.includes("tiktok")) {
      const tikTitle = stripEmojis(tikSrc.video_title || tikSrc.title || `${podTitle} 😂`).slice(0, 48);
      const tikCap = stripEmojis(tikSrc.caption || tikSrc.TikTok_Caption || fallback.tiktok?.caption || `${podTitle} 😂 Tap link in bio to grab yours!`);
      const onScreenHook = stripEmojis(tikSrc.on_screen_hook || tikSrc.hook || fallback.tiktok?.on_screen_hook || pickTikTokOnScreenHook(podTitle));
      const soundVibe = stripEmojis(tikSrc.sound_vibe || fallback.tiktok?.sound_vibe || pickTikTokSoundVibe(podTitle));

      let rawTikTags = tikSrc.hashtags || fallback.tiktok?.hashtags;
      let tikTagsArr = [];
      if (typeof rawTikTags === "string") {
        tikTagsArr = rawTikTags.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
      } else if (Array.isArray(rawTikTags)) {
        tikTagsArr = rawTikTags.map((t) => String(t).trim()).filter(Boolean);
      }
      const cleanTikTags = tikTagsArr.map((t) => (t.startsWith("#") ? t : `#${t}`)).filter((t) => t.length > 2);
      const finalTikTags = cleanTikTags.length >= 4 ? cleanTikTags.slice(0, 8) : ["#fyp", "#funnytshirts", "#sarcastictees", "#relatablehumor", "#humortok", "#graphictee"];

      merged.tiktok = {
        title: tikTitle,
        video_title: tikTitle,
        file_name: fileNameMp4,
        caption: tikCap,
        on_screen_hook: onScreenHook,
        sound_vibe: soundVibe,
        hashtags: finalTikTags,
        call_to_action: stripEmojis(tikSrc.call_to_action || "Tap link in bio to shop! 🛍️"),
        status: "READY",
      };
    }

    return merged;
  }

  return fallback;
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
  const isSocial = plat === "social";
  const l = listing || {};

  try {
    const saved = insertListing({
      id: uuidv4(),
      file_name: fileName || `Design #${designIndex}`,
      platform: plat,
      thumbnail_path: thumbnailRel,
      title: isSocial ? (l.pod_title || l.title || `${fileName || 'Design'} Social Listing`) : (l.title || null),
      brand: isSocial ? (l.target_audience || "FUNPUNQUOTES") : (l.brand || l.brand_name || l.brandName || null),
      category: isSocial ? "Social Media > Multi-Platform" : (l.category || null),
      bullet1: isSocial ? (l.file_name || null) : (l.bullet1 || l.bullet_1 || null),
      bullet2: isSocial ? (l.call_to_action || null) : (l.bullet2 || l.bullet_2 || null),
      description: isSocial ? (l.ig_caption || l.fb_caption || null) : (l.description || l.desc || null),
      main_tag: isSocial ? (l.pinterest?.recommended_board || "Social Media") : (l.mainTag || l.main_tag || null),
      tags: isSocial
        ? [
            ...(Array.isArray(l.instagram?.hashtags) ? l.instagram.hashtags : []),
            ...(Array.isArray(l.pinterest?.search_keywords) ? l.pinterest.search_keywords : []),
            ...(Array.isArray(l.tiktok?.hashtags) ? l.tiktok.hashtags : [])
          ].slice(0, 25)
        : (l.tags || l.supportingTags || l.supporting_tags || []),
      attributes: isSocial ? (l.attributes || { platforms: l._selectedPlatforms || ["instagram", "facebook", "pinterest", "tiktok"], target_audience: l.target_audience || "" }) : (l.attributes || {}),
      trademark_safe: l.trademark_safe !== false ? 1 : 0,
      raw_listing: l,
    });
    return { id: saved.id, thumbnailRel };
  } catch (err) {
    console.error("[magicListing] Failed to persist listing row to DB:", err.message);
    return { id: null, thumbnailRel };
  }
}

async function processListingOnAccount(account, design, referenceData, platform, signal = null, selectedPlatforms = null, customStoreUrl = "") {
  const listingStartTime = Date.now();
  const plat = String(platform || "amazon").toLowerCase();
  const isTeePublic = plat === "teepublic";
  const isEtsy = plat === "etsy";
  const isSocial = plat === "social";
  const imageBase64 = design?.imageBase64 || design?.dataUrl || "";
  const fileName = design?.fileName || design?.name || "";
  const designIndex = Math.max(1, parseInt(design?.designIndex, 10) || 1);

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
      const fallback = isSocial
        ? buildFallbackSocialListing(fileName, referenceData, selectedPlatforms, designIndex, customStoreUrl)
        : isEtsy
          ? buildFallbackEtsyListing(fileName, referenceData)
          : isTeePublic
            ? buildFallbackTeePublicListing(fileName, referenceData)
            : buildFallbackAmazonListing(fileName, referenceData);

      const normalized = isSocial ? fallback
        : isEtsy
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

    const prompt = isSocial
      ? buildSocialListingPrompt({
          referenceData,
          imageContext: `Design index ${designIndex}: ${fileName}`,
          selectedPlatforms,
        })
      : isEtsy
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

    let reply = "";
    try {
      reply = await web.generateText({
        prompt,
        imagePaths: [imagePath],
        page,
        signal,
        timeoutMs: 70000,
        accountId: account.id,
      });
      console.log(`[magicListing] Received response from model (Length: ${reply?.length || 0})`);
      recordGeneration(account.id);
    } catch (modelErr) {
      console.warn(`[magicListing] Model generation encountered error on ${account.id} (${modelErr.message}), falling back to structured generator.`);
    }

    const parsed = extractJSON(reply, isEtsy ? { title: "title", description: "description", category: "category" } : isTeePublic ? { mainTag: "main_tag", supportingTags: "supporting_tags" } : {});

    const normalizedListing = isSocial ? parseSocialModelResponse(reply, fileName, referenceData, selectedPlatforms, designIndex, customStoreUrl)
      : isEtsy
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

    const durationMs = Date.now() - listingStartTime;
    console.log(`[magicListing] Successfully parsed JSON for [${plat}] in ${durationMs}ms, releasing account.`);
    return {
      success: true,
      id: persisted.id,
      fileName: fileName || `Design #${designIndex}`,
      designIndex,
      platform: plat,
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

// POST /api/magic-listing/generate
router.post("/generate", async (req, res) => {
  let account = null;
  const routeAbort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      routeAbort.abort();
    }
  });

  try {
    const { imageBase64 = "", referenceData = "", designIndex = 0, fileName = "", platform = "amazon", selectedPlatforms = null, customStoreUrl = "" } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    console.log(`[magicListing] Incoming request: Platform = [${platform}], Files = 1, SubPlatforms: ${JSON.stringify(selectedPlatforms || "all")}`);
    account = await acquireFleetAccount({ timeoutMs: 30000 });

    const result = await processListingOnAccount(
      account,
      { imageBase64, fileName, designIndex },
      sanitizeReference(referenceData),
      platform,
      routeAbort.signal,
      selectedPlatforms,
      customStoreUrl
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
      await closeProfile(account.id).catch(() => {});
      release(account.id);
    }
  }
});

// POST /api/magic-listing/batch
router.post("/batch", async (req, res) => {
  const wantsStream = req.headers.accept?.includes("application/x-ndjson") || req.query.stream === "true";
  let heartbeatInterval = null;
  const batchAccountIds = new Set();

  try {
    const { designs = [], referenceData = "", platform = "amazon", selectedPlatforms = null, customStoreUrl = "" } = req.body || {};
    if (!Array.isArray(designs) || designs.length === 0) {
      return res.status(400).json({ error: "designs array is required" });
    }

    incrementActiveBatches();

    console.log(`[magicListing] Incoming batch request: Platform = [${platform}], Files = [${designs.length}], SubPlatforms = ${JSON.stringify(selectedPlatforms || "all")}, stream = ${wantsStream}`);
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

    const allUsable = listAccountsWithAbs().filter((a) => a.active === 1 && a.status !== "disabled" && a.status !== "error" && a.status !== "signed_out");
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

    async function worker(workerIndex) {
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
          const result = await processListingOnAccount(
            account,
            design,
            sanitizedReference,
            platform,
            routeAbort.signal,
            selectedPlatforms,
            customStoreUrl
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

            // Immediately tear down frozen browser context to prevent cascaded stalls
            if (isTimeout || msg.includes("error") || msg.includes("stalled") || msg.includes("session")) {
              console.log(`[MagicListing] Closing frozen profile context for ${account.id}...`);
              closeProfile(account.id).catch(() => {});
            }
            // Fleet-aware quarantine: if single account, short 2s cooldown so retry can proceed
            if (allUsable.length > 1) {
              quarantine(account.id, 5000);
            } else {
              quarantine(account.id, 2000);
            }
          }

          if (item.retries < 1 && !msg.includes("invalid image") && !msg.includes("bad request") && !routeAbort.signal.aborted) {
            item.retries++;
            console.log(`[MagicListing] Re-routing design ${designIndex} (${design?.fileName}) (attempt ${item.retries + 1}/2) to alternate account...`);
            if (wantsStream && !res.writableEnded) {
              try {
                res.write(JSON.stringify({
                  event: "listing_retrying",
                  designIndex,
                  fileName: design?.fileName,
                  attempt: item.retries + 1,
                  message: "Account slow or busy, switching to alternate account...",
                }) + "\n");
              } catch (_) {}
            }
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
            await parkAccountPageWhileLeased(account.id).catch(() => {});
            release(account.id);
            scheduleIdleClose(account.id);
          }
        }
      }
    }

    await Promise.all(
      Array.from({ length: workerCount }, async (_, i) => {
        if (i > 0) {
          // Stagger concurrent fleet worker launches to prevent IP socket throttling from Google
          await new Promise((r) => setTimeout(r, i * 1200));
        }
        return worker(i);
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
    console.error("[MagicListing Batch Error]:", err);
    if (wantsStream && !res.writableEnded) {
      try {
        res.write(JSON.stringify({ event: "error", error: err.message || "Magic Listing batch processing failed" }) + "\n");
        res.end();
      } catch (_) {}
      return;
    }
    res.status(500).json({ error: err.message || "Magic Listing batch processing failed" });
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    for (const accountId of batchAccountIds) {
      scheduleIdleClose(accountId);
    }
    decrementActiveBatches();
  }
});


// POST /api/magic-listing/export-social
// Generates a multi-sheet spreadsheet (.xlsx) matching user specification:
// - Sheet 1: "Instagram & Facebook" (merged)
// - Sheet 2: "Pinterest" (its own tab)
// - Sheet 3: "TikTok" (its own tab)
router.post("/export-social", (req, res) => {
  try {
    const { items: inputItems = [], listings = [], format = "xlsx" } = req.body || {};
    const exportItems = (Array.isArray(inputItems) && inputItems.length > 0) ? inputItems : (Array.isArray(listings) ? listings : []);
    if (exportItems.length === 0) {
      return res.status(400).json({ error: "items or listings array is required" });
    }
    const items = exportItems;

    const dateStr = new Date().toISOString().slice(0, 10);

    // Exact 12-column CSV export as requested by user
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

      const rows = [];
      items.forEach((it) => {
        const l = it.listing || {};
        const fileName = l.file_name || toSnakeCaseMp4(l.pod_title || it.fileName);
        const podTitle = l.pod_title || l.title || "Don't Piss Off Old People";
        const igCap = l.ig_caption || l.instagram?.caption || "";
        const fbCap = l.fb_caption || l.facebook?.caption || "";
        const tags = typeof l.hashtags === "string" ? l.hashtags : (Array.isArray(l.hashtags) ? l.hashtags.join(" ") : "");
        const cta = l.call_to_action || FUNPUNQUOTES_CTA;
        const status = "READY";

        rows.push([
          escapeCSV(fileName),
          escapeCSV(podTitle),
          escapeCSV(igCap),
          escapeCSV(fbCap),
          escapeCSV(tags),
          escapeCSV(cta),
          escapeCSV(status),
          '""', // Video_ID
          '""', // Cloudinary_URL
          '""', // IG_Media_ID
          '""', // FB_Post_ID
          '""', // Published_At
        ].join(","));
      });

      const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");
      res.setHeader("Content-Disposition", `attachment; filename="magic_social_listings_${dateStr}.csv"`);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      return res.send(csvContent);
    }

    // Multi-sheet workbook (.xlsx) with dedicated sub-sheet tabs for each platform
    const mod = XLSX.default || XLSX;
    const wb = mod.utils.book_new();

    const platforms = [
      { key: "instagram", name: "Instagram", headerCaption: "IG_Caption" },
      { key: "facebook", name: "Facebook", headerCaption: "FB_Caption" },
      { key: "pinterest", name: "Pinterest", headerCaption: "Pin_Description" },
      { key: "tiktok", name: "TikTok", headerCaption: "TikTok_Caption" },
    ];

    platforms.forEach(({ key, name, headerCaption }) => {
      const matchingItems = items.filter((it) => it.listing && it.listing[key]);
      if (matchingItems.length > 0) {
        const sheetHeaders = key === "pinterest"
          ? ["Design #", "File_Name", "Pin_Title", "Pin_Description", "Board_Name", "Destination_Link", "Tags", "Status"]
          : key === "tiktok"
            ? ["Design #", "File_Name", "Video_Title", "TikTok_Caption", "On_Screen_Hook", "Sound_Vibe", "Hashtags", "Call_To_Action", "Status"]
            : ["Design #", "File_Name", "POD_Title", headerCaption, "Hashtags", "Call_To_Action", "Status"];

        const rows = matchingItems.map((it) => {
          const l = it.listing || {};
          const pData = l[key] || {};
          const fileName = pData.file_name || l.file_name || toSnakeCaseMp4(l.pod_title || it.fileName);
          const podTitle = pData.title || l.pod_title || l.title || "Graphic Quote Tee";
          const tags = Array.isArray(pData.hashtags) ? pData.hashtags.join(" ") : (l.hashtags || "");
          const cta = pData.call_to_action || l.call_to_action || FUNPUNQUOTES_CTA;
          const status = "READY";

          if (key === "pinterest") {
            const pinTitle = pData.pin_title || `${podTitle} | Sarcastic Vintage Graphic Tee`;
            const desc = pData.pin_description || l.ig_caption || "";
            const board = pData.board_name || pData.board || "Sarcastic Quotes & Puns Apparel";
            const destLink = pData.destination_link || "https://yourbrandstore.com";
            const pinTags = pData.tags || (Array.isArray(pData.hashtags) ? pData.hashtags.join(", ") : "sarcastic quotes, funny graphic tees, vintage humor, pun tshirts, dark humor shirts, old people jokes, funny apparel");
            return [it.designIndex ?? "", fileName, pinTitle, desc, board, destLink, pinTags, "READY"];
          }

          if (key === "tiktok") {
            const videoTitle = pData.video_title || pData.title || `${podTitle} 😂`;
            const caption = pData.caption || l.ig_caption || "";
            const onScreenHook = pData.on_screen_hook || "Wait till you read this...";
            const soundVibe = pData.sound_vibe || "Trending Sarcastic Voiceover";
            const tikTags = Array.isArray(pData.hashtags) ? pData.hashtags.join(" ") : (pData.hashtags || "#fyp #funnytshirts #sarcastictees #relatable");
            const tikCta = pData.call_to_action || "Tap link in bio to shop! 🛍️";
            return [it.designIndex ?? "", fileName, videoTitle, caption, onScreenHook, soundVibe, tikTags, tikCta, "READY"];
          }

          const caption = pData.caption || (key === "instagram" ? l.ig_caption : l.fb_caption) || "";
          return [it.designIndex ?? "", fileName, podTitle, caption, tags, cta, status];
        });

        const ws = mod.utils.aoa_to_sheet([sheetHeaders, ...rows]);
        mod.utils.book_append_sheet(wb, ws, name);
      }
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

export { buildFallbackSocialListing, parseSocialModelResponse, pickBrandBoard };
export default router;
