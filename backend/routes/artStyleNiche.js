import { Router } from "express";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { upload, storeInLibrary, removeFileSafe } from "../lib/files.js";
import { insertDesign } from "../lib/db.js";
import { hasReadyAccount } from "../lib/accounts.js";
import { runFleetBatch } from "../lib/queue.js";
import { buildPrompt } from "../prompts/artStyleNiche.js";
import { formatImageToAspectRatio } from "../lib/aspectRatioEnforcer.js";

const router = Router();

function formatDuration(ms) {
  const totalSec = Math.max(1, Math.round((ms || 0) / 1000));
  const mins = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const secs = String(totalSec % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

// POST /api/generate/art-style-niche
// Accepts up to 10 style references for moodboard fusion + 1 niche subject reference
router.post(
  "/art-style-niche",
  upload.fields([
    { name: "style", maxCount: 20 },
    { name: "niche", maxCount: 10 },
  ]),
  async (req, res) => {
    const files = req.files || {};
    const styleFiles = files.style || [];
    const nicheFile = files.niche?.[0];

    try {
      if (styleFiles.length === 0 || !nicheFile) {
        styleFiles.forEach((f) => removeFileSafe(f.path));
        removeFileSafe(nicheFile?.path);
        return res
          .status(400)
          .json({ error: "Both a style reference and a niche/subject reference are required" });
      }

      if (!hasReadyAccount()) {
        styleFiles.forEach((f) => removeFileSafe(f.path));
        removeFileSafe(nicheFile.path);
        return res
          .status(503)
          .json({ error: "No Gemini account is ready — open the Accounts tab and sign in" });
      }

      // Persist niche & style references into /library
      const niche = storeInLibrary(nicheFile.path, `${uuidv4()}-niche${path.extname(nicheFile.path)}`);
      removeFileSafe(nicheFile.path);

      const styles = styleFiles.map((f) => {
        const s = storeInLibrary(f.path, `${uuidv4()}-style${path.extname(f.path)}`);
        removeFileSafe(f.path);
        return s;
      });

      const primaryStyle = styles[0];
      const count = Math.min(100, Math.max(1, parseInt(req.body.count, 10) || 1));
      const bg_color = req.body.bg_color || req.body.background_color || "";
      const aspectRatio = String(req.body.aspectRatio || req.body.aspect_ratio || "1:1").trim();

      // Niche Reference (Core Subject) is ALWAYS the first element (Image 1), followed by the Style Reference(s)
      const allImagePaths = [niche.abs, ...styles.map((s) => s.abs)];
      const tasks = Array.from({ length: count }, (_, v) => ({
        prompt: buildPrompt({ variant: v, bg_color, styleCount: styles.length, aspectRatio }),
        imagePaths: allImagePaths,
        aspectRatio,
        bgColor: bg_color,
      }));

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

        // Keep-alive heartbeat every 15s to prevent socket drops during long 100-design batches
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
            async ({ buffer, taskIndex, task, account, durationMs }) => {
              if (routeAbort.signal.aborted) return null;
              const finalBuffer = await formatImageToAspectRatio(buffer, task.aspectRatio, { bg_color: task.bgColor });
              const out = storeInLibrary(finalBuffer, `${uuidv4()}.png`);
              const design = insertDesign({
                id: uuidv4(),
                feature: "art-style-niche",
                source_image_path: niche.rel,
                style_image_path: primaryStyle.rel,
                output_image_path: out.rel,
                prompt_used: task.prompt,
              });
              const decorated = {
                ...design,
                account_id: account?.id || null,
                account_email: account?.email || null,
                generation_time: formatDuration(durationMs),
                generation_time_ms: durationMs,
              };
              streamedCount++;
              res.write(
                JSON.stringify({ event: "design", slotIndex: taskIndex, design: decorated }) + "\n"
              );
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
                    res.write(
                      JSON.stringify({
                        event: "slot_failed",
                        slotIndex: taskIndex,
                        error: error.message || "Generation failed",
                      }) + "\n"
                    );
                  } catch (_) {}
                }
              },
            }
          );

          if (streamedCount === 0) {
            console.warn(
              "[ArtStyleNiche] No slot returned an image buffer (possible safety refusal or timeout)."
            );
            res.write(
              JSON.stringify({
                event: "error",
                error: "No image generated by Gemini for this design (possible safety refusal or timeout).",
              }) + "\n"
            );
          }
          res.write(JSON.stringify({ event: "done", count: streamedCount }) + "\n");
        } finally {
          clearInterval(heartbeatInterval);
        }
        res.end();
      } else {
        const savedDesigns = new Array(tasks.length);
        await runFleetBatch(
          tasks,
          async ({ buffer, taskIndex, task, account, durationMs }) => {
            if (routeAbort.signal.aborted) return null;
            const finalBuffer = await formatImageToAspectRatio(buffer, task.aspectRatio, { bg_color: task.bgColor });
            const out = storeInLibrary(finalBuffer, `${uuidv4()}.png`);
            const design = insertDesign({
              id: uuidv4(),
              feature: "art-style-niche",
              source_image_path: niche.rel,
              style_image_path: primaryStyle.rel,
              output_image_path: out.rel,
              prompt_used: task.prompt,
            });
            const decorated = {
              ...design,
              account_id: account?.id || null,
              account_email: account?.email || null,
              generation_time: formatDuration(durationMs),
              generation_time_ms: durationMs,
            };
            savedDesigns[taskIndex] = decorated;
            return decorated;
          },
          { signal: routeAbort.signal }
        );

        const designs = savedDesigns.filter(Boolean);
        if (designs.length === 0) {
          throw new Error("No image generated by Gemini for this design (possible safety refusal or timeout).");
        }
        res.json({ designs });
      }
    } catch (err) {
      if (Array.isArray(files.style)) files.style.forEach((f) => removeFileSafe(f.path));
      removeFileSafe(nicheFile?.path);
      console.error("art-style-niche failed:", err);
      if (res.headersSent) {
        try {
          res.write(JSON.stringify({ event: "error", error: err.message || "Generation failed" }) + "\n");
          res.end();
        } catch (_) {}
      } else {
        res.status(500).json({ error: "Generation failed" });
      }
    }
  }
);

export default router;
