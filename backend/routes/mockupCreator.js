import { Router } from "express";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { upload, storeInLibrary, removeFileSafe } from "../lib/files.js";
import { insertMockup } from "../lib/db.js";
import { hasReadyAccount } from "../lib/accounts.js";
import { runFleetBatch } from "../lib/queue.js";
import { buildPrompt } from "../prompts/mockupCreator.js";
import { formatImageToAspectRatio } from "../lib/aspectRatioEnforcer.js";

const router = Router();

function formatDuration(ms) {
  const totalSec = Math.max(1, Math.round((ms || 0) / 1000));
  const mins = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const secs = String(totalSec % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

/**
 * Ensures reference images passed to Gemini Web upload in under 1 second,
 * even if the user provided high-resolution uncompressed 10MB+ assets.
 */
async function optimizeReferenceForGemini(absPath) {
  try {
    const meta = await sharp(absPath).metadata();
    const isLargeDim = (meta.width && meta.width > 1600) || (meta.height && meta.height > 1600);
    const stat = fs.statSync(absPath);
    const isLargeSize = stat.size > 1.5 * 1024 * 1024;

    if (!isLargeDim && !isLargeSize) {
      return absPath;
    }

    const optPath = absPath.replace(/(\.[\w]+)$/, "-gemini-opt.png");
    await sharp(absPath)
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 8 })
      .toFile(optPath);
    return optPath;
  } catch (err) {
    console.warn("[mockupCreator] Optimization fallback to original:", err.message);
    return absPath;
  }
}

/**
 * Persists uploaded multer asset files into /library and prepares optimized Gemini upload paths.
 */
async function persistAndOptimizeAssets(files, prefix) {
  const storedList = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!f || !f.path) continue;
    const ext = path.extname(f.originalname || f.path || ".png") || ".png";
    const stored = storeInLibrary(f.path, `${uuidv4()}-${prefix}-${i}${ext}`);
    removeFileSafe(f.path);
    const optPath = await optimizeReferenceForGemini(stored.abs);
    storedList.push({
      stored,
      optPath,
      originalName: f.originalname || `${prefix}-${i + 1}${ext}`,
    });
  }
  return storedList;
}

/**
 * Cleans up temporary Gemini-optimized derivatives while keeping library originals intact.
 */
function cleanupOptimizedAssets(storedGarments, storedArtworks) {
  for (const list of [storedGarments, storedArtworks]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item?.optPath && item.optPath !== item.stored?.abs) {
        removeFileSafe(item.optPath);
      }
    }
  }
}

/**
 * Enforces target aspect ratio, stores completed mockup image into /library, and records DB entry.
 */
async function finalizeGeneratedMockup({ buffer, taskIndex, task, account, durationMs, totalDurationMs, retried }) {
  const finalBuffer = await formatImageToAspectRatio(buffer, task.aspectRatio);
  const out = storeInLibrary(finalBuffer, `${uuidv4()}.png`);

  const labelParts = [task.productType || "Mockup"];
  if (task.artworkName) {
    const cleanArt = String(task.artworkName).replace(/\.[^/.]+$/, "");
    if (cleanArt) labelParts.push(cleanArt);
  }
  if (task.garmentColor) labelParts.push(task.garmentColor);
  if (task.scenePrompt) labelParts.push(task.scenePrompt.slice(0, 40));

  const mockup = insertMockup({
    id: uuidv4(),
    feature: "mockups",
    source_image_path: task.sourceRel,
    style_image_path: task.garmentRel,
    output_image_path: out.rel,
    prompt_used: task.prompt,
    user_input: labelParts.join(" · "),
  });

  const elapsed = retried ? (totalDurationMs || durationMs) : durationMs;
  return {
    ...mockup,
    feature: "mockups",
    isMockup: true,
    source_image_path: task.sourceRel,
    style_image_path: task.garmentRel,
    artwork_name: task.artworkName || null,
    artworkIndex: task.artworkIndex,
    account_id: account?.id || null,
    account_email: account?.email || null,
    slotIndex: taskIndex,
    generation_time: formatDuration(elapsed),
    generation_time_ms: elapsed,
  };
}

// POST /api/generate/mockup-creator
// multipart: garment (file(s), required), artwork (file(s), optional batch), productType, garmentColor, scenePrompt, variationsPerGarment/count, aspectRatio
router.post("/mockup-creator", upload.any(), async (req, res) => {
  const uploadedFiles = Array.isArray(req.files) ? req.files : [];

  // Separate artwork files from garment reference files
  const artworkFiles = [];
  const garmentFiles = [];

  for (const f of uploadedFiles) {
    const field = (f.fieldname || "").toLowerCase();
    if (field.startsWith("artwork") || field === "design" || field === "art") {
      artworkFiles.push(f);
    } else {
      garmentFiles.push(f);
    }
  }

  try {
    if (garmentFiles.length === 0) {
      for (const af of artworkFiles) removeFileSafe(af.path);
      return res.status(400).json({ error: "At least one apparel or mockup reference image is required." });
    }

    if (!hasReadyAccount()) {
      for (const f of uploadedFiles) removeFileSafe(f.path);
      return res.status(503).json({ error: "No Gemini account is ready — open the Accounts tab and sign in." });
    }

    const storedGarments = await persistAndOptimizeAssets(garmentFiles, "mockup-garment");
    const storedArtworks = await persistAndOptimizeAssets(artworkFiles, "mockup-artwork");

    const productType = String(req.body.productType || req.body.product || "Unisex T-Shirt").trim();
    const rawColor = String(req.body.garmentColor || req.body.color || "").trim();
    const garmentColor = rawColor === "transparent" ? "" : rawColor;
    const scenePrompt = String(req.body.scenePrompt || req.body.scene || "").trim();
    const aspectRatio = String(req.body.aspectRatio || req.body.aspect_ratio || "1:1").trim();

    // Variations per (garment, artwork) combo
    const vPerCombo = Math.min(20, Math.max(1, parseInt(req.body.variationsPerGarment || req.body.count || 1, 10) || 1));

    // Build tasks across all garments, artworks, and variations
    const tasks = [];
    let globalTaskIdx = 0;
    const artworkLoopCount = Math.max(1, storedArtworks.length);

    for (let g = 0; g < storedGarments.length; g++) {
      const currentGarment = storedGarments[g];
      for (let a = 0; a < artworkLoopCount; a++) {
        const currentArtwork = storedArtworks[a] || null;
        const imagePaths = currentArtwork
          ? [currentGarment.optPath, currentArtwork.optPath]
          : [currentGarment.optPath];

        for (let v = 0; v < vPerCombo; v++) {
          tasks.push({
            prompt: buildPrompt({
              hasArtwork: Boolean(currentArtwork),
              productType,
              garmentColor,
              sceneDirection: scenePrompt,
              aspectRatio,
              variant: v,
            }),
            imagePaths,
            productType,
            garmentColor,
            scenePrompt,
            aspectRatio,
            variantIndex: v,
            garmentIndex: g,
            totalGarments: storedGarments.length,
            artworkIndex: a,
            totalArtworks: storedArtworks.length,
            artworkName: currentArtwork ? currentArtwork.originalName : null,
            sourceRel: currentArtwork ? currentArtwork.stored.rel : currentGarment.stored.rel,
            garmentRel: currentGarment.stored.rel,
            artworkRel: currentArtwork ? currentArtwork.stored.rel : null,
            slotIndex: globalTaskIdx++,
          });
        }
      }
    }

    const wantsStream =
      req.headers.accept?.includes("application/x-ndjson") || req.query.stream === "true";

    const routeAbort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        routeAbort.abort();
      }
    });

    if (wantsStream) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const heartbeatInterval = setInterval(() => {
        if (!res.writableEnded) {
          try {
            res.write(JSON.stringify({ event: "heartbeat" }) + "\n");
          } catch (_) {}
        }
      }, 15000);

      let streamedCount = 0;
      try {
        await runFleetBatch(
          tasks,
          async ({ buffer, taskIndex, task, account, durationMs, totalDurationMs, retried }) => {
            if (routeAbort.signal.aborted) return null;
            const decorated = await finalizeGeneratedMockup({
              buffer, taskIndex, task, account, durationMs, totalDurationMs, retried,
            });
            streamedCount++;
            res.write(JSON.stringify({ event: "design", slotIndex: taskIndex, design: decorated }) + "\n");
            return decorated;
          },
          {
            signal: routeAbort.signal,
            onItemRetry: ({ taskIndex, attempt }) => {
              if (wantsStream && !res.writableEnded) {
                try {
                  res.write(JSON.stringify({ event: "slot_retrying", slotIndex: taskIndex, attempt }) + "\n");
                } catch (_) {}
              }
            },
            onItemError: async ({ taskIndex, error }) => {
              if (wantsStream && !res.writableEnded) {
                try {
                  res.write(JSON.stringify({ event: "slot_failed", slotIndex: taskIndex, error: error.message || "Mockup generation failed" }) + "\n");
                } catch (_) {}
              }
            }
          }
        );

        if (streamedCount === 0) {
          res.write(
            JSON.stringify({
              event: "error",
              error: "No mockup image generated by Gemini (possible safety refusal or timeout).",
            }) + "\n"
          );
        }
        res.write(JSON.stringify({ event: "done", count: streamedCount }) + "\n");
      } finally {
        clearInterval(heartbeatInterval);
        cleanupOptimizedAssets(storedGarments, storedArtworks);
      }
      res.end();
    } else {
      // Non-streaming fallback
      const savedDesigns = new Array(tasks.length);
      try {
        await runFleetBatch(
          tasks,
          async ({ buffer, taskIndex, task, account, durationMs, totalDurationMs, retried }) => {
            if (routeAbort.signal.aborted) return null;
            const decorated = await finalizeGeneratedMockup({
              buffer, taskIndex, task, account, durationMs, totalDurationMs, retried,
            });
            savedDesigns[taskIndex] = decorated;
            return decorated;
          },
          { signal: routeAbort.signal }
        );
      } finally {
        cleanupOptimizedAssets(storedGarments, storedArtworks);
      }

      res.json({
        success: true,
        count: savedDesigns.filter(Boolean).length,
        designs: savedDesigns.filter(Boolean),
      });
    }
  } catch (err) {
    console.error("[mockupCreator] Top-level route failure:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || "Mockup generation failed" });
    }
  }
});

export default router;
