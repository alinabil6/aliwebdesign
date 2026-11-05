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

// POST /api/generate/mockup-creator
// multipart: garment (file(s), required), artwork (file, optional), productType, garmentColor, scenePrompt, variationsPerGarment/count, aspectRatio
router.post("/mockup-creator", upload.any(), async (req, res) => {
  const uploadedFiles = Array.isArray(req.files) ? req.files : [];

  // Separate artwork file from garment files
  let artworkFile = null;
  const garmentFiles = [];

  for (const f of uploadedFiles) {
    const field = (f.fieldname || "").toLowerCase();
    if (field.startsWith("artwork") || field === "design" || field === "art") {
      if (!artworkFile) artworkFile = f;
      else removeFileSafe(f.path);
    } else {
      garmentFiles.push(f);
    }
  }

  try {
    if (garmentFiles.length === 0) {
      if (artworkFile) removeFileSafe(artworkFile.path);
      return res.status(400).json({ error: "At least one apparel or mockup reference image is required." });
    }

    if (!hasReadyAccount()) {
      for (const f of uploadedFiles) {
        removeFileSafe(f.path);
      }
      return res.status(503).json({ error: "No Gemini account is ready — open the Accounts tab and sign in." });
    }

    // Persist all garment references into /library & optimize for fast Gemini upload
    const storedGarments = [];
    for (let i = 0; i < garmentFiles.length; i++) {
      const gf = garmentFiles[i];
      const garmentExt = path.extname(gf.originalname || gf.path || ".png") || ".png";
      const garmentStored = storeInLibrary(gf.path, `${uuidv4()}-mockup-garment-${i}${garmentExt}`);
      removeFileSafe(gf.path);
      const garmentOptPath = await optimizeReferenceForGemini(garmentStored.abs);
      storedGarments.push({ stored: garmentStored, optPath: garmentOptPath });
    }

    // Persist artwork (if supplied) into /library & optimize
    let artworkStored = null;
    let artworkOptPath = null;
    if (artworkFile && artworkFile.path) {
      const artExt = path.extname(artworkFile.originalname || artworkFile.path || ".png") || ".png";
      artworkStored = storeInLibrary(artworkFile.path, `${uuidv4()}-mockup-artwork${artExt}`);
      removeFileSafe(artworkFile.path);
      artworkOptPath = await optimizeReferenceForGemini(artworkStored.abs);
    }

    const productType = String(req.body.productType || req.body.product || "Unisex T-Shirt").trim();
    const rawColor = String(req.body.garmentColor || req.body.color || "").trim();
    const garmentColor = rawColor === "transparent" ? "" : rawColor;
    const scenePrompt = String(req.body.scenePrompt || req.body.scene || "").trim();
    const aspectRatio = String(req.body.aspectRatio || req.body.aspect_ratio || "1:1").trim();

    // Variations per garment
    const vPerGarment = Math.min(20, Math.max(1, parseInt(req.body.variationsPerGarment || req.body.count || 1, 10) || 1));

    // Build tasks across all garments and variations
    const tasks = [];
    let globalTaskIdx = 0;
    for (let g = 0; g < storedGarments.length; g++) {
      const currentGarment = storedGarments[g];
      const imagePaths = artworkOptPath
        ? [currentGarment.optPath, artworkOptPath]
        : [currentGarment.optPath];

      for (let v = 0; v < vPerGarment; v++) {
        tasks.push({
          prompt: buildPrompt({
            hasArtwork: Boolean(artworkStored),
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
          sourceRel: artworkStored ? artworkStored.rel : currentGarment.stored.rel,
          garmentRel: currentGarment.stored.rel,
          artworkRel: artworkStored ? artworkStored.rel : null,
          slotIndex: globalTaskIdx++,
        });
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
            const finalBuffer = await formatImageToAspectRatio(buffer, task.aspectRatio);
            const out = storeInLibrary(finalBuffer, `${uuidv4()}.png`);

            const labelParts = [task.productType || "Mockup"];
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

            const decorated = {
              ...mockup, feature: "mockups", isMockup: true,
              source_image_path: task.sourceRel,
              style_image_path: task.garmentRel,
              account_id: account?.id || null,
              account_email: account?.email || null,
              slotIndex: taskIndex,
              generation_time: formatDuration(retried ? (totalDurationMs || durationMs) : durationMs),
              generation_time_ms: retried ? (totalDurationMs || durationMs) : durationMs,
            };

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
        for (const item of storedGarments) {
          if (item.optPath && item.optPath !== item.stored.abs) removeFileSafe(item.optPath);
        }
        if (artworkOptPath && artworkStored && artworkOptPath !== artworkStored.abs) removeFileSafe(artworkOptPath);
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
            const finalBuffer = await formatImageToAspectRatio(buffer, task.aspectRatio);
            const out = storeInLibrary(finalBuffer, `${uuidv4()}.png`);

            const labelParts = [task.productType || "Mockup"];
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

            const decorated = {
              ...mockup, feature: "mockups", isMockup: true,
              source_image_path: task.sourceRel,
              style_image_path: task.garmentRel,
              account_id: account?.id || null,
              account_email: account?.email || null,
              slotIndex: taskIndex,
              generation_time: formatDuration(retried ? (totalDurationMs || durationMs) : durationMs),
              generation_time_ms: retried ? (totalDurationMs || durationMs) : durationMs,
            };

            savedDesigns[taskIndex] = decorated;
            return decorated;
          },
          { signal: routeAbort.signal }
        );
      } finally {
        for (const item of storedGarments) {
          if (item.optPath && item.optPath !== item.stored.abs) removeFileSafe(item.optPath);
        }
        if (artworkOptPath && artworkStored && artworkOptPath !== artworkStored.abs) removeFileSafe(artworkOptPath);
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
