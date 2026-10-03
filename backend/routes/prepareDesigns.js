import { Router } from "express";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";
import { upload, storeInLibrary, removeFileSafe } from "../lib/files.js";
import { insertDesign } from "../lib/db.js";

const router = Router();

// POST /api/prepare-designs
router.post("/", upload.array("sources", 100), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: "No design files provided" });
  }

  const placement = String(req.body.placement || "top").toLowerCase(); // "top" or "centred"
  const targetWidth = parseInt(req.body.width, 10) || 4500;
  const targetHeight = parseInt(req.body.height, 10) || 5400;
  const targetDpi = parseInt(req.body.dpi, 10) || 300;

  const processedDesigns = [];

  try {
    for (const file of files) {
      try {
        // 1. Trim transparent borders to measure real graphic bounds
        let trimmedBuffer;
        try {
          trimmedBuffer = await sharp(file.path).trim().toBuffer();
        } catch {
          trimmedBuffer = await sharp(file.path).toBuffer();
        }

        const trimmedMeta = await sharp(trimmedBuffer).metadata();
        const srcW = trimmedMeta.width || 1000;
        const srcH = trimmedMeta.height || 1000;

        // 2. Extend graphic to edge with only 10px margin
        const edgeMargin = 10;
        const maxContentW = targetWidth - (edgeMargin * 2);  // 4480px
        const maxContentH = targetHeight - (edgeMargin * 2); // 5380px

        const scale = Math.min(maxContentW / srcW, maxContentH / srcH);
        const fitWidth = Math.max(1, Math.round(srcW * scale));
        const fitHeight = Math.max(1, Math.round(srcH * scale));

        const resizedGraphic = await sharp(trimmedBuffer)
          .resize(fitWidth, fitHeight, {
            fit: "fill",
            kernel: "lanczos3"
          })
          .toBuffer();

        // 3. Compute coordinates
        const left = Math.round((targetWidth - fitWidth) / 2);
        let top = edgeMargin; // Top placement anchored 10px from top border
        if (placement !== "top") {
          top = Math.round((targetHeight - fitHeight) / 2); // True center
        }

        // 4. Initial composite with standard compression
        let outputBuffer = await sharp({
          create: {
            width: targetWidth,
            height: targetHeight,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          }
        })
          .withMetadata({ density: targetDpi })
          .composite([{ input: resizedGraphic, top, left }])
          .png({
            compressionLevel: 9,
            adaptiveFiltering: true,
            effort: 8
          })
          .toBuffer();

        // 5. Enforce strict < 25MB ceiling (POD & Merch limit)
        const MAX_BYTES = 24.5 * 1024 * 1024; // 24.5 MB threshold
        if (outputBuffer.length > MAX_BYTES) {
          console.log(`Buffer size ${Math.round(outputBuffer.length / 1024 / 1024)}MB exceeds 24.5MB threshold. Optimizing palette...`);
          outputBuffer = await sharp(outputBuffer)
            .png({
              compressionLevel: 9,
              effort: 9,
              palette: true,
              quality: 95
            })
            .toBuffer();
        }

        const out = storeInLibrary(outputBuffer, `${uuidv4()}-4500x5400.png`);
        const sourceStored = storeInLibrary(file.path, `${uuidv4()}-src${path.extname(file.path)}`);

        const designRecord = insertDesign({
          id: uuidv4(),
          feature: "prepare-designs",
          source_image_path: sourceStored.rel,
          output_image_path: out.rel,
          prompt_used: `Extended Print Canvas: ${targetWidth}x${targetHeight} ${targetDpi}DPI, Placement: ${placement}`,
          user_input: `Placement: ${placement} (Extended, <25MB)`,
        });

        processedDesigns.push(designRecord);
      } catch (innerErr) {
        console.error(`Failed to process ${file.originalname}:`, innerErr);
      } finally {
        removeFileSafe(file.path);
      }
    }

    res.json({ designs: processedDesigns });
  } catch (err) {
    console.error("prepare-designs failed:", err);
    res.status(500).json({ error: "Batch preparation failed" });
  }
});

export default router;