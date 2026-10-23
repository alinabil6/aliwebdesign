import { normalizeBgColor } from "../lib/backgroundEnforcer.js";
import { Router } from "express";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { upload, storeInLibrary, removeFileSafe } from "../lib/files.js";
import { insertDesign } from "../lib/db.js";
import { hasReadyAccount } from "../lib/accounts.js";
import { runFleetBatch } from "../lib/queue.js";
import { buildPrompt } from "../prompts/nicheVariations.js";
import { resolveStyle } from "../lib/styleResolver.js";
import { formatImageToAspectRatio } from "../lib/aspectRatioEnforcer.js";

const router = Router();

function formatDuration(ms) {
  const totalSec = Math.max(1, Math.round((ms || 0) / 1000));
  const mins = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const secs = String(totalSec % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

/**
 * Split user niche ideas into distinct targets by comma, newline, or semicolon.
 * Example: "usa, spain, canada, haiti" -> ["USA", "Spain", "Canada", "Haiti"]
 */
function parseNicheList(rawText) {
  if (!rawText) return [];
  return rawText
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// POST /api/generate/niche-variations
// multipart: source (image), niche (text), count (1–100), manualStyle (optional)
router.post("/niche-variations", upload.single("source"), async (req, res) => {
  const file = req.file;
  try {
    if (!file) {
      return res.status(400).json({ error: "A source design image is required" });
    }
    const rawNiche = String(req.body.niche || "").trim();
    if (!rawNiche) {
      removeFileSafe(file.path);
      return res.status(400).json({ error: "niche ideas are required" });
    }

    const parsedNiches = parseNicheList(rawNiche);
    const count = Math.min(100, Math.max(1, parseInt(req.body.count, 10) || 1));

    if (!hasReadyAccount()) {
      removeFileSafe(file.path);
      return res.status(503).json({ error: "No Gemini account is ready — open the Accounts tab and sign in" });
    }

    const source = storeInLibrary(file.path, `${uuidv4()}-source${path.extname(file.path)}`);
    removeFileSafe(file.path);

    const style = resolveStyle(req);
    const styleId = style.style_id;
    const bg_color = normalizeBgColor(req.body.bg_color || req.body.bgColor);
    const aspectRatio = String(req.body.aspectRatio || req.body.aspect_ratio || "1:1").trim();

    // Build targeted task per variation slot with its own specific niche
    const tasks = Array.from({ length: count }, (_, v) => {
      const targetNiche = parsedNiches.length > 0
        ? parsedNiches[v % parsedNiches.length]
        : rawNiche;

      return {
        targetNiche,
        prompt: buildPrompt({
          bg_color,
          target_niche: targetNiche,
          variant: v,
          style_directive: style.style_directive,
          style_name: style.style_name,
          aspectRatio,
        }),
        imagePaths: [source.abs],
        aspectRatio,
        bgColor: bg_color,
      };
    });

    const savedDesigns = new Array(tasks.length);

    // Streaming (NDJSON) vs classic JSON response. The client requests
    // streaming via the Accept header or ?stream=true; each finished design
    // is flushed down the open connection the moment its buffer is saved.
    const wantsStream =
      req.headers.accept?.includes("application/x-ndjson") || req.query.stream === "true";

    // Abort on client disconnect (Stop button severs the HTTP connection) —
    // the fleet batch races its generations against this signal so nothing
    // keeps running (and no disk/DB writes happen) after the user cancels.
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
          async ({ buffer, taskIndex, task, account, durationMs, totalDurationMs, retried }) => {
            if (routeAbort.signal.aborted) return null;
            const finalBuffer = await formatImageToAspectRatio(buffer, task.aspectRatio, { bg_color: task.bgColor });
            const out = storeInLibrary(finalBuffer, `${uuidv4()}.png`);
            const design = insertDesign({
              id: uuidv4(),
              feature: "niche-variations",
              source_image_path: source.rel,
              output_image_path: out.rel,
              prompt_used: task.prompt,
              user_input: styleId ? `${task.targetNiche} [style:${styleId}]` : task.targetNiche,
            });
            const decorated = {
              ...design,
              account_id: account?.id || null,
              account_email: account?.email || null,
              generation_time: formatDuration(retried ? (totalDurationMs || durationMs) : durationMs),
              generation_time_ms: retried ? (totalDurationMs || durationMs) : durationMs,
            };
            streamedCount++;
            // STREAM CHUNK IMMEDIATELY TO CLIENT
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
                  res.write(JSON.stringify({ event: "slot_failed", slotIndex: taskIndex, error: error.message || "Generation failed" }) + String.fromCharCode(10));
                } catch (_) {}
              }
            }
          }
        );

        if (streamedCount === 0 && !routeAbort.signal.aborted) {
          if (!res.writableEnded) {
            res.write(
              JSON.stringify({
                event: "error",
                error: "No image generated by Gemini for this design (possible safety refusal or timeout).",
              }) + "\n"
            );
          }
        }
        if (!res.writableEnded) {
          res.write(JSON.stringify({ event: "done", count: streamedCount }) + "\n");
        }
      } finally {
        clearInterval(heartbeatInterval);
      }
      if (!res.writableEnded) {
        res.end();
      }
    } else {
      await runFleetBatch(
        tasks,
        async ({ buffer, taskIndex, task, account, durationMs, totalDurationMs, retried }) => {
          if (routeAbort.signal.aborted) return null;
          const finalBuffer = await formatImageToAspectRatio(buffer, task.aspectRatio, { bg_color: task.bgColor });
          const out = storeInLibrary(finalBuffer, `${uuidv4()}.png`);
          const design = insertDesign({
            id: uuidv4(),
            feature: "niche-variations",
            source_image_path: source.rel,
            output_image_path: out.rel,
            prompt_used: task.prompt,
            user_input: styleId ? `${task.targetNiche} [style:${styleId}]` : task.targetNiche,
          });
          const decorated = {
            ...design,
            account_id: account?.id || null,
            account_email: account?.email || null,
            generation_time: formatDuration(retried ? (totalDurationMs || durationMs) : durationMs),
            generation_time_ms: retried ? (totalDurationMs || durationMs) : durationMs,
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
    removeFileSafe(file?.path);
    console.error("niche-variations failed:", err);
    if (res.headersSent) {
      // Headers already flushed (streaming) — emit an error event instead.
      try {
        res.write(JSON.stringify({ event: "error", error: err.message || "Generation failed" }) + "\n");
        res.end();
      } catch (_) { /* connection already closed */ }
    } else {
      res.status(500).json({ error: "Generation failed" });
    }
  }
});

export default router;