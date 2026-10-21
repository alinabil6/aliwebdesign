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
// multipart: prompt (text), prompts (JSON array of strings or prompt profile objects), count (1–100), manualStyle (optional)
router.post("/text-to-image", form, async (req, res) => {
  try {
    // Parse prompts: support array of prompt objects OR array of strings
    // via req.body.prompts (JSON or array), or single prompt via req.body.prompt.
    let rawPrompts = [];
    if (req.body.prompts) {
      try {
        const parsed = typeof req.body.prompts === "string" ? JSON.parse(req.body.prompts) : req.body.prompts;
        if (Array.isArray(parsed)) {
          rawPrompts = parsed;
        }
      } catch (_) {
        if (typeof req.body.prompts === "string") {
          rawPrompts = [req.body.prompts.trim()].filter(Boolean);
        }
      }
    }
    if (rawPrompts.length === 0) {
      const single = String(req.body.prompt || "").trim();
      if (single) {
        rawPrompts = [single];
      }
    }

    const defaultGlobalCount = Math.min(100, Math.max(1, parseInt(req.body.count, 10) || 1));
    const defaultGlobalStyle = resolveStyle(req);
    const defaultGlobalBg = req.body.bg_color || req.body.background_color || "";
    const defaultGlobalRatio = String(req.body.aspectRatio || req.body.aspect_ratio || "1:1").trim();

    const normalizedPrompts = [];
    for (const item of rawPrompts) {
      if (typeof item === "string") {
        const text = item.trim();
        if (text) {
          normalizedPrompts.push({
            prompt: text,
            aspectRatio: defaultGlobalRatio,
            count: defaultGlobalCount,
            bgColor: defaultGlobalBg,
            style: defaultGlobalStyle,
            styleId: defaultGlobalStyle.style_id,
          });
        }
      } else if (item && typeof item === "object") {
        const text = String(item.prompt || item.text || "").trim();
        if (text) {
          const itemRatio = String(item.aspectRatio || item.aspect_ratio || defaultGlobalRatio).trim();
          const itemCount = Math.min(100, Math.max(1, parseInt(item.count || item.variations, 10) || defaultGlobalCount));
          const itemBg = item.bg_color !== undefined ? item.bg_color : (item.bgColor !== undefined ? item.bgColor : defaultGlobalBg);

          // Resolve per-prompt style
          let itemStyle = defaultGlobalStyle;
          if (item.manualStyle || item.style_directive || item.style_name || item.style_id || item.magicStyle) {
            const manualStyle = String(item.manualStyle || "").trim();
            const magicStyle = item.magicStyle || {};
            const styleDirective = String(item.style_directive || magicStyle.directive || "").trim();
            const styleName = String(item.style_name || magicStyle.name || "").trim() || null;
            const styleId = String(item.style_id || magicStyle.id || "").trim() || null;
            itemStyle = resolveStyle({
              body: { manualStyle, style_directive: styleDirective, style_name: styleName, style_id: styleId },
            });
          }

          normalizedPrompts.push({
            prompt: text,
            aspectRatio: itemRatio,
            count: itemCount,
            bgColor: itemBg,
            style: itemStyle,
            styleId: itemStyle.style_id,
          });
        }
      }
    }

    if (normalizedPrompts.length === 0) {
      return res.status(400).json({ error: "prompt is required" });
    }

    if (!hasReadyAccount()) {
      return res.status(503).json({ error: "No Gemini account is ready — open the Accounts tab and sign in" });
    }

    // One task per prompt & variation; runFleetBatch fans them out across the ENTIRE
    // ready fleet in parallel — each account runs its own profile browser concurrently.
    const tasks = [];
    for (let pIdx = 0; pIdx < normalizedPrompts.length; pIdx++) {
      const pProfile = normalizedPrompts[pIdx];
      for (let v = 0; v < pProfile.count; v++) {
        tasks.push({
          originalPrompt: pProfile.prompt,
          promptIndex: pIdx,
          variantIndex: v,
          prompt: buildPrompt({
            prompt: pProfile.prompt,
            variant: v,
            style_directive: pProfile.style.style_directive,
            style_name: pProfile.style.style_name,
            bg_color: pProfile.bgColor,
            aspectRatio: pProfile.aspectRatio,
          }),
          imagePaths: [],
          aspectRatio: pProfile.aspectRatio,
          bgColor: pProfile.bgColor,
          styleId: pProfile.styleId,
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
            const promptLabel = task.originalPrompt || normalizedPrompts[0]?.prompt || "Design";
            const effectiveStyleId = task.styleId;
            const design = insertDesign({
              id: uuidv4(),
              feature: "text-to-image",
              output_image_path: out.rel,
              prompt_used: task.prompt,
              user_input: effectiveStyleId ? `${promptLabel} [style:${effectiveStyleId}]` : promptLabel,
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
          const promptLabel = task.originalPrompt || normalizedPrompts[0]?.prompt || "Design";
          const effectiveStyleId = task.styleId;
          const design = insertDesign({
            id: uuidv4(),
            feature: "text-to-image",
            output_image_path: out.rel,
            prompt_used: task.prompt,
            user_input: effectiveStyleId ? `${promptLabel} [style:${effectiveStyleId}]` : promptLabel,
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
