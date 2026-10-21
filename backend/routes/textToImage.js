import { Router } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { storeInLibrary } from "../lib/files.js";
import { insertDesign } from "../lib/db.js";
import { hasReadyAccount } from "../lib/accounts.js";
import { runFleetBatch } from "../lib/queue.js";
import { buildPrompt } from "../prompts/textToImage.js";
import { resolveStyle } from "../lib/styleResolver.js";
import { formatImageToAspectRatio } from "../lib/aspectRatioEnforcer.js";

const router = Router();
// multipart form fields only — no file uploads on this endpoint.
const form = multer().none();

// POST /api/generate/text-to-image
// multipart: prompt (text), prompts (JSON array of strings), count (1–100), manualStyle (optional)
router.post("/text-to-image", form, async (req, res) => {
  try {
    // Parse prompts: support array of prompts via req.body.prompts (JSON or array)
    // or single prompt via req.body.prompt for backward compatibility.
    let promptsList = [];
    if (req.body.prompts) {
      try {
        const parsed = typeof req.body.prompts === "string" ? JSON.parse(req.body.prompts) : req.body.prompts;
        if (Array.isArray(parsed)) {
          promptsList = parsed.map((p) => String(p || "").trim()).filter(Boolean);
        }
      } catch (_) {
        if (typeof req.body.prompts === "string") {
          promptsList = [req.body.prompts.trim()].filter(Boolean);
        }
      }
    }
    if (promptsList.length === 0) {
      const single = String(req.body.prompt || "").trim();
      if (single) {
        promptsList = [single];
      }
    }

    if (promptsList.length === 0) {
      return res.status(400).json({ error: "prompt is required" });
    }
    const count = Math.min(100, Math.max(1, parseInt(req.body.count, 10) || 1));
    const style = resolveStyle(req);
    const styleId = style.style_id;
    const bg_color = req.body.bg_color || req.body.background_color || "";
    const aspectRatio = String(req.body.aspectRatio || req.body.aspect_ratio || "1:1").trim();

    if (!hasReadyAccount()) {
      return res.status(503).json({ error: "No Gemini account is ready — open the Accounts tab and sign in" });
    }

    // One task per prompt & variation; runFleetBatch fans them out across the ENTIRE
    // ready fleet in parallel — each account runs its own profile browser concurrently.
    const tasks = [];
    for (let pIdx = 0; pIdx < promptsList.length; pIdx++) {
      const pText = promptsList[pIdx];
      for (let v = 0; v < count; v++) {
        tasks.push({
          originalPrompt: pText,
          promptIndex: pIdx,
          variantIndex: v,
          prompt: buildPrompt({
            prompt: pText,
            variant: v,
            style_directive: style.style_directive,
            style_name: style.style_name,
            bg_color,
            aspectRatio,
          }),
          imagePaths: [],
          aspectRatio,
          bgColor: bg_color,
        });
      }
    }

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
          async ({ buffer, taskIndex, task, account }) => {
            if (routeAbort.signal.aborted) return null;
            const finalBuffer = await formatImageToAspectRatio(buffer, task.aspectRatio, { bg_color: task.bgColor });
            const out = storeInLibrary(finalBuffer, `${uuidv4()}.png`);
            const promptLabel = task.originalPrompt || promptsList[0];
            const design = insertDesign({
              id: uuidv4(),
              feature: "text-to-image",
              output_image_path: out.rel,
              prompt_used: task.prompt,
              user_input: styleId ? `${promptLabel} [style:${styleId}]` : promptLabel,
            });
            const decorated = {
              ...design,
              account_id: account?.id || null,
              account_email: account?.email || null,
              prompt_index: task.promptIndex,
              variant_index: task.variantIndex,
            };
            streamedCount++;
            // STREAM CHUNK IMMEDIATELY TO CLIENT
            res.write(JSON.stringify({ event: "design", slotIndex: taskIndex, design: decorated }) + "\n");
            return decorated;
          },
          {
            signal: routeAbort.signal,
            onItemError: async ({ taskIndex, error }) => {
              if (wantsStream && !res.writableEnded) {
                try {
                  res.write(JSON.stringify({ event: "slot_failed", slotIndex: taskIndex, error: error.message || "Generation failed" }) + "\n");
                } catch (_) {}
              }
            }
          }
        );

        if (streamedCount === 0) {
          console.warn(
            `[TextToImage] No slot returned an image buffer. Gemini may have generated a text-only refusal or the generation timed out.`
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
        async ({ buffer, taskIndex, task, account }) => {
          if (routeAbort.signal.aborted) return null;
          const finalBuffer = await formatImageToAspectRatio(buffer, task.aspectRatio, { bg_color: task.bgColor });
          const out = storeInLibrary(finalBuffer, `${uuidv4()}.png`);
          const promptLabel = task.originalPrompt || promptsList[0];
          const design = insertDesign({
            id: uuidv4(),
            feature: "text-to-image",
            output_image_path: out.rel,
            prompt_used: task.prompt,
            user_input: styleId ? `${promptLabel} [style:${styleId}]` : promptLabel,
          });
          const decorated = {
            ...design,
            account_id: account?.id || null,
            account_email: account?.email || null,
            prompt_index: task.promptIndex,
            variant_index: task.variantIndex,
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
      res.json({ success: true, designs });
    }
  } catch (err) {
    console.error("text-to-image failed:", err);
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
